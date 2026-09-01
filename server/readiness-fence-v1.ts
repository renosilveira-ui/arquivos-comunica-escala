import { sql } from "drizzle-orm";
import {
  institutionReadinessFenceEvents,
  institutionReadinessFenceInstallations,
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
type SqlExecutor = Pick<Db, "execute">;

export type InstitutionReadinessFenceV1HighWatermark = Readonly<{
  institutionId: number;
  eventId: bigint;
}>;

type ReadinessFenceV1InstallationReceipt = Readonly<{
  installationId: number;
  coverageVersion: string;
  coverageHash: string;
}>;

const MAX_MYSQL_SIGNED_INT = 2_147_483_647;
const EVENT_RANGE_INDEX = sql.raw("`idx_rdf_event_institution_id`");
// Em READ COMMITTED, o InnoDB não conserva o gap lock vazio necessário para
// impedir o próximo INSERT no intervalo. A decisão final pede RR apenas para
// a sua transação curta; nunca altera a configuração da pool/sessão geral.
const FINAL_DECISION_TRANSACTION_CONFIG = {
  isolationLevel: "repeatable read",
} as const;
const issuedHighWatermarks = new WeakSet<object>();
const consumedHighWatermarks = new WeakSet<object>();

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

function parseEventId(value: unknown): bigint | null {
  try {
    const eventId =
      typeof value === "bigint"
        ? value
        : typeof value === "number"
          ? Number.isSafeInteger(value)
            ? BigInt(value)
            : null
          : typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
            ? BigInt(value)
            : null;
    return eventId !== null && eventId >= 0n ? eventId : null;
  } catch {
    return null;
  }
}

function assertIssuedHighWatermark(
  highWatermark: InstitutionReadinessFenceV1HighWatermark,
): void {
  if (
    !highWatermark ||
    typeof highWatermark !== "object" ||
    !issuedHighWatermarks.has(highWatermark)
  ) {
    throw new Error("READINESS_FENCE_V1_UNISSUED_HIGH_WATERMARK");
  }
  if (consumedHighWatermarks.has(highWatermark)) {
    throw new Error("READINESS_FENCE_V1_HIGH_WATERMARK_CONSUMED");
  }
  assertInstitutionId(highWatermark.institutionId);
  if (typeof highWatermark.eventId !== "bigint" || highWatermark.eventId < 0n) {
    throw new TypeError("READINESS_FENCE_V1_INVALID_HIGH_WATERMARK");
  }
}

/**
 * Confere somente o recibo de instalação. Não representa prontidão nem
 * certifica o catálogo/triggers atuais; um consumidor futuro continua
 * responsável por essas verificações na mesma transação da decisão.
 */
async function assertInstallationReceipt(
  executor: SqlExecutor,
  lockForFinalDecision: boolean,
): Promise<ReadinessFenceV1InstallationReceipt> {
  const result = lockForFinalDecision
    ? await executor.execute(sql`
        SELECT ${institutionReadinessFenceInstallations.id} AS installationId,
               ${institutionReadinessFenceInstallations.coverageVersion} AS coverageVersion,
               ${institutionReadinessFenceInstallations.coverageHash} AS coverageHash
        FROM ${institutionReadinessFenceInstallations}
        ORDER BY ${institutionReadinessFenceInstallations.id}
        LOCK IN SHARE MODE
      `)
    : await executor.execute(sql`
        SELECT ${institutionReadinessFenceInstallations.id} AS installationId,
               ${institutionReadinessFenceInstallations.coverageVersion} AS coverageVersion,
               ${institutionReadinessFenceInstallations.coverageHash} AS coverageHash
        FROM ${institutionReadinessFenceInstallations}
        ORDER BY ${institutionReadinessFenceInstallations.id}
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
 * Captura uma observação imutável do último evento já confirmado para a
 * instituição. A observação não é aprovação e pode ficar velha a qualquer
 * instante; ela só pode ser consumida uma vez no fechamento transacional.
 */
export async function captureInstitutionReadinessFenceV1HighWatermark(
  institutionId: number,
): Promise<InstitutionReadinessFenceV1HighWatermark> {
  assertInstitutionId(institutionId);
  const db = await getDb();
  if (!db) {
    throw new Error("READINESS_FENCE_V1_DATABASE_UNAVAILABLE");
  }

  await assertInstallationReceipt(db, false);
  const result = await db.execute(sql`
    SELECT COALESCE(MAX(${institutionReadinessFenceEvents.id}), 0) AS eventId
    FROM ${institutionReadinessFenceEvents}
    WHERE ${institutionReadinessFenceEvents.institutionId} = ${institutionId}
  `);
  const [row] = rowsFromExecute<{ eventId: bigint | number | string }>(result);
  const eventId = parseEventId(row?.eventId);
  if (eventId === null) {
    throw new Error("READINESS_FENCE_V1_HIGH_WATERMARK_INTEGRITY_FAILURE");
  }
  const highWatermark = Object.freeze({ institutionId, eventId });
  issuedHighWatermarks.add(highWatermark);
  return highWatermark;
}

async function assertNoEventsAfterHighWatermark(
  tx: DbTransaction,
  highWatermark: InstitutionReadinessFenceV1HighWatermark,
): Promise<void> {
  const result = await tx.execute(sql`
    SELECT ${institutionReadinessFenceEvents.id} AS eventId
    FROM ${institutionReadinessFenceEvents} FORCE INDEX (${EVENT_RANGE_INDEX})
    WHERE ${institutionReadinessFenceEvents.institutionId} = ${highWatermark.institutionId}
      AND ${institutionReadinessFenceEvents.id} > ${highWatermark.eventId}
    FOR UPDATE
  `);
  const rows = rowsFromExecute<{ eventId: bigint | number | string }>(result);
  for (const row of rows) {
    if (parseEventId(row.eventId) === null) {
      throw new Error("READINESS_FENCE_V1_HIGH_WATERMARK_INTEGRITY_FAILURE");
    }
  }
  if (rows.length !== 0) {
    throw new Error("READINESS_FENCE_V1_STALE");
  }
}

/**
 * Executa o curtíssimo fechamento de uma decisão futura de prontidão.
 *
 * `lockNormalResources` recebe a transação real primeiro e deve adquirir
 * nela os locks usuais do recurso (escala, alocação, publicação etc.). Só
 * depois o helper valida o recibo e faz um locking read da faixa
 * `(institution_id, id > high-watermark)`. Uma mutação posterior da mesma
 * instituição espera até o commit/rollback da decisão final, sem criar uma
 * trava de fence longa ou inverter a ordem dos locks normais.
 *
 * A API não entrega uma scope nem uma `Promise` interna ao consumidor: isso
 * impede commit enquanto uma finalização disparada sem `await` ainda usa a
 * transação. A V1 continua inativa: não calcula relatório, não publica escala
 * e não aceita snapshot ou ciência do cliente.
 */
export async function withReadinessFenceV1FinalDecisionTransaction<
  TPrepared,
  TResult,
>(
  highWatermark: InstitutionReadinessFenceV1HighWatermark,
  lockNormalResources: (tx: DbTransaction) => Promise<TPrepared> | TPrepared,
  decide: (
    tx: DbTransaction,
    prepared: TPrepared,
  ) => Promise<TResult> | TResult,
): Promise<TResult> {
  if (
    typeof lockNormalResources !== "function" ||
    typeof decide !== "function"
  ) {
    throw new TypeError("READINESS_FENCE_V1_FINALIZATION_CALLBACK_REQUIRED");
  }
  assertIssuedHighWatermark(highWatermark);

  const db = await getDb();
  if (!db) {
    throw new Error("READINESS_FENCE_V1_DATABASE_UNAVAILABLE");
  }
  if (typeof db.transaction !== "function") {
    throw new Error("READINESS_FENCE_V1_TRANSACTION_UNAVAILABLE");
  }
  consumedHighWatermarks.add(highWatermark);

  return db.transaction(async (tx) => {
    const prepared = await lockNormalResources(tx);
    await assertInstallationReceipt(tx, true);
    await assertNoEventsAfterHighWatermark(tx, highWatermark);
    return await decide(tx, prepared);
  }, FINAL_DECISION_TRANSACTION_CONFIG);
}
