import type {
  CorporateReadinessIssue,
  CorporateReadinessReportV1,
} from "./corporate-readiness-v1";

/**
 * Recibo apresentado pelo gestor depois de consultar o diagnóstico. O hash
 * não é uma autorização: ele só identifica exatamente a fotografia que será
 * recalculada pelo servidor na transação de publicação.
 */
export type CorporateReadinessAcknowledgement = Readonly<{
  snapshotHash: string;
  issueCodes: readonly string[];
}>;

export type CorporateReadinessWarningSnapshot = Readonly<{
  code: string;
  sectorId: number | null;
}>;

export type CorporateReadinessAcknowledgementAssessment =
  | Readonly<{
      state: "SECURITY_BLOCKED";
      securityBlockerCodes: readonly string[];
      operationalWarningCodes: readonly string[];
    }>
  | Readonly<{
      state: "ACKNOWLEDGEMENT_REQUIRED";
      operationalWarningCodes: readonly string[];
    }>
  | Readonly<{
      state: "SNAPSHOT_STALE";
      operationalWarningCodes: readonly string[];
    }>
  | Readonly<{
      state: "ISSUE_CODES_MISMATCH";
      operationalWarningCodes: readonly string[];
    }>
  | Readonly<{
      state: "NOT_REQUIRED";
      operationalWarningCodes: readonly [];
    }>
  | Readonly<{
      state: "ACKNOWLEDGED";
      operationalWarningCodes: readonly string[];
    }>;

function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function allIssues(
  report: CorporateReadinessReportV1,
): readonly CorporateReadinessIssue[] {
  return [
    ...report.hospitalIssues,
    ...report.sectors.flatMap((sector) => sector.issues),
  ];
}

function uniqueSortedCodes(codes: readonly string[]): readonly string[] | null {
  if (!Array.isArray(codes) || codes.some((code) => typeof code !== "string")) {
    return null;
  }
  const sorted = [...codes].sort(compareCanonicalStrings);
  if (sorted.some((code, index) => index > 0 && code === sorted[index - 1])) {
    return null;
  }
  return sorted;
}

function sortedDistinctCodes(codes: readonly string[]): readonly string[] {
  return [...new Set(codes)].sort(compareCanonicalStrings);
}

function hasSameCodes(
  expected: readonly string[],
  provided: readonly string[],
): boolean {
  return (
    expected.length === provided.length &&
    expected.every((code, index) => code === provided[index])
  );
}

/** Códigos únicos para a confirmação do gestor; o hash vincula os setores. */
export function operationalWarningCodes(
  report: CorporateReadinessReportV1,
): readonly string[] {
  return sortedDistinctCodes(
    allIssues(report)
      .filter((issue) => issue.severity === "OPERATIONAL_WARNING")
      .map((issue) => issue.code),
  );
}

/**
 * Snapshot auditável das pendências. Códigos repetidos em setores diferentes
 * continuam distintos aqui, pois a ciência precisa registrar toda a topologia
 * que o hash representa.
 */
export function operationalWarningSnapshot(
  report: CorporateReadinessReportV1,
): readonly CorporateReadinessWarningSnapshot[] {
  return allIssues(report)
    .filter((issue) => issue.severity === "OPERATIONAL_WARNING")
    .map((issue) => ({
      code: issue.code,
      sectorId: issue.scope.sectorId ?? null,
    }))
    .sort(
      (left, right) =>
        (left.sectorId ?? 0) - (right.sectorId ?? 0) ||
        compareCanonicalStrings(left.code, right.code),
    );
}

/**
 * Decide a ciência sem colapsar estados. Apenas ACKNOWLEDGED e NOT_REQUIRED
 * são aptos a continuar; a transação ainda precisa recomputar o relatório.
 */
export function assessCorporateReadinessAcknowledgement(
  report: CorporateReadinessReportV1,
  acknowledgement: CorporateReadinessAcknowledgement | undefined,
): CorporateReadinessAcknowledgementAssessment {
  const securityBlockerCodes = sortedDistinctCodes(
    allIssues(report)
      .filter((issue) => issue.severity === "SECURITY_BLOCKER")
      .map((issue) => issue.code),
  );
  const warnings = operationalWarningCodes(report);

  if (securityBlockerCodes.length > 0) {
    return {
      state: "SECURITY_BLOCKED",
      securityBlockerCodes,
      operationalWarningCodes: warnings,
    };
  }

  if (!acknowledgement) {
    return warnings.length > 0
      ? {
          state: "ACKNOWLEDGEMENT_REQUIRED",
          operationalWarningCodes: warnings,
        }
      : { state: "NOT_REQUIRED", operationalWarningCodes: [] };
  }

  if (acknowledgement.snapshotHash !== report.snapshotHash) {
    return { state: "SNAPSHOT_STALE", operationalWarningCodes: warnings };
  }

  const providedCodes = uniqueSortedCodes(acknowledgement.issueCodes);
  if (!providedCodes || !hasSameCodes(warnings, providedCodes)) {
    return {
      state: "ISSUE_CODES_MISMATCH",
      operationalWarningCodes: warnings,
    };
  }

  return { state: "ACKNOWLEDGED", operationalWarningCodes: warnings };
}
