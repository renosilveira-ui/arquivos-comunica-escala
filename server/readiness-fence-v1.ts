import { sql } from "drizzle-orm";
import {
  institutionReadinessFenceInstallations,
  institutionReadinessFences,
} from "../drizzle/schema";
import { rowsFromExecute } from "./_core/db-results";
import { getDb } from "./db";
import {
  READINESS_FENCE_V1_COVERAGE_HASH,
  READINESS_FENCE_V1_COVERAGE_VERSION,
  READINESS_FENCE_V1_INSTALLATION_ID,
} from "./readiness-fence-v1-contract";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type InstitutionReadinessFenceV1Lock = Readonly<{
  institutionId: number;
  revision: bigint;
}>;

/**
 * O símbolo não é exportado: somente o wrapper abaixo consegue criar uma
 * scope válida. Isso evita que uma interface estrutural com `execute`/`insert`
 * aceite, por engano, um db em autocommit como se fosse uma transação.
 */
const readinessFenceV1ScopeBrand = Symbol("readinessFenceV1Scope");

export type ReadinessFenceV1Scope = Readonly<{
  readonly [readinessFenceV1ScopeBrand]: true;
  materializeAndLockInstitution(
    institutionId: number,
  ): Promise<InstitutionReadinessFenceV1Lock>;
  assertInstitutionUnchanged(
    expected: InstitutionReadinessFenceV1Lock,
  ): Promise<InstitutionReadinessFenceV1Lock>;
}>;

type ReadinessFenceV1InstallationReceipt = Readonly<{
  installationId: number;
  coverageVersion: string;
  coverageHash: string;
}>;

const MAX_MYSQL_SIGNED_INT = 2_147_483_647;
const issuedScopes = new WeakSet<object>();
const activeScopes = new WeakSet<object>();
const issuedLocks = new WeakMap<object, ReadinessFenceV1Scope>();

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

function assertActiveScope(scope: ReadinessFenceV1Scope): void {
  if (!issuedScopes.has(scope) || !activeScopes.has(scope)) {
    throw new Error("READINESS_FENCE_V1_SCOPE_INACTIVE");
  }
}

function issueLock(
  scope: ReadinessFenceV1Scope,
  institutionId: number,
  revision: bigint,
): InstitutionReadinessFenceV1Lock {
  const lock = Object.freeze({ institutionId, revision });
  issuedLocks.set(lock, scope);
  return lock;
}

function assertIssuedLock(
  scope: ReadinessFenceV1Scope,
  lock: InstitutionReadinessFenceV1Lock,
): void {
  const owner = issuedLocks.get(lock);
  if (!owner) {
    throw new Error("READINESS_FENCE_V1_UNISSUED_LOCK");
  }
  if (owner !== scope) {
    throw new Error("READINESS_FENCE_V1_LOCK_TRANSACTION_MISMATCH");
  }
}

async function selectFenceForUpdate(
  tx: DbTransaction,
  scope: ReadinessFenceV1Scope,
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
  return issueLock(scope, rowInstitutionId, revision);
}

/**
 * Confere somente o recibo de instalação. Não é exportada porque esse recibo
 * não é prova de prontidão nem de saúde atual do catálogo/triggers.
 */
async function assertInstallationReceipt(
  tx: DbTransaction,
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

async function materializeAndLockInstitution(
  tx: DbTransaction,
  scope: ReadinessFenceV1Scope,
  institutionId: number,
): Promise<InstitutionReadinessFenceV1Lock> {
  assertInstitutionId(institutionId);
  await assertInstallationReceipt(tx);

  await tx
    .insert(institutionReadinessFences)
    .values({ institutionId })
    .onDuplicateKeyUpdate({
      set: { revision: sql`${institutionReadinessFences.revision}` },
    });
  return selectFenceForUpdate(tx, scope, institutionId);
}

async function assertInstitutionUnchanged(
  tx: DbTransaction,
  scope: ReadinessFenceV1Scope,
  expected: InstitutionReadinessFenceV1Lock,
): Promise<InstitutionReadinessFenceV1Lock> {
  assertIssuedLock(scope, expected);
  assertInstitutionId(expected.institutionId);
  if (typeof expected.revision !== "bigint" || expected.revision < 0n) {
    throw new TypeError("READINESS_FENCE_V1_INVALID_REVISION");
  }
  await assertInstallationReceipt(tx);
  const observed = await selectFenceForUpdate(
    tx,
    scope,
    expected.institutionId,
  );
  if (observed.revision !== expected.revision) {
    throw new Error("READINESS_FENCE_V1_CHANGED");
  }
  return observed;
}

/**
 * Abre e mantém a transação que materializa, bloqueia e relê a revisão.
 *
 * Esta é uma fundação técnica inativa: ela não calcula relatório, não recebe
 * snapshot do cliente e não autoriza publicação. O recibo verificado no
 * início é apenas pré-requisito de instalação; um futuro consumidor deve
 * validar catálogo e cobertura de triggers na mesma transação antes de usar
 * a revisão como parte de uma decisão de prontidão.
 *
 * A scope expira quando o callback termina e locks emitidos por ela não podem
 * ser reutilizados em outra transação. Nenhum helper público aceita um `tx`
 * estrutural, portanto um db em autocommit não pode simular essa garantia.
 */
export async function withReadinessFenceV1Transaction<T>(
  operation: (scope: ReadinessFenceV1Scope) => Promise<T> | T,
): Promise<T> {
  if (typeof operation !== "function") {
    throw new TypeError("READINESS_FENCE_V1_OPERATION_REQUIRED");
  }
  const db = await getDb();
  if (!db) {
    throw new Error("READINESS_FENCE_V1_DATABASE_UNAVAILABLE");
  }
  if (typeof db.transaction !== "function") {
    throw new Error("READINESS_FENCE_V1_TRANSACTION_UNAVAILABLE");
  }

  return db.transaction(async (tx) => {
    // O callback não começa sem o recibo técnico. A confirmação continua
    // sendo revalidada ao materializar e ao reler a revisão, sempre no mesmo
    // tx; isto não a transforma em autorização de prontidão.
    await assertInstallationReceipt(tx);
    let scope!: ReadinessFenceV1Scope;
    scope = Object.freeze({
      [readinessFenceV1ScopeBrand]: true as const,
      materializeAndLockInstitution: (institutionId: number) => {
        assertActiveScope(scope);
        return materializeAndLockInstitution(tx, scope, institutionId);
      },
      assertInstitutionUnchanged: (
        expected: InstitutionReadinessFenceV1Lock,
      ) => {
        assertActiveScope(scope);
        return assertInstitutionUnchanged(tx, scope, expected);
      },
    });
    issuedScopes.add(scope);
    activeScopes.add(scope);
    try {
      return await operation(scope);
    } finally {
      activeScopes.delete(scope);
    }
  });
}
