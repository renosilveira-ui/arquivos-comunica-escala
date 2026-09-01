import { sql } from "drizzle-orm";
import { institutionReadinessFenceExtensionInstallations } from "../drizzle/schema";
import { rowsFromExecute } from "./_core/db-results";
import type { getDb } from "./db";
import {
  assertCompleteReadinessFenceInstallation,
  assertInstitutionReadinessFenceUnchanged,
  materializeAndLockInstitutionReadinessFence,
  type InstitutionReadinessFenceLock,
  type ReadinessFenceInstallationReceipt,
  type ReadinessFenceTransaction,
} from "./readiness-fence";
import {
  READINESS_FENCE_V2_COVERAGE_HASH,
  READINESS_FENCE_V2_COVERAGE_VERSION,
  READINESS_FENCE_V2_EXTENSION_KEY,
  READINESS_FENCE_V2_PREDECESSOR,
} from "./readiness-fence-v2-contract";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** V2 usa a mesma transação e a mesma linha de fence por instituição da V1. */
export type ReadinessFenceV2Transaction = Pick<
  DbTransaction,
  "execute" | "insert"
>;

export type ReadinessFenceV2InstallationReceipt = Readonly<{
  v1: ReadinessFenceInstallationReceipt;
  extensionKey: string;
  coverageVersion: string;
  coverageHash: string;
}>;

function parseBaseInstallationId(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Requer simultaneamente a V1 canônica e o recibo V2 imutável que referencia
 * a prova V1. Não aceita ausência, duplicidade ou extensão de outro contrato.
 */
export async function assertCompleteReadinessFenceV2Installation(
  tx: ReadinessFenceV2Transaction,
): Promise<ReadinessFenceV2InstallationReceipt> {
  const v1 = await assertCompleteReadinessFenceInstallation(tx);
  const result = await tx.execute(sql`
    SELECT ${institutionReadinessFenceExtensionInstallations.extensionKey} AS extensionKey,
           ${institutionReadinessFenceExtensionInstallations.coverageVersion} AS coverageVersion,
           ${institutionReadinessFenceExtensionInstallations.coverageHash} AS coverageHash,
           ${institutionReadinessFenceExtensionInstallations.baseInstallationId} AS baseInstallationId,
           ${institutionReadinessFenceExtensionInstallations.baseCoverageVersion} AS baseCoverageVersion,
           ${institutionReadinessFenceExtensionInstallations.baseCoverageHash} AS baseCoverageHash
    FROM ${institutionReadinessFenceExtensionInstallations}
    WHERE ${institutionReadinessFenceExtensionInstallations.extensionKey} = ${READINESS_FENCE_V2_EXTENSION_KEY}
    LIMIT 2
    LOCK IN SHARE MODE
  `);
  const rows = rowsFromExecute<{
    extensionKey: string;
    coverageVersion: string;
    coverageHash: string;
    baseInstallationId: number | string;
    baseCoverageVersion: string;
    baseCoverageHash: string;
  }>(result);
  const [row] = rows;
  if (
    rows.length !== 1 ||
    row?.extensionKey !== READINESS_FENCE_V2_EXTENSION_KEY ||
    row.coverageVersion !== READINESS_FENCE_V2_COVERAGE_VERSION ||
    row.coverageHash !== READINESS_FENCE_V2_COVERAGE_HASH ||
    parseBaseInstallationId(row.baseInstallationId) !==
      READINESS_FENCE_V2_PREDECESSOR.installationId ||
    row.baseCoverageVersion !==
      READINESS_FENCE_V2_PREDECESSOR.coverageVersion ||
    row.baseCoverageHash !== READINESS_FENCE_V2_PREDECESSOR.coverageHash
  ) {
    throw new Error("READINESS_FENCE_V2_EXTENSION_UNVERIFIED");
  }
  return Object.freeze({
    v1,
    extensionKey: READINESS_FENCE_V2_EXTENSION_KEY,
    coverageVersion: READINESS_FENCE_V2_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_V2_COVERAGE_HASH,
  });
}

/**
 * Materializa e trava a mesma fence V1, após provar que a extensão V2 também
 * está instalada. A V1 continua responsável pela revisão monotônica comum.
 */
export async function materializeAndLockInstitutionReadinessFenceV2(
  tx: ReadinessFenceV2Transaction,
  institutionId: number,
): Promise<InstitutionReadinessFenceLock> {
  await assertCompleteReadinessFenceV2Installation(tx);
  return materializeAndLockInstitutionReadinessFence(
    tx as ReadinessFenceTransaction,
    institutionId,
  );
}

export async function assertInstitutionReadinessFenceV2Unchanged(
  tx: ReadinessFenceV2Transaction,
  expected: InstitutionReadinessFenceLock,
): Promise<InstitutionReadinessFenceLock> {
  await assertCompleteReadinessFenceV2Installation(tx);
  return assertInstitutionReadinessFenceUnchanged(
    tx as ReadinessFenceTransaction,
    expected,
  );
}
