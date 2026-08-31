import { sql } from "drizzle-orm";
import {
  institutionReadinessFenceInstallations,
  institutionReadinessFences,
} from "../drizzle/schema";
import { rowsFromExecute } from "./_core/db-results";
import type { getDb } from "./db";
import {
  READINESS_FENCE_COVERAGE_HASH,
  READINESS_FENCE_COVERAGE_VERSION,
  READINESS_FENCE_INSTALLATION_ID,
} from "./readiness-fence-contract";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Só use dentro do callback de `db.transaction`. A garantia da fence depende
 * do lock sobreviver da leitura do relatório até a decisão que o consome.
 */
export type ReadinessFenceTransaction = Pick<
  DbTransaction,
  "execute" | "insert"
>;

export type InstitutionReadinessFenceLock = Readonly<{
  institutionId: number;
  revision: bigint;
}>;

const MAX_MYSQL_SIGNED_INT = 2_147_483_647;
const issuedFenceLocks = new WeakSet<object>();

function assertInstitutionId(institutionId: number): void {
  if (
    !Number.isSafeInteger(institutionId) ||
    institutionId <= 0 ||
    institutionId > MAX_MYSQL_SIGNED_INT
  ) {
    throw new TypeError("READINESS_FENCE_INVALID_INSTITUTION");
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

function parseInstallationId(value: unknown): number | null {
  return parseInstitutionId(value) === READINESS_FENCE_INSTALLATION_ID
    ? READINESS_FENCE_INSTALLATION_ID
    : null;
}

function freezeFence(
  institutionId: number,
  revision: bigint,
): InstitutionReadinessFenceLock {
  const fence = Object.freeze({ institutionId, revision });
  issuedFenceLocks.add(fence);
  return fence;
}

function assertIssuedFenceLock(fence: InstitutionReadinessFenceLock): void {
  if (!issuedFenceLocks.has(fence)) {
    throw new Error("READINESS_FENCE_UNISSUED_LOCK");
  }
}

function assertFenceRevision(revision: bigint): void {
  if (typeof revision !== "bigint" || revision < 0n) {
    throw new TypeError("READINESS_FENCE_INVALID_REVISION");
  }
}

async function selectFenceForUpdate(
  tx: ReadinessFenceTransaction,
  institutionId: number,
): Promise<InstitutionReadinessFenceLock> {
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
    throw new Error("READINESS_FENCE_INTEGRITY_FAILURE");
  }
  return freezeFence(rowInstitutionId, revision);
}

/**
 * Garante que a cobertura de origem foi instalada integralmente. A migration
 * pode sofrer commit parcial de DDL no MySQL; por isso o marcador só é escrito
 * depois do pós-voo dos triggers e torna a ausência parcial uma falha fechada.
 */
export type ReadinessFenceInstallationReceipt = Readonly<{
  installationId: number;
  coverageVersion: string;
  coverageHash: string;
}>;

export async function assertCompleteReadinessFenceInstallation(
  tx: ReadinessFenceTransaction,
): Promise<ReadinessFenceInstallationReceipt> {
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
    parseInstallationId(row?.installationId) !==
      READINESS_FENCE_INSTALLATION_ID ||
    row?.coverageVersion !== READINESS_FENCE_COVERAGE_VERSION ||
    row?.coverageHash !== READINESS_FENCE_COVERAGE_HASH
  ) {
    throw new Error("READINESS_FENCE_INSTALLATION_UNVERIFIED");
  }
  return Object.freeze({
    installationId: READINESS_FENCE_INSTALLATION_ID,
    coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_COVERAGE_HASH,
  });
}

/**
 * Materializa uma única linha por tenant e a bloqueia para a transação atual.
 *
 * Não cria ou altera nenhuma fonte de prontidão. Se a instituição não existir,
 * a FK faz a operação falhar; se a linha não puder ser relida de modo canônico,
 * a função falha fechada. Uma mutation concorrente de uma fonte de prontidão
 * precisa atualizar essa mesma linha via trigger e, portanto, espera este lock.
 *
 * Contrato da integração futura de publicação: na mesma transação, adquirir
 * esta fence, calcular o relatório canônico, validar sua ciência localmente e
 * persistir de modo privado o `snapshotHash` daquele relatório com esta
 * `revision` e o contrato de cobertura. Depois, releia a fence antes de mudar
 * o roster. Esta fundação não expõe uma fábrica genérica de receipt para que
 * nenhum hash sem proveniência do relatório possa ganhar autoridade.
 */
export async function materializeAndLockInstitutionReadinessFence(
  tx: ReadinessFenceTransaction,
  institutionId: number,
): Promise<InstitutionReadinessFenceLock> {
  assertInstitutionId(institutionId);
  await assertCompleteReadinessFenceInstallation(tx);

  // O no-op do duplicate key elimina a corrida de criação sem incrementar a
  // revisão. Somente triggers de fontes do diagnóstico podem avançá-la.
  await tx
    .insert(institutionReadinessFences)
    .values({ institutionId, revision: 0n })
    .onDuplicateKeyUpdate({
      set: { revision: sql`${institutionReadinessFences.revision}` },
    });

  return selectFenceForUpdate(tx, institutionId);
}

/**
 * Releia antes da decisão final caso o próprio fluxo tenha executado uma
 * mutation de fonte após o snapshot. Em uso normal o lock torna uma mudança
 * concorrente impossível até o commit; uma divergência aqui é sempre falha.
 */
export async function assertInstitutionReadinessFenceUnchanged(
  tx: ReadinessFenceTransaction,
  expected: InstitutionReadinessFenceLock,
): Promise<InstitutionReadinessFenceLock> {
  assertIssuedFenceLock(expected);
  assertInstitutionId(expected.institutionId);
  assertFenceRevision(expected.revision);
  await assertCompleteReadinessFenceInstallation(tx);

  const observed = await selectFenceForUpdate(tx, expected.institutionId);
  if (observed.revision !== expected.revision) {
    throw new Error("READINESS_FENCE_CHANGED");
  }
  return observed;
}
