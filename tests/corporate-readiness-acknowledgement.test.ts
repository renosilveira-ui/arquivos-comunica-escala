import { describe, expect, it } from "vitest";
import type {
  CorporateReadinessIssue,
  CorporateReadinessReportV1,
} from "../server/corporate-readiness-v1";
import {
  assessCorporateReadinessAcknowledgement,
  operationalWarningCodes,
  operationalWarningSnapshot,
} from "../server/corporate-readiness-acknowledgement";

const BASE_SCOPE = { institutionId: 7, hospitalId: 11 } as const;

function issue(
  code: string,
  severity: CorporateReadinessIssue["severity"],
  sectorId?: number,
): CorporateReadinessIssue {
  return {
    code,
    severity,
    scope: {
      ...BASE_SCOPE,
      ...(sectorId === undefined ? {} : { sectorId }),
    },
  };
}

function report(input: {
  hash?: string;
  hospitalIssues?: readonly CorporateReadinessIssue[];
  sectorIssues?: Readonly<Record<number, readonly CorporateReadinessIssue[]>>;
} = {}): CorporateReadinessReportV1 {
  return {
    version: "v1",
    scope: { ...BASE_SCOPE, yearMonth: "2031-04" },
    rosterStatus: "DRAFT",
    generatedAt: "2031-03-10T12:00:00.000Z",
    snapshotHash: input.hash ?? "a".repeat(64),
    summary: {
      SECURITY_BLOCKER: 0,
      OPERATIONAL_WARNING: 0,
      INFO: 0,
    },
    hospitalIssues: input.hospitalIssues ?? [],
    sectors: Object.entries(input.sectorIssues ?? {}).map(
      ([sectorId, issues]) => ({
        sectorId: Number(sectorId),
        sectorName: `Setor ${sectorId}`,
        metrics: {
          activeScheduleContextCount: 0,
          resolvedActiveTemplateCount: 0,
          calendarMonthShiftCount: 0,
          vacantShiftCount: 0,
          pendingShiftCount: 0,
          allocatedShiftCount: 0,
          activeManagerCount: 0,
          activeProfessionalCoverageCount: 0,
          allocatedProfessionalCount: 0,
          allocatedProfessionalsWithPushTokenCount: 0,
          confirmationCompatibleShiftCount: 0,
          qualificationAllowlistMetadataEntryCount: 0,
          shiftsWithEmptyQualificationAllowlistMetadataCount: 0,
          serviceSpecialtyCount: 0,
        },
        issues,
      }),
    ),
    integrations: {
      serviceSpecialties: "AVAILABLE",
      emailTrust: "NOT_ACTIVATED",
    },
    acknowledgement: { supported: true, required: false, issueCodes: [] },
  };
}

describe("ciência de prontidão corporativa", () => {
  it("não transforma blocker de segurança em confirmação válida", () => {
    const current = report({
      hospitalIssues: [
        issue("INVALID_SHIFT_TOPOLOGY", "SECURITY_BLOCKER"),
        issue("STALE_MANAGER_SCOPE", "OPERATIONAL_WARNING"),
      ],
    });

    expect(
      assessCorporateReadinessAcknowledgement(current, {
        snapshotHash: current.snapshotHash,
        issueCodes: ["STALE_MANAGER_SCOPE"],
      }),
    ).toEqual({
      state: "SECURITY_BLOCKED",
      securityBlockerCodes: ["INVALID_SHIFT_TOPOLOGY"],
      operationalWarningCodes: ["STALE_MANAGER_SCOPE"],
    });
  });

  it("exige ciência dos avisos, com hash e conjunto de códigos exatos", () => {
    const current = report({
      sectorIssues: {
        31: [issue("VACANT_SHIFT_REQUIRES_ALLOCATION", "OPERATIONAL_WARNING", 31)],
        32: [issue("PUSH_DELIVERY_COVERAGE_PARTIAL", "OPERATIONAL_WARNING", 32)],
      },
    });

    expect(assessCorporateReadinessAcknowledgement(current, undefined)).toEqual({
      state: "ACKNOWLEDGEMENT_REQUIRED",
      operationalWarningCodes: [
        "PUSH_DELIVERY_COVERAGE_PARTIAL",
        "VACANT_SHIFT_REQUIRES_ALLOCATION",
      ],
    });
    expect(
      assessCorporateReadinessAcknowledgement(current, {
        snapshotHash: "b".repeat(64),
        issueCodes: [
          "PUSH_DELIVERY_COVERAGE_PARTIAL",
          "VACANT_SHIFT_REQUIRES_ALLOCATION",
        ],
      }),
    ).toEqual({
      state: "SNAPSHOT_STALE",
      operationalWarningCodes: [
        "PUSH_DELIVERY_COVERAGE_PARTIAL",
        "VACANT_SHIFT_REQUIRES_ALLOCATION",
      ],
    });
    expect(
      assessCorporateReadinessAcknowledgement(current, {
        snapshotHash: current.snapshotHash,
        issueCodes: ["VACANT_SHIFT_REQUIRES_ALLOCATION"],
      }),
    ).toEqual({
      state: "ISSUE_CODES_MISMATCH",
      operationalWarningCodes: [
        "PUSH_DELIVERY_COVERAGE_PARTIAL",
        "VACANT_SHIFT_REQUIRES_ALLOCATION",
      ],
    });
    expect(
      assessCorporateReadinessAcknowledgement(current, {
        snapshotHash: current.snapshotHash,
        issueCodes: [
          "VACANT_SHIFT_REQUIRES_ALLOCATION",
          "PUSH_DELIVERY_COVERAGE_PARTIAL",
        ],
      }),
    ).toEqual({
      state: "ACKNOWLEDGED",
      operationalWarningCodes: [
        "PUSH_DELIVERY_COVERAGE_PARTIAL",
        "VACANT_SHIFT_REQUIRES_ALLOCATION",
      ],
    });
  });

  it("recusa códigos duplicados e não pede ciência para informação isolada", () => {
    const warning = report({
      hospitalIssues: [
        issue("EMAIL_TRUST_NOT_ACTIVATED", "INFO"),
        issue("STALE_MANAGER_SCOPE", "OPERATIONAL_WARNING"),
      ],
    });
    expect(
      assessCorporateReadinessAcknowledgement(warning, {
        snapshotHash: warning.snapshotHash,
        issueCodes: ["STALE_MANAGER_SCOPE", "STALE_MANAGER_SCOPE"],
      }),
    ).toEqual({
      state: "ISSUE_CODES_MISMATCH",
      operationalWarningCodes: ["STALE_MANAGER_SCOPE"],
    });

    const informationOnly = report({
      hospitalIssues: [issue("EMAIL_TRUST_NOT_ACTIVATED", "INFO")],
    });
    expect(
      assessCorporateReadinessAcknowledgement(informationOnly, undefined),
    ).toEqual({ state: "NOT_REQUIRED", operationalWarningCodes: [] });
  });

  it("mantém o setor no snapshot de auditoria mesmo quando o código se repete", () => {
    const current = report({
      sectorIssues: {
        31: [issue("VACANT_SHIFT_REQUIRES_ALLOCATION", "OPERATIONAL_WARNING", 31)],
        32: [issue("VACANT_SHIFT_REQUIRES_ALLOCATION", "OPERATIONAL_WARNING", 32)],
      },
    });

    expect(operationalWarningCodes(current)).toEqual([
      "VACANT_SHIFT_REQUIRES_ALLOCATION",
    ]);
    expect(operationalWarningSnapshot(current)).toEqual([
      { code: "VACANT_SHIFT_REQUIRES_ALLOCATION", sectorId: 31 },
      { code: "VACANT_SHIFT_REQUIRES_ALLOCATION", sectorId: 32 },
    ]);
  });
});
