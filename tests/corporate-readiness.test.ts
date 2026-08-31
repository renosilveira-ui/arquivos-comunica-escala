import { describe, expect, it } from "vitest";
import {
  assertReadinessAcknowledgement,
  buildCorporateReadinessReport,
  projectCorporateReadinessReport,
  type CorporateReadinessSource,
} from "../server/corporate-readiness";

function source(
  overrides: Partial<CorporateReadinessSource> = {},
): CorporateReadinessSource {
  return {
    scope: {
      institutionId: 10,
      hospitalId: 20,
      yearMonth: "2032-03",
    },
    rosterStatus: "DRAFT",
    sectors: [{ id: 30, name: "Recuperação" }],
    activeScheduleContexts: [
      {
        id: 40,
        sectorId: 30,
        medicalSpecialtyId: null,
        operationalProfileCode: null,
      },
    ],
    scheduleContextAllowedQualifications: [],
    invalidScheduleContextIds: [],
    activeTemplates: [
      {
        id: 50,
        hospitalId: 20,
        sectorId: 30,
        name: "Manhã",
        startTime: "07:00:00",
        endTime: "13:00:00",
        priority: null,
      },
    ],
    invalidTemplateIds: [],
    shifts: [
      {
        id: 60,
        sectorId: 30,
        scheduleContextId: 40,
        label: "Recuperação",
        specialty: "Anestesiologia",
        status: "OCUPADO",
        startAt: new Date("2032-03-10T10:00:00.000Z"),
        endAt: new Date("2032-03-10T16:00:00.000Z"),
        modality: "PLANTAO",
        coverageType: "URGENCIA_EMERGENCIA",
        paymentModel: "FIXO",
        productivityCapBrl: null,
      },
    ],
    invalidShiftIds: [],
    memberships: [
      {
        professionalId: 70,
        userId: 80,
        roleInInstitution: "GESTOR_PLUS",
        userEmail: "gestor@example.test",
      },
    ],
    activeProfessionalAccesses: [],
    invalidProfessionalAccessIds: [],
    staleProfessionalAccessIds: [],
    activeManagerScopes: [],
    invalidManagerScopeIds: [],
    staleManagerScopeIds: [],
    activeAssignments: [
      {
        id: 90,
        shiftInstanceId: 60,
        professionalId: 70,
        sectorId: 30,
        status: "OCUPADO",
      },
    ],
    invalidAssignmentIds: [],
    usersWithPushTokens: [80],
    ...overrides,
  };
}

describe("CorporateReadinessReportV1", () => {
  it("gera o mesmo snapshot para o mesmo estado, independentemente do instante de leitura", () => {
    const reportA = buildCorporateReadinessReport(
      source(),
      "2032-03-01T10:00:00.000Z",
    );
    const reportB = buildCorporateReadinessReport(
      source(),
      "2032-03-01T10:01:00.000Z",
    );

    expect(reportA.snapshotHash).toBe(reportB.snapshotHash);
    expect(reportA.generatedAt).not.toBe(reportB.generatedAt);
    expect(reportA.summary).toEqual({
      SECURITY_BLOCKER: 0,
      OPERATIONAL_WARNING: 0,
      INFO: 0,
    });
    expect(reportA.hospitalIssues).toEqual([]);
    expect(reportA.integrations.serviceSpecialtyMetadata).toBe(
      "PENDING_RELATION",
    );
  });

  it("invalida a ciência quando um parâmetro operacional muda sem alterar a contagem de alertas", () => {
    const before = buildCorporateReadinessReport(source());
    const after = buildCorporateReadinessReport(
      source({
        activeTemplates: [
          {
            id: 50,
            hospitalId: 20,
            sectorId: 30,
            name: "Manhã",
            startTime: "08:00:00",
            endTime: "14:00:00",
            priority: null,
          },
        ],
      }),
    );

    expect(after.summary).toEqual(before.summary);
    expect(after.snapshotHash).not.toBe(before.snapshotHash);
  });

  it("invalida ciência quando a regra canônica de qualificação do contexto muda", () => {
    const before = buildCorporateReadinessReport(
      source({
        activeTemplates: [],
        activeScheduleContexts: [
          {
            id: 40,
            sectorId: 30,
            medicalSpecialtyId: 501,
            operationalProfileCode: null,
            admissionPolicy: "PINNED_QUALIFICATION",
          },
        ],
      }),
    );
    const acknowledgement = {
      snapshotHash: before.snapshotHash,
      issueCodes: before.acknowledgement.operationalWarningCodes,
    };
    const changes = [
      source({
        activeTemplates: [],
        activeScheduleContexts: [
          {
            id: 40,
            sectorId: 30,
            medicalSpecialtyId: 502,
            operationalProfileCode: null,
            admissionPolicy: "PINNED_QUALIFICATION",
          },
        ],
      }),
      source({
        activeTemplates: [],
        activeScheduleContexts: [
          {
            id: 40,
            sectorId: 30,
            medicalSpecialtyId: null,
            operationalProfileCode: "MEDICO_GENERALISTA",
            admissionPolicy: "PINNED_QUALIFICATION",
          },
        ],
      }),
      source({
        activeTemplates: [],
        activeScheduleContexts: [
          {
            id: 40,
            sectorId: 30,
            medicalSpecialtyId: null,
            operationalProfileCode: null,
            admissionPolicy: "QUALIFICATION_ALLOWLIST",
          },
        ],
        scheduleContextAllowedQualifications: [
          {
            scheduleContextId: 40,
            medicalSpecialtyId: 501,
            operationalProfileCode: null,
          },
        ],
      }),
    ];

    for (const changedSource of changes) {
      const after = buildCorporateReadinessReport(changedSource);
      expect(after.snapshotHash).not.toBe(before.snapshotHash);
      expect(() =>
        assertReadinessAcknowledgement(after, acknowledgement),
      ).toThrow("READINESS_SNAPSHOT_STALE");
    }

    const allowlistContext = {
      id: 40,
      sectorId: 30,
      medicalSpecialtyId: null,
      operationalProfileCode: null,
      admissionPolicy: "QUALIFICATION_ALLOWLIST",
    };
    const withAllowlist = buildCorporateReadinessReport(
      source({
        activeTemplates: [],
        activeScheduleContexts: [allowlistContext],
        scheduleContextAllowedQualifications: [
          {
            scheduleContextId: 40,
            medicalSpecialtyId: 501,
            operationalProfileCode: null,
          },
        ],
      }),
    );
    const withoutAllowlist = buildCorporateReadinessReport(
      source({
        activeTemplates: [],
        activeScheduleContexts: [allowlistContext],
        scheduleContextAllowedQualifications: [],
      }),
    );
    expect(withoutAllowlist.snapshotHash).not.toBe(withAllowlist.snapshotHash);
    expect(() =>
      assertReadinessAcknowledgement(withoutAllowlist, {
        snapshotHash: withAllowlist.snapshotHash,
        issueCodes: withAllowlist.acknowledgement.operationalWarningCodes,
      }),
    ).toThrow("READINESS_SNAPSHOT_STALE");
  });

  it("invalida ciência quando muda um campo material do plantão", () => {
    const before = buildCorporateReadinessReport(source({ activeTemplates: [] }));
    const acknowledgement = {
      snapshotHash: before.snapshotHash,
      issueCodes: before.acknowledgement.operationalWarningCodes,
    };
    const changes: Partial<CorporateReadinessSource["shifts"][number]>[] = [
      { endAt: new Date("2032-03-10T17:00:00.000Z") },
      { label: "Recuperação pós-anestésica" },
      { specialty: "Medicina Intensiva" },
      { modality: "SOBREAVISO", coverageType: null },
      { coverageType: "ELETIVAS" },
      { paymentModel: "FIXO_PRODUTIVIDADE_TETO", productivityCapBrl: "1200.00" },
    ];

    for (const changedFields of changes) {
      const after = buildCorporateReadinessReport(
        source({
          activeTemplates: [],
          shifts: [
            {
              ...source().shifts[0],
              ...changedFields,
            },
          ],
        }),
      );
      expect(after.snapshotHash).not.toBe(before.snapshotHash);
      expect(() =>
        assertReadinessAcknowledgement(after, acknowledgement),
      ).toThrow("READINESS_SNAPSHOT_STALE");
    }
  });

  it("não trata solicitação pendente como cobertura e exige ciência para vaga ou pendência", () => {
    const pending = buildCorporateReadinessReport(
      source({
        shifts: [
          {
            id: 60,
            sectorId: 30,
            scheduleContextId: 40,
            label: "Recuperação",
            specialty: "Anestesiologia",
            status: "PENDENTE",
            startAt: new Date("2032-03-10T10:00:00.000Z"),
            endAt: new Date("2032-03-10T16:00:00.000Z"),
            modality: "PLANTAO",
            coverageType: "URGENCIA_EMERGENCIA",
            paymentModel: "FIXO",
            productivityCapBrl: null,
          },
        ],
        activeAssignments: [
          {
            id: 90,
            shiftInstanceId: 60,
            professionalId: 70,
            sectorId: 30,
            status: "PENDENTE",
          },
        ],
      }),
    );
    const vacant = buildCorporateReadinessReport(
      source({
        shifts: [
          {
            id: 60,
            sectorId: 30,
            scheduleContextId: 40,
            label: "Recuperação",
            specialty: "Anestesiologia",
            status: "VAGO",
            startAt: new Date("2032-03-10T10:00:00.000Z"),
            endAt: new Date("2032-03-10T16:00:00.000Z"),
            modality: "PLANTAO",
            coverageType: "URGENCIA_EMERGENCIA",
            paymentModel: "FIXO",
            productivityCapBrl: null,
          },
        ],
        activeAssignments: [],
      }),
    );

    expect(pending.sectors[0]?.metrics.assignedShiftCount).toBe(0);
    expect(
      pending.sectors[0]?.issues.some(
        (issue) => issue.code === "PENDING_ALLOCATION_REQUIRES_REVIEW",
      ),
    ).toBe(true);
    expect(
      vacant.sectors[0]?.issues.some(
        (issue) => issue.code === "VACANT_SHIFT_REQUIRES_ALLOCATION",
      ),
    ).toBe(true);
    expect(pending.acknowledgement.required).toBe(true);
    expect(vacant.acknowledgement.required).toBe(true);
  });

  it("não considera cobertura uma alocação ocupada cujo acesso foi revogado", () => {
    const report = buildCorporateReadinessReport(
      source({
        memberships: [
          {
            professionalId: 70,
            userId: 80,
            roleInInstitution: "USER",
            userEmail: "medico@example.test",
          },
        ],
        activeProfessionalAccesses: [],
      }),
    );

    expect(report.sectors[0]?.metrics.assignedShiftCount).toBe(0);
    expect(report.sectors[0]?.metrics.allocatedProfessionalCount).toBe(0);
    expect(
      report.sectors[0]?.issues.some(
        (issue) => issue.code === "ALLOCATION_ACCESS_REVOKED",
      ),
    ).toBe(true);
    expect(report.summary.SECURITY_BLOCKER).toBeGreaterThan(0);
  });

  it("não trata a especialidade como trava e só pede mapeamento quando a fonte existir", () => {
    const withoutSpecialtyRelation = buildCorporateReadinessReport(source());
    const availableButPending = buildCorporateReadinessReport(
      source({
        serviceSpecialtyMetadata: {
          sectorIdsWithSpecialties: [],
        },
      }),
    );

    expect(withoutSpecialtyRelation.summary.SECURITY_BLOCKER).toBe(0);
    expect(
      withoutSpecialtyRelation.hospitalIssues.some((issue) =>
        issue.code.startsWith("SERVICE_SPECIALTY_METADATA"),
      ),
    ).toBe(false);
    expect(
      withoutSpecialtyRelation.sectors
        .flatMap((sector) => sector.issues)
        .some((issue) => issue.code.startsWith("SERVICE_SPECIALTY_METADATA")),
    ).toBe(false);
    expect(
      availableButPending.sectors[0]?.issues.some(
        (issue) => issue.code === "SERVICE_SPECIALTY_METADATA_PENDING",
      ),
    ).toBe(true);
    expect(availableButPending.summary.SECURITY_BLOCKER).toBe(0);
    expect(availableButPending.integrations.serviceSpecialtyMetadata).toBe(
      "AVAILABLE",
    );
  });

  it("só sinaliza confiança de e-mail quando a fonte estruturada existir", () => {
    const withoutTrustRelation = buildCorporateReadinessReport(source());
    const withUntrustedAllocation = buildCorporateReadinessReport(
      source({ trustedEmailUserIds: [] }),
    );

    expect(
      withoutTrustRelation.sectors
        .flatMap((sector) => sector.issues)
        .some((issue) => issue.code === "EMAIL_TRUST_COVERAGE_PARTIAL"),
    ).toBe(false);
    expect(
      withUntrustedAllocation.sectors[0]?.issues.some(
        (issue) => issue.code === "EMAIL_TRUST_COVERAGE_PARTIAL",
      ),
    ).toBe(true);
  });

  it("exige ciência exata para alertas e rejeita snapshot ou lista de códigos defasados", () => {
    const report = buildCorporateReadinessReport(
      source({
        activeScheduleContexts: [],
        activeTemplates: [],
        shifts: [],
        memberships: [],
        activeAssignments: [],
        usersWithPushTokens: [],
      }),
    );
    const acknowledgement = {
      snapshotHash: report.snapshotHash,
      issueCodes: report.acknowledgement.operationalWarningCodes,
    };

    expect(report.acknowledgement.required).toBe(true);
    expect(() => assertReadinessAcknowledgement(report, undefined)).toThrow(
      "READINESS_ACKNOWLEDGEMENT_REQUIRED",
    );
    expect(() =>
      assertReadinessAcknowledgement(report, acknowledgement),
    ).not.toThrow();
    expect(() =>
      assertReadinessAcknowledgement(report, {
        ...acknowledgement,
        snapshotHash: "0".repeat(64),
      }),
    ).toThrow("READINESS_SNAPSHOT_STALE");
    expect(() =>
      assertReadinessAcknowledgement(report, {
        ...acknowledgement,
        issueCodes: acknowledgement.issueCodes.slice(1),
      }),
    ).toThrow("READINESS_ISSUES_MISMATCH");
  });

  it("não deixa uma ciência ignorar bloqueio de segurança de topologia", () => {
    const report = buildCorporateReadinessReport(
      source({ invalidProfessionalAccessIds: [999] }),
    );

    expect(report.summary.SECURITY_BLOCKER).toBe(1);
    expect(() =>
      assertReadinessAcknowledgement(report, {
        snapshotHash: report.snapshotHash,
        issueCodes: report.acknowledgement.operationalWarningCodes,
      }),
    ).toThrow("READINESS_SECURITY_BLOCKER");
  });

  it("redige totais, alertas e ciência hospitalares fora do escopo setorial", () => {
    const full = buildCorporateReadinessReport(
      source({
        sectors: [
          { id: 30, name: "Recuperação" },
          { id: 31, name: "UTI" },
        ],
      }),
    );
    const redacted = projectCorporateReadinessReport(full, {
      revealAll: false,
      visibleSectorIds: [30],
    });

    expect(redacted.sectors.map((sector) => sector.sectorId)).toEqual([30]);
    expect(redacted.visibility).toEqual({
      detailsRedacted: true,
      hiddenSectorCount: null,
    });
    expect(redacted.summary.SECURITY_BLOCKER).toBe(0);
    expect(redacted.summary.OPERATIONAL_WARNING).toBe(0);
    expect(redacted.hospitalIssues).toEqual([]);
    expect(redacted.acknowledgement).toEqual({
      required: false,
      operationalWarningCodes: [],
    });
    expect(redacted.snapshotHash).not.toBe(full.snapshotHash);
  });

  it("não deixa mudança em setor oculto alterar o hash da visão setorial", () => {
    const onlyVisible = buildCorporateReadinessReport(source());
    const withHiddenSector = buildCorporateReadinessReport(
      source({
        sectors: [
          { id: 30, name: "Recuperação" },
          { id: 31, name: "UTI" },
        ],
      }),
    );

    expect(withHiddenSector.snapshotHash).not.toBe(onlyVisible.snapshotHash);
    expect(
      projectCorporateReadinessReport(onlyVisible, {
        revealAll: false,
        visibleSectorIds: [30],
      }).snapshotHash,
    ).toBe(
      projectCorporateReadinessReport(withHiddenSector, {
        revealAll: false,
        visibleSectorIds: [30],
      }).snapshotHash,
    );
  });
});
