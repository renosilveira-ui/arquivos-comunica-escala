import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildCorporateReadinessReport,
  getCorporateReadinessReport,
  isCurrentConfirmationCompatibleStart,
} from "../server/corporate-readiness-v1";
import {
  managerScope,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  pushTokens,
  scheduleContexts,
  sectorServiceSpecialties,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";

type Source = Parameters<typeof buildCorporateReadinessReport>[0];

function source(overrides: Partial<Source> = {}): Source {
  return {
    scope: {
      institutionId: 1,
      hospitalId: 10,
      sectorId: 100,
      yearMonth: "2026-09",
    },
    rosterStatus: "DRAFT",
    sectors: [{ id: 100, name: "Sala de Recuperação" }],
    scheduleContexts: [{ id: 1000, sectorId: 100, active: true }],
    activeTemplates: [{ id: 2000, sectorId: 100 }],
    shifts: [
      {
        id: 3000,
        sectorId: 100,
        scheduleContextId: 1000,
        status: "OCUPADO",
        startAt: new Date("2026-09-03T10:00:00.000Z"),
        endAt: new Date("2026-09-03T16:00:00.000Z"),
      },
    ],
    memberships: [
      { professionalId: 10, userId: 110, roleInInstitution: "GESTOR_MEDICO" },
      { professionalId: 11, userId: 111, roleInInstitution: "USER" },
    ],
    activeProfessionalAccesses: [
      { id: 4000, professionalId: 11, sectorId: 100 },
    ],
    activeManagerScopes: [
      { id: 5000, managerProfessionalId: 10, sectorId: 100 },
    ],
    activeAssignments: [
      {
        id: 6000,
        shiftInstanceId: 3000,
        professionalId: 11,
        sectorId: 100,
        status: "OCUPADO",
      },
    ],
    usersWithPushTokens: [111],
    topology: {
      invalidScheduleContextIds: [],
      invalidTemplateIds: [],
      invalidShiftIds: [],
      invalidProfessionalAccessIds: [],
      invalidManagerScopeIds: [],
      invalidAssignmentIds: [],
    },
    stale: { professionalAccessIds: [], managerScopeIds: [] },
    serviceSpecialties: {
      availability: "AVAILABLE",
      medicalSpecialtyIdsBySector: new Map([[100, [7]]]),
    },
    ...overrides,
  };
}

function issueCodes(report: ReturnType<typeof buildCorporateReadinessReport>) {
  return [
    ...report.hospitalIssues,
    ...report.sectors.flatMap((sector) => sector.issues),
  ].map((issue) => issue.code);
}

function fakeReadDb(rowsByTable: Map<unknown, unknown[] | Error>) {
  return {
    select: vi.fn(() => {
      let selectedTable: unknown;
      const chain: any = {
        from(table: unknown) {
          selectedTable = table;
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        limit() {
          return chain;
        },
        then(
          resolve: (value: unknown[]) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          const result = rowsByTable.get(selectedTable) ?? [];
          return result instanceof Error
            ? Promise.reject(result).then(resolve, reject)
            : Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
}

function databaseRows(
  options: { serviceSpecialties?: unknown[] | Error } = {},
) {
  const serviceSpecialties = options.serviceSpecialties ?? [
    {
      institutionId: 1,
      hospitalId: 10,
      sectorId: 100,
      medicalSpecialtyId: 7,
      code: "ANESTESIOLOGIA",
      name: "Anestesiologia",
      sortOrder: 1,
      active: true,
    },
  ];
  return new Map<unknown, unknown[] | Error>([
    [sectors, [{ id: 100, name: "Sala de Recuperação" }]],
    [
      scheduleContexts,
      [
        {
          id: 1000,
          institutionId: 1,
          hospitalId: 10,
          sectorId: 100,
          active: true,
        },
      ],
    ],
    [
      shiftTemplates,
      [
        {
          id: 2000,
          institutionId: 1,
          hospitalId: 10,
          sectorId: 100,
          active: true,
        },
      ],
    ],
    [
      shiftInstances,
      [
        {
          id: 3000,
          institutionId: 1,
          hospitalId: 10,
          sectorId: 100,
          scheduleContextId: 1000,
          status: "OCUPADO",
          startAt: new Date("2026-09-03T10:00:00.000Z"),
          endAt: new Date("2026-09-03T16:00:00.000Z"),
        },
      ],
    ],
    [monthlyRosters, [{ status: "DRAFT" }]],
    [
      professionalAccess,
      [
        {
          id: 4000,
          institutionId: 1,
          hospitalId: 10,
          professionalId: 11,
          sectorId: 100,
        },
      ],
    ],
    [
      managerScope,
      [
        {
          id: 5000,
          institutionId: 1,
          hospitalId: 10,
          managerProfessionalId: 10,
          sectorId: 100,
        },
      ],
    ],
    [
      shiftAssignmentsV2,
      [
        {
          id: 6000,
          institutionId: 1,
          hospitalId: 10,
          shiftInstanceId: 3000,
          professionalId: 11,
          sectorId: 100,
          status: "OCUPADO",
        },
      ],
    ],
    [
      professionalInstitutions,
      [
        { professionalId: 10, userId: 110, roleInInstitution: "GESTOR_MEDICO" },
        { professionalId: 11, userId: 111, roleInInstitution: "USER" },
      ],
    ],
    [
      professionals,
      [
        { id: 10, userId: 110 },
        { id: 11, userId: 111 },
      ],
    ],
    [
      users,
      [
        { id: 110, approvalStatus: "APPROVED", deletedAt: null },
        { id: 111, approvalStatus: "APPROVED", deletedAt: null },
      ],
    ],
    [pushTokens, [{ userId: 111 }]],
    [sectorServiceSpecialties, serviceSpecialties],
  ]);
}

describe("corporate readiness V1", () => {
  it("mantém especialidade assistencial fora da elegibilidade e da autorização", () => {
    const readinessSource = readFileSync(
      new URL("../server/corporate-readiness-v1.ts", import.meta.url),
      "utf8",
    );

    expect(readinessSource).not.toContain("qualificationMatches");
    expect(readinessSource).not.toContain("professionals.medicalSpecialtyId");
    expect(readinessSource).not.toContain("professionals.specialty");
    expect(readinessSource).not.toContain(
      "scheduleContexts.medicalSpecialtyId",
    );
    expect(readinessSource).not.toMatch(
      /\bdb\.(?:insert|update|delete|transaction)\b/,
    );
  });

  it("mede a cobertura operacional sem usar especialidade como elegibilidade", () => {
    const withOneSpecialty = buildCorporateReadinessReport(
      source(),
      "2026-09-01T12:00:00.000Z",
    );
    const withDifferentSpecialty = buildCorporateReadinessReport(
      source({
        serviceSpecialties: {
          availability: "AVAILABLE",
          medicalSpecialtyIdsBySector: new Map([[100, [99]]]),
        },
      }),
      "2026-09-01T12:00:00.000Z",
    );

    const first = withOneSpecialty.sectors[0]!.metrics;
    const second = withDifferentSpecialty.sectors[0]!.metrics;
    expect(first.activeProfessionalCoverageCount).toBe(2);
    expect(second.activeProfessionalCoverageCount).toBe(2);
    expect(first.allocatedProfessionalCount).toBe(1);
    expect(second.allocatedProfessionalCount).toBe(1);
    expect(first.serviceSpecialtyCount).toBe(1);
    expect(second.serviceSpecialtyCount).toBe(1);
    expect(withOneSpecialty.summary.SECURITY_BLOCKER).toBe(0);
    expect(withOneSpecialty.acknowledgement).toEqual({ supported: false });
    expect(withOneSpecialty.integrations.emailTrust).toBe("NOT_ACTIVATED");
  });

  it("classifica configuração incompleta como aviso ou informação, nunca como bloqueio", () => {
    const report = buildCorporateReadinessReport(
      source({
        scheduleContexts: [],
        activeTemplates: [],
        shifts: [
          {
            id: 3000,
            sectorId: 100,
            scheduleContextId: null,
            status: "VAGO",
            startAt: new Date("2026-09-03T11:00:00.000Z"),
            endAt: new Date("2026-09-03T17:00:00.000Z"),
          },
        ],
        memberships: [],
        activeProfessionalAccesses: [],
        activeManagerScopes: [],
        activeAssignments: [],
        usersWithPushTokens: [],
        serviceSpecialties: {
          availability: "AVAILABLE",
          medicalSpecialtyIdsBySector: new Map(),
        },
      }),
      "2026-09-01T12:00:00.000Z",
    );

    expect(report.summary.SECURITY_BLOCKER).toBe(0);
    expect(issueCodes(report)).toEqual(
      expect.arrayContaining([
        "MISSING_ACTIVE_SCHEDULE_CONTEXT",
        "MISSING_ACTIVE_SHIFT_TEMPLATE",
        "NO_ACTIVE_MANAGER_COVERAGE",
        "NO_ACTIVE_PROFESSIONAL_COVERAGE",
        "SERVICE_SPECIALTY_METADATA_PENDING",
        "VACANT_SHIFT_REQUIRES_ALLOCATION",
        "UNCLASSIFIED_SHIFT_CONTEXT",
        "CONFIRMATION_WINDOW_UNSUPPORTED",
      ]),
    );
  });

  it("reserva SECURITY_BLOCKER para topologia ou referência estrutural inválida", () => {
    const report = buildCorporateReadinessReport(
      source({
        shifts: [
          {
            id: 3000,
            sectorId: 100,
            scheduleContextId: 9999,
            status: "OCUPADO",
            startAt: new Date("2026-09-03T10:00:00.000Z"),
            endAt: new Date("2026-09-03T16:00:00.000Z"),
          },
        ],
        topology: {
          invalidScheduleContextIds: [],
          invalidTemplateIds: [],
          invalidShiftIds: [777],
          invalidProfessionalAccessIds: [],
          invalidManagerScopeIds: [],
          invalidAssignmentIds: [888],
        },
      }),
      "2026-09-01T12:00:00.000Z",
    );

    expect(report.summary.SECURITY_BLOCKER).toBe(3);
    expect(issueCodes(report)).toEqual(
      expect.arrayContaining([
        "INVALID_SHIFT_TOPOLOGY",
        "INVALID_ASSIGNMENT_TOPOLOGY",
        "INVALID_SHIFT_CONTEXT_REFERENCE",
      ]),
    );
  });

  it("gera snapshot estável sem nome do setor, e muda quando a configuração muda", () => {
    const original = buildCorporateReadinessReport(
      source(),
      "2026-09-01T12:00:00.000Z",
    );
    const renamed = buildCorporateReadinessReport(
      source({ sectors: [{ id: 100, name: "RPA" }] }),
      "2026-09-01T12:00:00.000Z",
    );
    const changedConfiguration = buildCorporateReadinessReport(
      source({ activeTemplates: [{ id: 2001, sectorId: 100 }] }),
      "2026-09-01T12:00:00.000Z",
    );

    expect(renamed.snapshotHash).toBe(original.snapshotHash);
    expect(changedConfiguration.snapshotHash).not.toBe(original.snapshotHash);
    expect(renamed.sectors[0]?.sectorName).toBe("RPA");
  });

  it("reflete a tolerância real dos três horários atuais de confirmação", () => {
    expect(
      isCurrentConfirmationCompatibleStart(
        new Date("2026-09-03T10:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isCurrentConfirmationCompatibleStart(
        new Date("2026-09-03T10:30:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isCurrentConfirmationCompatibleStart(
        new Date("2026-09-03T10:31:00.000Z"),
      ),
    ).toBe(false);
    expect(
      isCurrentConfirmationCompatibleStart(
        new Date("2026-09-03T16:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isCurrentConfirmationCompatibleStart(
        new Date("2026-09-03T22:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("carrega a fonte real sem consultar especialidade profissional ou e-mail", async () => {
    const db = fakeReadDb(databaseRows());

    const report = await getCorporateReadinessReport(db as any, {
      institutionId: 1,
      hospitalId: 10,
      sectorId: 100,
      yearMonth: "2026-09",
    });

    expect(report.sectors[0]?.metrics).toMatchObject({
      activeProfessionalCoverageCount: 2,
      allocatedProfessionalCount: 1,
      allocatedProfessionalsWithPushTokenCount: 1,
      serviceSpecialtyCount: 1,
    });
    expect(report.summary.SECURITY_BLOCKER).toBe(0);
    expect(db.select).toHaveBeenCalled();
  });

  it("trata a migration descritiva ainda ausente como informação, sem derrubar a escala", async () => {
    const missingTable = Object.assign(
      new Error("Table 'sector_service_specialties' doesn't exist"),
      { code: "ER_NO_SUCH_TABLE", errno: 1146, sqlState: "42S02" },
    );
    const report = await getCorporateReadinessReport(
      fakeReadDb(databaseRows({ serviceSpecialties: missingTable })) as any,
      {
        institutionId: 1,
        hospitalId: 10,
        sectorId: 100,
        yearMonth: "2026-09",
      },
    );

    expect(report.integrations.serviceSpecialties).toBe("MIGRATION_PENDING");
    expect(report.summary.SECURITY_BLOCKER).toBe(0);
    expect(issueCodes(report)).toContain(
      "SERVICE_SPECIALTY_METADATA_MIGRATION_PENDING",
    );
  });
});
