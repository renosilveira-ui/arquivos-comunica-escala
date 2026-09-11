import { and, eq, sql } from "drizzle-orm";

import { userExternalCredentials } from "../../../drizzle/schema";
import {
  EXTERNAL_LINK_STATES,
  EXTERNAL_PROVIDERS,
  PROVIDER_OUTCOMES,
  canAttemptSync,
  nextExternalLinkState,
  type ExternalLinkState,
  type ProviderOutcome,
} from "../../../lib/integration-providers";
import { getDb } from "../../db";
import {
  openExternalCredential,
  sealExternalCredential,
} from "../../external-credentials-crypto";
import type { OAuthTokenGrant } from "../providers/calendar-provider";
import {
  PROVIDER_FAILURE_REASONS,
  providerFailure,
  providerSuccess,
  type ProviderCallResult,
  type ProviderFailureReason,
} from "../providers/types";

/**
 * Estado do vínculo da CONTA com o Google Agenda.
 *
 * Toda transição é CAS sobre `version`: duas abas do médico, ou o worker e a
 * tela ao mesmo tempo, não podem sobrescrever uma a decisão da outra. Quem
 * perde a corrida não falha — relê e segue, porque a intenção (conectado,
 * degradado, precisa reautenticar) é convergente.
 *
 * O refresh token nunca sai daqui em claro: `withGoogleAccessToken` abre o
 * envelope, troca por um access token efêmero e o entrega ao chamador. O
 * access token não é persistido em lugar nenhum.
 */

const PROVIDER = EXTERNAL_PROVIDERS.googleCalendar;

type LinkDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type GoogleLinkSnapshot = {
  linkState: ExternalLinkState;
  externalCalendarId: string | null;
  /** Escopos que o Google de fato concedeu, separados por espaço. */
  grantedScopes: string | null;
  syncCursor: string | null;
  lastSyncedAt: Date | null;
  lastFailureReason: string | null;
  consecutiveFailureCount: number;
  connectedAt: Date | null;
  version: number;
  /** Rótulo da conta externa, aberto sob demanda. Nunca sai em consulta em lote. */
  accountLabel: string | null;
};

function binding(userId: number) {
  return { userId, scope: PROVIDER } as const;
}

export async function readGoogleLink(
  db: LinkDb,
  userId: number,
): Promise<GoogleLinkSnapshot | null> {
  const [row] = await db
    .select({
      linkState: userExternalCredentials.linkState,
      externalCalendarId: userExternalCredentials.externalCalendarId,
      grantedScopes: userExternalCredentials.grantedScopes,
      syncCursor: userExternalCredentials.syncCursor,
      lastSyncedAt: userExternalCredentials.lastSyncedAt,
      lastFailureReason: userExternalCredentials.lastFailureReason,
      consecutiveFailureCount: userExternalCredentials.consecutiveFailureCount,
      connectedAt: userExternalCredentials.connectedAt,
      version: userExternalCredentials.version,
      sealedAccountLabel: userExternalCredentials.sealedAccountLabel,
    })
    .from(userExternalCredentials)
    .where(
      and(
        eq(userExternalCredentials.userId, userId),
        eq(userExternalCredentials.provider, PROVIDER),
      ),
    )
    .limit(1);

  if (!row) return null;

  let accountLabel: string | null = null;
  if (row.sealedAccountLabel) {
    try {
      accountLabel = openExternalCredential(
        row.sealedAccountLabel,
        binding(userId),
      );
    } catch {
      // Envelope ilegível não pode derrubar a tela de status: o vínculo
      // continua existindo, só não sabemos o rótulo.
      accountLabel = null;
    }
  }

  return {
    linkState: row.linkState as ExternalLinkState,
    externalCalendarId: row.externalCalendarId,
    grantedScopes: row.grantedScopes,
    syncCursor: row.syncCursor,
    lastSyncedAt: row.lastSyncedAt,
    lastFailureReason: row.lastFailureReason,
    consecutiveFailureCount: row.consecutiveFailureCount,
    connectedAt: row.connectedAt,
    version: row.version,
    accountLabel,
  };
}

/**
 * Grava (ou regrava) o vínculo depois de uma autorização bem-sucedida.
 *
 * Idempotente por `(user_id, provider)`: reconectar substitui o envelope e
 * zera o contador de falhas, sem criar uma segunda linha. O cursor de sync é
 * deliberadamente apagado — a conta pode ser outra, e reaproveitar o cursor
 * antigo pediria mudanças de um calendário que não é mais o mesmo.
 */
export async function persistGoogleAuthorization(input: {
  db: LinkDb;
  userId: number;
  grant: OAuthTokenGrant;
  accountLabel: string | null;
  externalCalendarId: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const refreshToken = input.grant.refreshToken;
  if (!refreshToken) {
    throw new Error("GOOGLE_LINK_REQUIRES_REFRESH_TOKEN");
  }
  const own = binding(input.userId);
  const sealedRefreshToken = sealExternalCredential(refreshToken, own);
  const sealedAccountLabel = input.accountLabel
    ? sealExternalCredential(input.accountLabel, own)
    : null;

  await input.db
    .insert(userExternalCredentials)
    .values({
      userId: input.userId,
      provider: PROVIDER,
      linkState: EXTERNAL_LINK_STATES.connected,
      sealedRefreshToken,
      sealedAccountLabel,
      encryptionKid: "current",
      grantedScopes: input.grant.grantedScopes.join(" "),
      externalCalendarId: input.externalCalendarId,
      syncCursor: null,
      lastFailureReason: null,
      consecutiveFailureCount: 0,
      connectedAt: now,
      disconnectedAt: null,
    })
    .onDuplicateKeyUpdate({
      set: {
        linkState: EXTERNAL_LINK_STATES.connected,
        sealedRefreshToken,
        sealedAccountLabel,
        encryptionKid: "current",
        grantedScopes: input.grant.grantedScopes.join(" "),
        externalCalendarId: input.externalCalendarId,
        syncCursor: null,
        lastFailureReason: null,
        consecutiveFailureCount: 0,
        connectedAt: now,
        disconnectedAt: null,
        version: sql`${userExternalCredentials.version} + 1`,
      },
    });
}

/**
 * Registra o resultado de uma operação contra o provedor.
 *
 * A decisão de estado vem de `nextExternalLinkState`, função pura e testada:
 * nenhum chamador escolhe sozinho o que "falhou" significa para o vínculo.
 */
export async function recordGoogleOutcome(input: {
  db: LinkDb;
  userId: number;
  outcome: ProviderOutcome;
  reason?: ProviderFailureReason;
  now?: Date;
}): Promise<ExternalLinkState | null> {
  const now = input.now ?? new Date();
  const current = await readGoogleLink(input.db, input.userId);
  if (!current) return null;

  const next = nextExternalLinkState(current.linkState, input.outcome);
  const success = input.outcome === PROVIDER_OUTCOMES.success;

  const [updated] = await input.db
    .update(userExternalCredentials)
    .set({
      linkState: next,
      lastFailureReason: success ? null : (input.reason ?? null),
      consecutiveFailureCount: success
        ? 0
        : sql`${userExternalCredentials.consecutiveFailureCount} + 1`,
      ...(success ? { lastSyncedAt: now } : {}),
      // Explícito, não `ON UPDATE`: a cadência do cron mede "última mudança
      // do vínculo" a partir daqui, e precisa do mesmo relógio que o tick.
      updatedAt: now,
      ...(next === EXTERNAL_LINK_STATES.disconnected
        ? { disconnectedAt: now, sealedRefreshToken: null, syncCursor: null }
        : {}),
      version: sql`${userExternalCredentials.version} + 1`,
    })
    .where(
      and(
        eq(userExternalCredentials.userId, input.userId),
        eq(userExternalCredentials.provider, PROVIDER),
        // CAS: se outra execução já mudou o estado, esta desiste em silêncio.
        eq(userExternalCredentials.version, current.version),
      ),
    );

  return updated && updated.affectedRows === 1 ? next : null;
}

export async function saveGoogleSyncCursor(input: {
  db: LinkDb;
  userId: number;
  cursor: string | null;
  now?: Date;
}): Promise<void> {
  await input.db
    .update(userExternalCredentials)
    .set({
      syncCursor: input.cursor,
      lastSyncedAt: input.now ?? new Date(),
      version: sql`${userExternalCredentials.version} + 1`,
    })
    .where(
      and(
        eq(userExternalCredentials.userId, input.userId),
        eq(userExternalCredentials.provider, PROVIDER),
      ),
    );
}

/**
 * Entrega um access token fresco ao chamador.
 *
 * O refresh acontece a cada uso: um access token vale uma hora, e persistir
 * para reaproveitar só ampliaria a janela de vazamento sem ganho real — a
 * chamada de refresh é barata perto do trabalho que vem depois.
 *
 * Se o provedor rejeitar a credencial, o vínculo cai para `REAUTH_REQUIRED`
 * aqui mesmo: quem chamou não precisa saber classificar isso.
 *
 * `refresh` é injetado de propósito, e não importado direto do módulo do
 * Google. Chamar a implementação real aqui dentro tornaria esta função — e
 * todo o motor de sincronização acima dela — impossível de exercitar sem
 * rede, e faria a interface de provedor existir sem ser respeitada.
 */
export async function withGoogleAccessToken<T>(input: {
  db: LinkDb;
  userId: number;
  refresh: (
    refreshToken: string,
  ) => Promise<ProviderCallResult<OAuthTokenGrant>>;
  run: (accessToken: string, link: GoogleLinkSnapshot) => Promise<T>;
}): Promise<ProviderCallResult<T>> {
  const link = await readGoogleLink(input.db, input.userId);
  if (!link || !canAttemptSync(link.linkState)) {
    return providerFailure(PROVIDER_FAILURE_REASONS.authRejected);
  }

  const [row] = await input.db
    .select({ sealed: userExternalCredentials.sealedRefreshToken })
    .from(userExternalCredentials)
    .where(
      and(
        eq(userExternalCredentials.userId, input.userId),
        eq(userExternalCredentials.provider, PROVIDER),
      ),
    )
    .limit(1);

  if (!row?.sealed) {
    await recordGoogleOutcome({
      db: input.db,
      userId: input.userId,
      outcome: PROVIDER_OUTCOMES.authRejected,
      reason: PROVIDER_FAILURE_REASONS.authRejected,
    });
    return providerFailure(PROVIDER_FAILURE_REASONS.authRejected);
  }

  let refreshToken: string;
  try {
    refreshToken = openExternalCredential(row.sealed, binding(input.userId));
  } catch {
    // Envelope que não abre é credencial perdida — só reautorizar resolve.
    await recordGoogleOutcome({
      db: input.db,
      userId: input.userId,
      outcome: PROVIDER_OUTCOMES.authRejected,
      reason: PROVIDER_FAILURE_REASONS.authRejected,
    });
    return providerFailure(PROVIDER_FAILURE_REASONS.authRejected);
  }

  const refreshed = await input.refresh(refreshToken);
  if (!refreshed.ok) {
    await recordGoogleOutcome({
      db: input.db,
      userId: input.userId,
      outcome: refreshed.outcome,
      reason: refreshed.reason,
    });
    return refreshed;
  }

  try {
    const value = await input.run(refreshed.value.accessToken, link);
    return providerSuccess(value);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "CalendarUnavailableError" &&
      "reason" in error
    ) {
      return providerFailure(
        (error as { reason: ProviderFailureReason }).reason,
      );
    }
    throw error;
  }
}

/**
 * Desvincula: revoga no Google e apaga o envelope.
 *
 * A ordem importa. Revogar primeiro e só então apagar garante que, se a
 * revogação falhar, ainda temos o token para tentar de novo. Apagar primeiro
 * deixaria a autorização viva na conta do usuário sem ninguém para revogá-la.
 */
export async function disconnectGoogleLink(input: {
  db: LinkDb;
  userId: number;
  revoke: (refreshToken: string) => Promise<ProviderCallResult<null>>;
  now?: Date;
}): Promise<{ revoked: boolean }> {
  const now = input.now ?? new Date();
  const [row] = await input.db
    .select({ sealed: userExternalCredentials.sealedRefreshToken })
    .from(userExternalCredentials)
    .where(
      and(
        eq(userExternalCredentials.userId, input.userId),
        eq(userExternalCredentials.provider, PROVIDER),
      ),
    )
    .limit(1);

  let revoked = false;
  if (row?.sealed) {
    try {
      const refreshToken = openExternalCredential(
        row.sealed,
        binding(input.userId),
      );
      const result = await input.revoke(refreshToken);
      revoked = result.ok;
    } catch {
      // Sem token legível não há o que revogar; seguimos para a limpeza —
      // deixar a linha de pé seria pior.
      revoked = false;
    }
  }

  await input.db
    .update(userExternalCredentials)
    .set({
      linkState: EXTERNAL_LINK_STATES.disconnected,
      sealedRefreshToken: null,
      sealedAccountLabel: null,
      encryptionKid: null,
      grantedScopes: null,
      syncCursor: null,
      externalCalendarId: null,
      lastFailureReason: null,
      consecutiveFailureCount: 0,
      disconnectedAt: now,
      version: sql`${userExternalCredentials.version} + 1`,
    })
    .where(
      and(
        eq(userExternalCredentials.userId, input.userId),
        eq(userExternalCredentials.provider, PROVIDER),
      ),
    );

  return { revoked };
}
