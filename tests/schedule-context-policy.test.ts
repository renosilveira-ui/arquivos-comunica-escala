import { describe, expect, it } from "vitest";
import {
  dedupeAuthorizedScheduleContextsForAgenda,
  describeScheduleContext,
  filterScheduleContextsForActor,
  filterScheduleContextsForRosterRead,
  parseScheduleContextIds,
  pickCanonicalAgendaScheduleContext,
  projectEffectiveScheduleContextIds,
  qualificationMatches,
  requireSingleLegacyScheduleContext,
  resolveShiftScheduleContextReadGrant,
  type ActiveScheduleContext,
  type AuthorizedScheduleContext,
} from "../server/schedule-contexts";

function context(
  id: number,
  sectorId: number,
  medicalSpecialtyId: number | null = 10,
  institutionId = 1,
): ActiveScheduleContext {
  return {
    id,
    institutionId,
    hospitalId: institutionId === 1 ? 100 : 900,
    hospitalName:
      institutionId === 1 ? "Hospital São Carlos" : "Outro hospital",
    sectorId,
    sectorName: `Setor ${sectorId}`,
    medicalSpecialtyId,
    medicalSpecialtyCode:
      medicalSpecialtyId === null ? null : `ESP_${medicalSpecialtyId}`,
    medicalSpecialtyName: medicalSpecialtyId === null ? null : "Anestesiologia",
    operationalProfileCode:
      medicalSpecialtyId === null ? "MEDICO_GENERALISTA" : null,
    admissionPolicy: "PINNED_QUALIFICATION",
    active: true,
  };
}

const userActor = {
  institutionId: 1,
  professionalId: 55,
  roleInInstitution: "USER" as const,
  isGlobalAdmin: false,
};

describe("política canônica de contextos de escala", () => {
  it("descobre Sala de Recuperação por vínculo e ACL exata mesmo sem metadado clínico", () => {
    const recovery: ActiveScheduleContext = {
      ...context(15, 10, null),
      sectorName: "Sala de Recuperação",
      medicalSpecialtyCode: null,
      medicalSpecialtyName: null,
      operationalProfileCode: null,
      admissionPolicy: "QUALIFICATION_ALLOWLIST",
      allowedQualifications: [],
    };

    const result = filterScheduleContextsForActor({
      actor: userActor,
      contexts: [recovery],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 10,
          canAccess: true,
        },
      ],
      managerScopes: [],
    });

    expect(result.map((row) => row.id)).toEqual([15]);
    expect(result[0]?.qualificationName).toBe("Acesso setorial");
  });

  it("direciona USER aos setores A e B autorizados, sem vazar C", () => {
    const result = filterScheduleContextsForActor({
      actor: userActor,
      contexts: [context(1, 101), context(2, 102), context(3, 103)],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 101,
          canAccess: true,
        },
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 102,
          canAccess: true,
        },
      ],
      managerScopes: [],
    });

    expect(result.map((row) => row.id)).toEqual([1, 2]);
    expect(result.every((row) => row.canManage === false)).toBe(true);
    expect(result[0].displayName).toContain("Hospital São Carlos");
  });

  it("panorama Geral mostra todos os setores do tenant sem conceder gestão nem vazar outro tenant", () => {
    const result = filterScheduleContextsForRosterRead({
      actor: userActor,
      contexts: [
        context(1, 101),
        context(2, 102),
        context(3, 103),
        context(9, 901, 10, 2),
      ],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 101,
          canAccess: true,
        },
      ],
      managerScopes: [],
    });

    expect(result.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(result.every((row) => row.canManage === false)).toBe(true);
  });

  it("panorama legível preserva canManage só onde o gestor já podia gerir", () => {
    const result = filterScheduleContextsForRosterRead({
      actor: { ...userActor, roleInInstitution: "GESTOR_MEDICO" },
      contexts: [context(1, 101), context(2, 102), context(3, 103)],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 102,
          canAccess: true,
        },
      ],
      managerScopes: [
        {
          institutionId: 1,
          managerProfessionalId: 55,
          hospitalId: 100,
          sectorId: 101,
          active: true,
        },
      ],
    });

    expect(result.map(({ id, canManage }) => ({ id, canManage }))).toEqual([
      { id: 1, canManage: true },
      { id: 2, canManage: false },
      { id: 3, canManage: false },
    ]);
  });

  it("usa o ID exato da especialidade, nunca o texto exibido", () => {
    const required = context(1, 101, 10);
    const sameNameDifferentId = context(2, 101, 11);

    expect(
      qualificationMatches(
        { medicalSpecialtyId: 10, operationalProfileCode: null },
        required,
      ),
    ).toBe(true);
    expect(
      qualificationMatches(
        { medicalSpecialtyId: 10, operationalProfileCode: null },
        sameNameDifferentId,
      ),
    ).toBe(false);
  });

  it("não mistura generalista com especialista", () => {
    const generalist = context(1, 101, null);
    expect(
      qualificationMatches(
        { medicalSpecialtyId: 10, operationalProfileCode: null },
        generalist,
      ),
    ).toBe(false);
    expect(
      qualificationMatches(
        {
          medicalSpecialtyId: null,
          operationalProfileCode: "MEDICO_GENERALISTA",
        },
        generalist,
      ),
    ).toBe(true);
  });

  it("falha fechado quando profissional tem zero ou duas qualificações", () => {
    const specialist = context(1, 101, 10);
    expect(
      qualificationMatches(
        { medicalSpecialtyId: null, operationalProfileCode: null },
        specialist,
      ),
    ).toBe(false);
    expect(
      qualificationMatches(
        {
          medicalSpecialtyId: 10,
          operationalProfileCode: "MEDICO_GENERALISTA",
        },
        specialist,
      ),
    ).toBe(false);
  });

  it("projeta broad legado e ACL setorial sem confundir TRR com Emergência", () => {
    const contexts = [context(1, 101, null), context(2, 102, null)];
    expect(
      projectEffectiveScheduleContextIds({
        institutionId: 1,
        professionalId: 55,
        contexts,
        accesses: [
          {
            institutionId: 1,
            professionalId: 55,
            hospitalId: 100,
            sectorId: 101,
            canAccess: true,
          },
        ],
      }),
    ).toEqual([1]);
    expect(
      projectEffectiveScheduleContextIds({
        institutionId: 1,
        professionalId: 55,
        contexts,
        accesses: [
          {
            institutionId: 1,
            professionalId: 55,
            hospitalId: 100,
            sectorId: null,
            canAccess: true,
          },
        ],
      }),
    ).toEqual([1, 2]);
  });

  it("valida lista explícita sem coerção, vazio ou duplicidade", () => {
    expect(parseScheduleContextIds(undefined)).toBeUndefined();
    expect(parseScheduleContextIds([2, 3])).toEqual([2, 3]);
    expect(() => parseScheduleContextIds([])).toThrow(/ao menos uma/i);
    expect(() => parseScheduleContextIds([2, 2])).toThrow(/repetidos/i);
    expect(() => parseScheduleContextIds(["2"])).toThrow(/inválido/i);
  });

  it("GESTOR_MEDICO vê somente A e B do manager_scope, não C", () => {
    const result = filterScheduleContextsForActor({
      actor: {
        ...userActor,
        roleInInstitution: "GESTOR_MEDICO",
      },
      contexts: [context(1, 101), context(2, 102), context(3, 103)],
      accesses: [],
      managerScopes: [
        {
          institutionId: 1,
          managerProfessionalId: 55,
          hospitalId: 100,
          sectorId: 101,
          active: true,
        },
        {
          institutionId: 1,
          managerProfessionalId: 55,
          hospitalId: 100,
          sectorId: 102,
          active: true,
        },
      ],
    });

    expect(result.map((row) => row.id)).toEqual([1, 2]);
    expect(result.every((row) => row.canManage)).toBe(true);
  });

  it("GESTOR_MEDICO combina manager_scope A com ACL operacional B sem gerenciar B", () => {
    const result = filterScheduleContextsForActor({
      actor: { ...userActor, roleInInstitution: "GESTOR_MEDICO" },
      contexts: [context(1, 101), context(2, 102), context(3, 103)],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 102,
          canAccess: true,
        },
      ],
      managerScopes: [
        {
          institutionId: 1,
          managerProfessionalId: 55,
          hospitalId: 100,
          sectorId: 101,
          active: true,
        },
      ],
    });

    expect(result.map(({ id, canManage }) => ({ id, canManage }))).toEqual([
      { id: 1, canManage: true },
      { id: 2, canManage: false },
    ]);
  });

  it("leitor separa contexto A de B e abre B somente pela própria alocação", () => {
    const [authorizedA] = filterScheduleContextsForActor({
      actor: userActor,
      contexts: [context(1, 101)],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 101,
          canAccess: true,
        },
      ],
      managerScopes: [],
    });
    const shiftA = {
      id: 501,
      institutionId: 1,
      hospitalId: 100,
      sectorId: 101,
      scheduleContextId: 1,
    };
    const shiftB = {
      id: 502,
      institutionId: 1,
      hospitalId: 100,
      sectorId: 102,
      scheduleContextId: 2,
    };

    expect(
      resolveShiftScheduleContextReadGrant({
        shift: shiftA,
        ownActiveAssignment: false,
        authorizedContexts: [authorizedA],
      })?.kind,
    ).toBe("SCHEDULE_CONTEXT");
    expect(
      resolveShiftScheduleContextReadGrant({
        shift: shiftB,
        ownActiveAssignment: false,
        authorizedContexts: [authorizedA],
      }),
    ).toBeNull();
    expect(
      resolveShiftScheduleContextReadGrant({
        shift: shiftB,
        ownActiveAssignment: true,
        authorizedContexts: [authorizedA],
      })?.kind,
    ).toBe("OWN_ASSIGNMENT");
    expect(
      resolveShiftScheduleContextReadGrant({
        shift: { ...shiftB, scheduleContextId: null },
        ownActiveAssignment: false,
        authorizedContexts: [authorizedA],
      }),
    ).toBeNull();
  });

  it("elimina contexto cross-tenant mesmo que IDs de acesso pareçam coincidir", () => {
    const result = filterScheduleContextsForActor({
      actor: userActor,
      contexts: [context(1, 101), context(99, 901, 10, 9)],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: null,
          canAccess: true,
        },
        {
          institutionId: 9,
          professionalId: 55,
          hospitalId: 900,
          sectorId: null,
          canAccess: true,
        },
      ],
      managerScopes: [],
    });

    expect(result.map((row) => row.id)).toEqual([1]);
  });

  it("derivação legada aceita 1 contexto e rejeita 0 ou N", () => {
    expect(requireSingleLegacyScheduleContext([{ id: 7 }])).toEqual({ id: 7 });
    expect(() => requireSingleLegacyScheduleContext([])).toThrow(
      /nenhuma escala ativa/i,
    );
    expect(() =>
      requireSingleLegacyScheduleContext([{ id: 7 }, { id: 8 }]),
    ).toThrow(/mais de uma escala/i);
  });

  it("é mutation-sensitive para ACL negada e contexto inativo", () => {
    const denied = filterScheduleContextsForActor({
      actor: userActor,
      contexts: [context(1, 101)],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 101,
          canAccess: false,
        },
      ],
      managerScopes: [],
    });
    const inactive = { ...context(2, 102), active: false };
    const hidden = filterScheduleContextsForActor({
      actor: userActor,
      contexts: [inactive],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: 102,
          canAccess: true,
        },
      ],
      managerScopes: [],
    });

    expect(denied).toEqual([]);
    expect(hidden).toEqual([]);
  });

  it("colapsa contextos legados PINNED_QUALIFICATION da Agenda para um card por setor", () => {
    const recoverySectorId = 301;
    const legacyContexts = [
      {
        ...context(1, recoverySectorId, 10),
        sectorName: "Sala de Recuperação",
        medicalSpecialtyName: "Clínica médica",
      },
      {
        ...context(2, recoverySectorId, 11),
        sectorName: "Sala de Recuperação",
        medicalSpecialtyName: "Anestesiologia",
      },
      {
        ...context(3, recoverySectorId, 12),
        sectorName: "Sala de Recuperação",
        medicalSpecialtyName: "Medicina intensiva",
      },
    ];
    const result = filterScheduleContextsForActor({
      actor: {
        institutionId: 1,
        professionalId: null,
        roleInInstitution: "GESTOR_PLUS",
        isGlobalAdmin: false,
      },
      contexts: legacyContexts,
      accesses: [],
      managerScopes: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
    expect(result[0]?.displayName).toBe(
      "Hospital São Carlos — Sala de Recuperação — Clínica médica",
    );
  });

  it("prefere QUALIFICATION_ALLOWLIST canônico quando coexistem contextos legados", () => {
    const recoverySectorId = 301;
    const allowlist: ActiveScheduleContext = {
      ...context(100, recoverySectorId, null),
      sectorName: "Sala de Recuperação",
      medicalSpecialtyCode: null,
      medicalSpecialtyName: null,
      operationalProfileCode: null,
      admissionPolicy: "QUALIFICATION_ALLOWLIST",
      allowedQualifications: [
        { medicalSpecialtyId: 10, operationalProfileCode: null },
        { medicalSpecialtyId: 11, operationalProfileCode: null },
      ],
    };
    const legacyPinned = {
      ...context(2, recoverySectorId, 11),
      sectorName: "Sala de Recuperação",
      admissionPolicy: "PINNED_QUALIFICATION" as const,
      medicalSpecialtyName: "Anestesiologia",
    };
    const result = filterScheduleContextsForActor({
      actor: userActor,
      contexts: [allowlist, legacyPinned],
      accesses: [
        {
          institutionId: 1,
          professionalId: 55,
          hospitalId: 100,
          sectorId: recoverySectorId,
          canAccess: true,
        },
      ],
      managerScopes: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(100);
    expect(result[0]?.admissionPolicy).toBe("QUALIFICATION_ALLOWLIST");
    expect(result[0]?.displayName).toBe(
      "Hospital São Carlos — Sala de Recuperação",
    );
  });

  it("preserva canManage ao colapsar contextos do mesmo setor", () => {
    const recoverySectorId = 301;
    const managedLegacy = describeScheduleContext(
      {
        ...context(2, recoverySectorId, 11),
        sectorName: "Sala de Recuperação",
        medicalSpecialtyName: "Anestesiologia",
      },
      true,
    );
    const unmanagedLegacy = describeScheduleContext(
      {
        ...context(1, recoverySectorId, 10),
        sectorName: "Sala de Recuperação",
        medicalSpecialtyName: "Clínica médica",
      },
      false,
    );
    const picked = pickCanonicalAgendaScheduleContext([
      unmanagedLegacy,
      managedLegacy,
    ]);

    expect(picked.id).toBe(1);
    expect(picked.canManage).toBe(true);
    expect(
      dedupeAuthorizedScheduleContextsForAgenda([
        unmanagedLegacy,
        managedLegacy,
      ] as AuthorizedScheduleContext[]),
    ).toEqual([{ ...picked, canManage: true }]);
  });

  it("admite especialista CFM em Emergência e UTI, e bloqueia generalista na UTI", () => {
    const emergency: ActiveScheduleContext = {
      ...context(8, 201, 10),
      medicalSpecialtyId: null,
      medicalSpecialtyCode: null,
      medicalSpecialtyName: null,
      operationalProfileCode: null,
      admissionPolicy: "ALL_CFM_SPECIALTIES",
      sectorName: "Emergência",
    };
    const icu: ActiveScheduleContext = {
      ...emergency,
      id: 9,
      sectorId: 202,
      sectorName: "UTI",
      admissionPolicy: "ALL_CFM_EXCEPT_GENERALIST",
    };
    const specialist = {
      medicalSpecialtyId: 10,
      operationalProfileCode: null,
    };
    const resident = {
      medicalSpecialtyId: null,
      operationalProfileCode: "RESIDENTE_ANESTESIOLOGIA" as const,
    };

    expect(qualificationMatches(specialist, emergency)).toBe(true);
    expect(qualificationMatches(specialist, icu)).toBe(true);
    expect(qualificationMatches(resident, emergency)).toBe(false);
    expect(qualificationMatches(resident, icu)).toBe(false);
    expect(describeScheduleContext(emergency, false).displayName).toBe(
      "Hospital São Carlos — Emergência",
    );
  });
});
