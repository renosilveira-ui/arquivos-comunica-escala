import { sql } from "drizzle-orm";
import {
  institutionReadinessFenceInstallations,
  institutionReadinessFences,
} from "../drizzle/schema";
import { rowsFromExecute } from "./_core/db-results";
import type { getDb } from "./db";
import {
  READINESS_FENCE_V1_COVERAGE_HASH,
  READINESS_FENCE_V1_COVERAGE_VERSION,
  READINESS_FENCE_V1_INSTALLATION_ID,
} from "./readiness-fence-v1-contract";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Só use dentro de uma transação real. A linha da fence precisa permanecer
 * bloqueada desde a leitura de um diagnóstico futuro até sua decisão final.
 */
export type ReadinessFenceV1Transaction = Pick<
  DbTransaction,
  "execute" | "insert"
>;

export type InstitutionReadinessFenceV1Lock = Readonly<{
  institutionId: number;
  revision: bigint;
}>;

export type ReadinessFenceV1InstallationReceipt = Readonly<{
  installationId: number;
  coverageVersion: string;
  coverageHash: string;
}>;

const MAX_MYSQL_SIGNED_INT = 2_147_483_647;
const issuedLocks = new WeakSet<object>();

function assertInstitutionId(institutionId: number): void {
  if (
    !Number.isSafeInteger(institutionId) ||
    institutionId <= 0 ||
    institutionId > MAX_MYSQL_SIGNED_INT
  ) {
    throw new TypeError("READINESS_FENCE_V1_INVALID_INSTITUTION");
  }
}

function parseInstitutionId(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= MAX_MYSQL_SIGNED_INT
    ? parsed
    : null;
}

function parseRevision(value: unknown): bigint | null {
  try {
    const revision =
      typeof value === "bigint"
        ? value
        : typeof value === "number"
          ? Number.isSafeInteger(value)
            ? BigInt(value)
            : null
          : typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
            ? BigInt(value)
            : null;
    return revision !== null && revision >= 0n ? revision : null;
  } catch {
    return null;
  }
}

function issueLock(
  institutionId: number,
  revision: bigint,
): InstitutionReadinessFenceV1Lock {
  const lock = Object.freeze({ institutionId, revision });
  issuedLocks.add(lock);
  return lock;
}

function assertIssuedLock(lock: InstitutionReadinessFenceV1Lock): void {
  if (!issuedLocks.has(lock)) {
    throw new Error("READINESS_FENCE_V1_UNISSUED_LOCK");
  }
}

async function selectFenceForUpdate(
  tx: ReadinessFenceV1Transaction,
  institutionId: number,
): Promise<InstitutionReadinessFenceV1Lock> {
  const result = await tx.execute(sql`
    SELECT ${institutionReadinessFences.institutionId} AS institutionId,
           ${institutionReadinessFences.revision} AS revision
    FROM ${institutionReadinessFences}
    WHERE ${institutionReadinessFences.institutionId} = ${institutionId}
    LIMIT 1
    FOR UPDATE
  `);
  const [row] = rowsFromExecute<{
    institutionId: number | string;
    revision: bigint | number | string;
  }>(result);
  const rowInstitutionId = parseInstitutionId(row?.institutionId);
  const revision = parseRevision(row?.revision);
  if (rowInstitutionId !== institutionId || revision === null) {
    throw new Error("READINESS_FENCE_V1_INTEGRITY_FAILURE");
  }
  return issueLock(rowInstitutionId, revision);
}

/**
 * Exige o recibo canônico de cobertura completa. Ausência, duplicidade ou
 * divergência não devolvem "false": lançam erro e não podem ser confundidas
 * com uma prontidão aprovada.
 */
export async function assertCompleteReadinessFenceV1Installation(
  tx: ReadinessFenceV1Transaction,
): Promise<ReadinessFenceV1InstallationReceipt> {
  const result = await tx.execute(sql`
    SELECT ${institutionReadinessFenceInstallations.id} AS installationId,
           ${institutionReadinessFenceInstallations.coverageVersion} AS coverageVersion,
           ${institutionReadinessFenceInstallations.coverageHash} AS coverageHash
    FROM ${institutionReadinessFenceInstallations}
    ORDER BY ${institutionReadinessFenceInstallations.id}
    LOCK IN SHARE MODE
  `);
  const rows = rowsFromExecute<{
    installationId: number | string;
    coverageVersion: string;
    coverageHash: string;
  }>(result);
  const [row] = rows;
  if (
    rows.length !== 1 ||
    parseInstitutionId(row?.installationId) !==
      READINESS_FENCE_V1_INSTALLATION_ID ||
    row?.coverageVersion !== READINESS_FENCE_V1_COVERAGE_VERSION ||
    row?.coverageHash !== READINESS_FENCE_V1_COVERAGE_HASH
  ) {
    throw new Error("READINESS_FENCE_V1_INSTALLATION_UNVERIFIED");
  }
  return Object.freeze({
    installationId: READINESS_FENCE_V1_INSTALLATION_ID,
    coverageVersion: READINESS_FENCE_V1_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_V1_COVERAGE_HASH,
  });
}

/**
 * Materializa e bloqueia somente uma revisão por instituição. Esta função não
 * calcula relatório, não recebe snapshot do cliente e não autoriza
 * publicação; ela fornece apenas uma barreira transacional para uma frente
 * futura que revalide um diagnóstico canônico no próprio servidor.
 */
export async function materializeAndLockInstitutionReadinessFenceV1(
  tx: ReadinessFenceV1Transaction,
  institutionId: number,
): Promise<InstitutionReadinessFenceV1Lock> {
  assertInstitutionId(institutionId);
  await assertCompleteReadinessFenceV1Installation(tx);

  await tx
    .insert(institutionReadinessFences)
    .values({ institutionId })
    .onDuplicateKeyUpdate({
      set: { revision: sql`${institutionReadinessFences.revision}` },
    });
  return selectFenceForUpdate(tx, institutionId);
}

/**
 * Releitura final da mesma transação. Um lock fabricado pelo chamador não é
 * aceito, e qualquer revisão diferente invalida o fluxo.
 */
export async function assertInstitutionReadinessFenceV1Unchanged(
  tx: ReadinessFenceV1Transaction,
  expected: InstitutionReadinessFenceV1Lock,
): Promise<InstitutionReadinessFenceV1Lock> {
  assertIssuedLock(expected);
  assertInstitutionId(expected.institutionId);
  if (typeof expected.revision !== "bigint" || expected.revision < 0n) {
    throw new TypeError("READINESS_FENCE_V1_INVALID_REVISION");
  }
  await assertCompleteReadinessFenceV1Installation(tx);
  const observed = await selectFenceForUpdate(tx, expected.institutionId);
  if (observed.revision !== expected.revision) {
    throw new Error("READINESS_FENCE_V1_CHANGED");
  }
  return observed;
}
