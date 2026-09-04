// server/_core/canonical-operational-actor.ts
//
// Primitive interna channel-agnostic: userId já autenticado → identidade
// profissional canônica + instituições com vínculo operacional válido.
//
// Não é um ator exclusivo de canal. App, web, WhatsApp, voz e API futura
// devem obter a mesma identidade/topologia para o mesmo userId.
//
// Input `userId` NÃO é público nem vem de mensagem. O caller (futuro
// B2-C no WhatsApp, voz, tRPC) obtém o userId exclusivamente da fronteira
// autenticada — no WhatsApp, o inbound/pending já vinculado pelo gate
// de identidade. Esta primitive não lê telefone, texto nem pending.
//
// Não escolhe instituição, setor, plantão ou colega. Múltiplos vínculos
// ativos são sucesso: devolve [A, B, C] ordenados. Quem escolhe o tenant
// relevante é camada posterior (ex.: resolveSwapIntent a partir do plantão).
//
// Leitura: UMA SELECT com LEFT JOINs (users ⟕ professionals ⟕
// professional_institutions ⟕ institutions). Snapshot coerente sem
// transação extra — não há escrita, e duas queries abertas permitiriam
// um ator impossível se membership mudasse no intervalo.
//
// Snapshot ≠ autorização. Mudança posterior de membership não fica
// autorizada por este resultado. O resolver de intenção e o domínio de
// oferta revalidam o que lhes compete.
//
// Autoridade de membership (a mesma de listActiveInstitutionIdsForUser
// e resolveTenantActor): professional_institutions.active + casamento
// professionalId/userId + users APPROVED e deletedAt null + institution
// isActive. professional_access e manager_scope NÃO concedem tenant.
// Papel (USER / GESTOR_*) NÃO cria identidade nem tenant.
//
// Cardinalidade: professionals.user_id NÃO tem UNIQUE. 0 profissionais
// e >1 profissional são estruturalmente possíveis. Nunca escolhe o
// primeiro de um empate.

import { and, eq, isNull } from "drizzle-orm";
import {
  institutions,
  professionalInstitutions,
  professionals,
  users,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { logger } from "./logger";

/** Identidade clínica + topologia institucional. Espelha SwapIntentActor. */
export type CanonicalOperationalActor = {
  userId: number;
  professionalId: number;
  institutionIds: number[];
};

export type CanonicalOperationalActorFailureCode =
  | "DB_UNAVAILABLE"
  | "PERSISTENCE_FAILED"
  | "ACTOR_NOT_FOUND"
  | "ACTOR_PROFESSIONAL_NOT_FOUND"
  | "ACTOR_PROFESSIONAL_AMBIGUOUS"
  | "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND";

export type CanonicalOperationalActorResolution =
  | { ok: true; actor: CanonicalOperationalActor }
  | { ok: false; code: CanonicalOperationalActorFailureCode };

export function isCanonicalOperationalActorInfraFailure(
  result: CanonicalOperationalActorResolution,
): result is {
  ok: false;
  code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED";
} {
  return (
    result.ok === false &&
    (result.code === "DB_UNAVAILABLE" || result.code === "PERSISTENCE_FAILED")
  );
}

const LOG_EVENT = "canonical_operational_actor_resolved";

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function uniqueSortedPositiveIds(
  ids: readonly (number | null | undefined)[],
): number[] {
  const unique = new Set<number>();
  for (const id of ids) {
    if (isPositiveInt(id)) unique.add(id);
  }
  return [...unique].sort((left, right) => left - right);
}

function logResolution(fields: {
  userId?: number;
  resultCode: string;
  institutionCount: number;
  professionalId?: number;
}): void {
  logger.info(
    JSON.stringify({
      event: LOG_EVENT,
      ...(isPositiveInt(fields.userId) ? { userId: fields.userId } : {}),
      resultCode: fields.resultCode,
      institutionCount: fields.institutionCount,
      ...(isPositiveInt(fields.professionalId)
        ? { professionalId: fields.professionalId }
        : {}),
    }),
  );
}

function fail(
  code: CanonicalOperationalActorFailureCode,
  userId?: number,
): CanonicalOperationalActorResolution {
  logResolution({ userId, resultCode: code, institutionCount: 0 });
  return { ok: false, code };
}

type ActorSnapshotRow = {
  userId: number;
  approvalStatus: "PENDING" | "APPROVED";
  deletedAt: Date | null;
  professionalId: number | null;
  institutionId: number | null;
};

function interpretSnapshot(
  userId: number,
  rows: readonly ActorSnapshotRow[],
): CanonicalOperationalActorResolution {
  if (rows.length === 0) return fail("ACTOR_NOT_FOUND", userId);

  const head = rows[0];
  if (head.approvalStatus !== "APPROVED" || head.deletedAt != null) {
    return fail("ACTOR_NOT_FOUND", userId);
  }

  const professionalIds = uniqueSortedPositiveIds(
    rows.map((row) => row.professionalId),
  );
  if (professionalIds.length === 0) {
    return fail("ACTOR_PROFESSIONAL_NOT_FOUND", userId);
  }
  if (professionalIds.length > 1) {
    return fail("ACTOR_PROFESSIONAL_AMBIGUOUS", userId);
  }

  const institutionIds = uniqueSortedPositiveIds(
    rows.map((row) => row.institutionId),
  );
  if (institutionIds.length === 0) {
    return fail("ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND", userId);
  }

  const professionalId = professionalIds[0];
  logResolution({
    userId,
    resultCode: "OK",
    institutionCount: institutionIds.length,
    // Surrogate interno: diagnostica qual linha de professionals foi
    // ligada quando B2-C alimentar resolveSwapIntent. Não é PII.
    professionalId,
  });
  return {
    ok: true,
    actor: { userId, professionalId, institutionIds },
  };
}

/**
 * Resolve a identidade profissional canônica e os tenants operacionais
 * válidos do usuário. Read-only. Fail-closed. Sem escolha de instituição.
 */
export async function resolveCanonicalOperationalActorForUser(input: {
  userId: number;
}): Promise<CanonicalOperationalActorResolution> {
  const userId = input?.userId;
  if (!isPositiveInt(userId)) {
    return fail("ACTOR_NOT_FOUND");
  }

  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch {
    return fail("PERSISTENCE_FAILED", userId);
  }
  if (!db) {
    return fail("DB_UNAVAILABLE", userId);
  }

  try {
    const rows = await db
      .select({
        userId: users.id,
        approvalStatus: users.approvalStatus,
        deletedAt: users.deletedAt,
        professionalId: professionals.id,
        institutionId: institutions.id,
      })
      .from(users)
      .leftJoin(professionals, eq(professionals.userId, users.id))
      .leftJoin(
        professionalInstitutions,
        and(
          eq(professionalInstitutions.professionalId, professionals.id),
          eq(professionalInstitutions.userId, users.id),
          eq(professionalInstitutions.active, true),
        ),
      )
      .leftJoin(
        institutions,
        and(
          eq(institutions.id, professionalInstitutions.institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .where(
        and(
          eq(users.id, userId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      );

    return interpretSnapshot(userId, rows);
  } catch {
    return fail("PERSISTENCE_FAILED", userId);
  }
}
