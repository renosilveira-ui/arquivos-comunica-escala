import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { googleOauthStates } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  openExternalCredential,
  sealExternalCredential,
} from "../../external-credentials-crypto";
import { EXTERNAL_PROVIDERS } from "../../../lib/integration-providers";
import {
  GOOGLE_CALENDAR_SCOPES,
  type OAuthTokenGrant,
} from "../providers/calendar-provider";
import {
  PROVIDER_FAILURE_REASONS,
  classifyHttpStatus,
  providerFailure,
  providerSuccess,
  type ProviderCallResult,
} from "../providers/types";

/**
 * OAuth 2 Authorization Code + PKCE contra o Google.
 *
 * Todo endpoint é constante deste módulo: nenhum caminho aceita URL vinda do
 * cliente, do banco ou de env — é o que fecha SSRF nesta superfície.
 *
 * O `state` é de uso único e tem TTL curto. O `code_verifier` do PKCE fica
 * selado em repouso: sem ele, quem lesse a tabela poderia completar a troca
 * de código no lugar do usuário.
 */

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const GOOGLE_OAUTH_HTTP_TIMEOUT_MS = 15_000;
/** Teto de autorizações simultâneas por conta; evita encher a tabela. */
export const GOOGLE_OAUTH_MAX_PENDING_PER_USER = 5;

/**
 * Para onde o navegador volta depois do callback. Allowlist fechada: o
 * cliente escolhe um rótulo, nunca uma URL. Sem isso o callback viraria
 * redirecionador aberto.
 */
export const GOOGLE_OAUTH_RETURN_TARGETS = {
  web: "WEB",
  mobile: "MOBILE",
} as const;

export type GoogleOAuthReturnTarget =
  (typeof GOOGLE_OAUTH_RETURN_TARGETS)[keyof typeof GOOGLE_OAUTH_RETURN_TARGETS];

export function isGoogleOAuthReturnTarget(
  value: unknown,
): value is GoogleOAuthReturnTarget {
  return value === "WEB" || value === "MOBILE";
}

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export class GoogleOAuthNotConfiguredError extends Error {
  constructor() {
    super("Integração com o Google não está configurada neste ambiente.");
    this.name = "GoogleOAuthNotConfiguredError";
  }
}

export function readGoogleOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleOAuthConfig | null {
  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const redirectUri = (env.GOOGLE_OAUTH_REDIRECT_URI ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  try {
    const parsed = new URL(redirectUri);
    if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  // 64 bytes → 86 chars base64url, dentro do intervalo 43–128 do RFC 7636.
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Comparação em tempo constante; state é segredo de curta duração. */
export function statesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type StartedAuthorization = {
  authorizationUrl: string;
  state: string;
  expiresAt: Date;
};

type OAuthDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Abre uma autorização: grava o estado e devolve a URL para o navegador.
 *
 * `prompt=consent` + `access_type=offline` são obrigatórios: sem os dois o
 * Google deixa de reemitir o refresh token em reautorizações, e o vínculo
 * nasce sem como se renovar.
 */
export async function startGoogleAuthorization(input: {
  db: OAuthDb;
  userId: number;
  returnTarget: GoogleOAuthReturnTarget;
  config: GoogleOAuthConfig;
  now?: Date;
}): Promise<StartedAuthorization> {
  const now = input.now ?? new Date();
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(32));
  const expiresAt = new Date(now.getTime() + GOOGLE_OAUTH_STATE_TTL_MS);
  const binding = {
    userId: input.userId,
    scope: EXTERNAL_PROVIDERS.googleCalendar,
  };

  await input.db.transaction(async (tx) => {
    // Higiene antes de inserir: estados vencidos não podem virar lastro nem
    // mascarar o teto por usuário.
    await tx
      .delete(googleOauthStates)
      .where(lt(googleOauthStates.expiresAt, now));

    const pending = await tx
      .select({ id: googleOauthStates.id })
      .from(googleOauthStates)
      .where(
        and(
          eq(googleOauthStates.userId, input.userId),
          isNull(googleOauthStates.consumedAt),
        ),
      )
      .orderBy(googleOauthStates.id)
      .limit(GOOGLE_OAUTH_MAX_PENDING_PER_USER + 1);

    // Mantém só as mais recentes: quem clicou "Conectar" cinco vezes não
    // pode impedir a sexta tentativa legítima.
    const excess = pending.length - GOOGLE_OAUTH_MAX_PENDING_PER_USER;
    for (let index = 0; index < excess; index += 1) {
      await tx
        .delete(googleOauthStates)
        .where(eq(googleOauthStates.id, pending[index].id));
    }

    await tx.insert(googleOauthStates).values({
      userId: input.userId,
      stateHash: hashOAuthState(state),
      sealedCodeVerifier: sealExternalCredential(verifier, binding),
      encryptionKid: "current",
      returnTarget: input.returnTarget,
      expiresAt,
    });
  });

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");

  return { authorizationUrl: url.toString(), state, expiresAt };
}

export type ConsumedAuthorization = {
  userId: number;
  codeVerifier: string;
  returnTarget: GoogleOAuthReturnTarget;
};

/**
 * Consome o state exatamente uma vez.
 *
 * O UPDATE condicional é a trava: dois callbacks com o mesmo state disputam a
 * mesma linha e só um vê `affectedRows = 1`. O outro recebe null e o fluxo
 * termina recusado — sem esse CAS, um state capturado poderia ser reusado.
 */
export async function consumeGoogleAuthorizationState(input: {
  db: OAuthDb;
  state: string;
  now?: Date;
}): Promise<ConsumedAuthorization | null> {
  const now = input.now ?? new Date();
  const stateHash = hashOAuthState(input.state);

  const [updated] = await input.db
    .update(googleOauthStates)
    .set({ consumedAt: now })
    .where(
      and(
        eq(googleOauthStates.stateHash, stateHash),
        isNull(googleOauthStates.consumedAt),
        sql`${googleOauthStates.expiresAt} > ${now}`,
      ),
    );

  if (!updated || updated.affectedRows !== 1) return null;

  const [row] = await input.db
    .select({
      userId: googleOauthStates.userId,
      sealedCodeVerifier: googleOauthStates.sealedCodeVerifier,
      returnTarget: googleOauthStates.returnTarget,
    })
    .from(googleOauthStates)
    .where(eq(googleOauthStates.stateHash, stateHash))
    .limit(1);

  if (!row || !isGoogleOAuthReturnTarget(row.returnTarget)) return null;

  try {
    const codeVerifier = openExternalCredential(row.sealedCodeVerifier, {
      userId: row.userId,
      scope: EXTERNAL_PROVIDERS.googleCalendar,
    });
    return {
      userId: row.userId,
      codeVerifier,
      returnTarget: row.returnTarget,
    };
  } catch {
    // Envelope ilegível (rotação incompleta, adulteração): fail-closed.
    return null;
  }
}

async function postForm(
  endpoint: string,
  body: URLSearchParams,
): Promise<ProviderCallResult<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GOOGLE_OAUTH_HTTP_TIMEOUT_MS,
  );
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return providerFailure(
        classifyHttpStatus(response.status),
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : undefined,
      );
    }
    const parsed = (await response.json()) as Record<string, unknown>;
    return providerSuccess(parsed);
  } catch (error) {
    // Nem a mensagem nem o corpo do erro atravessam: podem conter o code.
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    return providerFailure(
      aborted
        ? PROVIDER_FAILURE_REASONS.timeout
        : PROVIDER_FAILURE_REASONS.network,
    );
  } finally {
    clearTimeout(timer);
  }
}

function toGrant(
  payload: Record<string, unknown>,
  now: Date,
): OAuthTokenGrant | null {
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const seconds = typeof expiresIn === "number" ? expiresIn : 3600;
  const scope = typeof payload.scope === "string" ? payload.scope : "";
  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token
      ? payload.refresh_token
      : null;
  return {
    accessToken,
    refreshToken,
    // 60 s de folga: um token que expira durante a requisição em voo
    // produziria um 401 que seria classificado como credencial rejeitada.
    expiresAtUtc: new Date(now.getTime() + Math.max(0, seconds - 60) * 1000),
    grantedScopes: scope.split(" ").filter(Boolean),
  };
}

export async function exchangeGoogleAuthorizationCode(input: {
  config: GoogleOAuthConfig;
  code: string;
  codeVerifier: string;
  now?: Date;
}): Promise<ProviderCallResult<OAuthTokenGrant>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const result = await postForm(GOOGLE_TOKEN_ENDPOINT, body);
  if (!result.ok) return result;
  const grant = toGrant(result.value, input.now ?? new Date());
  if (!grant) {
    return providerFailure(PROVIDER_FAILURE_REASONS.invalidRequest);
  }
  if (!grant.refreshToken) {
    // Sem refresh token o vínculo nasce condenado: expira em uma hora e
    // exige reautorização manual. Melhor recusar e pedir consentimento de
    // novo do que gravar um vínculo que vai morrer em silêncio.
    return providerFailure(PROVIDER_FAILURE_REASONS.authRejected);
  }
  return providerSuccess(grant);
}

export async function refreshGoogleAccessToken(input: {
  config: GoogleOAuthConfig;
  refreshToken: string;
  now?: Date;
}): Promise<ProviderCallResult<OAuthTokenGrant>> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
  });
  const result = await postForm(GOOGLE_TOKEN_ENDPOINT, body);
  if (!result.ok) return result;
  const grant = toGrant(result.value, input.now ?? new Date());
  if (!grant) return providerFailure(PROVIDER_FAILURE_REASONS.invalidRequest);
  // O Google normalmente NÃO reemite refresh token na renovação; manter o
  // anterior é o comportamento correto, não um fallback.
  return providerSuccess({
    ...grant,
    refreshToken: grant.refreshToken ?? input.refreshToken,
  });
}

/**
 * Revoga no Google. Desconectar sem isto deixaria a autorização de pé na
 * conta do usuário — ele veria o Escala+ listado como app autorizado mesmo
 * depois de desvincular.
 */
export async function revokeGoogleToken(input: {
  refreshToken: string;
}): Promise<ProviderCallResult<null>> {
  const result = await postForm(
    GOOGLE_REVOKE_ENDPOINT,
    new URLSearchParams({ token: input.refreshToken }),
  );
  if (!result.ok) {
    // 400 do revoke significa "token já inválido": o objetivo foi atingido.
    if (result.reason === PROVIDER_FAILURE_REASONS.invalidRequest) {
      return providerSuccess(null);
    }
    return result;
  }
  return providerSuccess(null);
}

export { GOOGLE_AUTH_ENDPOINT, GOOGLE_TOKEN_ENDPOINT, GOOGLE_REVOKE_ENDPOINT };
