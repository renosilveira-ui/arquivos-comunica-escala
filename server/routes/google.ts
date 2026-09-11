import { Router, type Request, type Response } from "express";

import { logger } from "../_core/logger";
import { resolveTrustedPublicBaseUrl } from "../_core/public-url";
import { getDb } from "../db";
import { createGoogleCalendarProvider } from "../integrations/google/calendar-client";
import { persistGoogleAuthorization } from "../integrations/google/link-service";
import {
  consumeGoogleAuthorizationState,
  exchangeGoogleAuthorizationCode,
  readGoogleOAuthConfig,
  revokeGoogleToken,
  type GoogleOAuthReturnTarget,
} from "../integrations/google/oauth";
import { canCreateDedicatedCalendar } from "../integrations/providers/calendar-provider";
import { resolveUserTimeZone } from "../institution-time-zone";

/**
 * Callback do OAuth do Google.
 *
 * Este endpoint é PÚBLICO por natureza — quem chega aqui vem do navegador,
 * depois de passar pelo Google, e pode não ter sessão nossa no cookie. A
 * autoridade não vem da sessão: vem do `state`, que é de uso único, tem TTL
 * curto e carrega, selado, o `code_verifier` do PKCE.
 *
 * Consequência de segurança que vale escrever: sem o CAS de consumo do state,
 * qualquer um que capturasse a URL de retorno poderia vincular a PRÓPRIA
 * conta do Google ao usuário nosso — ou repetir o callback para forçar
 * reautorizações. O `state` é a fronteira inteira.
 *
 * Nenhum parâmetro da query escolhe destino de redirecionamento. O destino
 * sai de uma allowlist guardada junto do state.
 */

const CALLBACK_PATH = "/api/integrations/google/callback";
const MOBILE_SCHEME = "escalas";

export const googleRouter: Router = Router();

/** Resultado que o app lê na volta. Vocabulário fechado, nunca texto livre. */
type CallbackOutcome =
  "connected" | "denied" | "expired" | "unavailable" | "failed";

const OUTCOME_COPY: Record<CallbackOutcome, string> = {
  connected: "Google Agenda conectado. Você já pode voltar ao Escala+.",
  denied: "Autorização cancelada. Nada foi alterado na sua conta.",
  expired: "Este link de autorização expirou. Tente conectar de novo.",
  unavailable:
    "A integração com o Google não está disponível nesta instalação.",
  failed: "Não foi possível concluir a conexão. Tente de novo.",
};

/**
 * Conclui o callback.
 *
 * A base pública vem de `APP_PUBLIC_URL`, nunca de header — `Host` e
 * `X-Forwarded-*` são controláveis pelo cliente, e usá-los aqui abriria um
 * redirecionador. Quando não há base confiável (produção sem a variável), a
 * resposta é uma página simples em vez de um redirecionamento para lugar
 * nenhum: o usuário precisa saber o que aconteceu.
 */
function finish(
  res: Response,
  target: GoogleOAuthReturnTarget,
  outcome: CallbackOutcome,
): void {
  if (target === "MOBILE") {
    res.redirect(302, `${MOBILE_SCHEME}://google-calendar?status=${outcome}`);
    return;
  }
  const base = resolveTrustedPublicBaseUrl();
  if (!base) {
    res
      .status(outcome === "connected" ? 200 : 400)
      .type("text/plain; charset=utf-8")
      .send(OUTCOME_COPY[outcome]);
    return;
  }
  res.redirect(302, `${base}/google-calendar?status=${outcome}`);
}

googleRouter.get(CALLBACK_PATH, async (req: Request, res: Response) => {
  // Antes de conhecer o state não sabemos se o pedido veio do app ou da web.
  // A web é o destino conservador: um deep link de app sempre pode ser
  // aberto pelo navegador, o contrário não.
  let target: GoogleOAuthReturnTarget = "WEB";

  const config = readGoogleOAuthConfig();
  if (!config) {
    finish(res, target, "unavailable");
    return;
  }

  const rawState = req.query.state;
  const rawCode = req.query.code;
  const rawError = req.query.error;

  if (typeof rawState !== "string" || !rawState) {
    finish(res, target, "failed");
    return;
  }

  const db = await getDb();
  if (!db) {
    finish(res, target, "unavailable");
    return;
  }

  // O state é consumido ANTES de qualquer outra decisão, inclusive antes de
  // tratar o `error=access_denied`. Um state que chegou aqui foi usado, dê no
  // que der — é o que impede repetir o callback para tentar de novo.
  const consumed = await consumeGoogleAuthorizationState({
    db,
    state: rawState,
  });
  if (!consumed) {
    finish(res, target, "expired");
    return;
  }
  target = consumed.returnTarget;

  if (typeof rawError === "string" && rawError) {
    // O usuário recusou no Google. Não é falha nossa e não vira log de erro.
    logger.info(
      { event: "google_oauth_denied", userId: consumed.userId },
      "google authorization denied by user",
    );
    finish(res, target, "denied");
    return;
  }

  if (typeof rawCode !== "string" || !rawCode) {
    finish(res, target, "failed");
    return;
  }

  const grant = await exchangeGoogleAuthorizationCode({
    config,
    code: rawCode,
    codeVerifier: consumed.codeVerifier,
  });
  if (!grant.ok) {
    logger.warn(
      {
        event: "google_oauth_exchange_failed",
        userId: consumed.userId,
        reason: grant.reason,
      },
      "google authorization code exchange failed",
    );
    finish(res, target, "failed");
    return;
  }

  // Sem o escopo de criação de calendário não existe "conectado": o vínculo
  // nasceria sem calendário e o primeiro sync o degradaria. Recusar agora,
  // devolvendo a autorização ao Google, deixa claro que é preciso
  // autorizar de novo com a agenda marcada.
  if (!canCreateDedicatedCalendar(grant.value.grantedScopes)) {
    logger.warn(
      { event: "google_oauth_scope_missing", userId: consumed.userId },
      "google authorization lacks the calendar scope; link refused",
    );
    if (grant.value.refreshToken) {
      try {
        await revokeGoogleToken({ refreshToken: grant.value.refreshToken });
      } catch {
        // Melhor esforço: o token nunca foi gravado aqui.
      }
    }
    finish(res, target, "denied");
    return;
  }

  try {
    // Cria o calendário dedicado já no vínculo: o primeiro sync encontra
    // tudo pronto, e o usuário vê "Escala+" na conta dele imediatamente.
    const provider = createGoogleCalendarProvider(config);
    const timeZone = await resolveUserTimeZone(db, consumed.userId);
    const calendar = await provider.ensureDedicatedCalendar({
      accessToken: grant.value.accessToken,
      timeZone,
    });
    if (!calendar.ok) {
      // Escopo presente, Google indisponível: o vínculo vale, e o primeiro
      // sync cria o calendário (`ensureCalendar`, em sync.ts).
      logger.warn(
        {
          event: "google_oauth_calendar_deferred",
          userId: consumed.userId,
          reason: calendar.reason,
        },
        "dedicated calendar not created at link time; first sync retries",
      );
    }

    await persistGoogleAuthorization({
      db,
      userId: consumed.userId,
      grant: grant.value,
      // O rótulo da conta vem numa frente seguinte (userinfo); gravar null
      // aqui é honesto: melhor não mostrar nada do que mostrar errado.
      accountLabel: null,
      externalCalendarId: calendar.ok ? calendar.value.calendarId : null,
    });
  } catch (error) {
    logger.error(
      {
        event: "google_oauth_persist_failed",
        userId: consumed.userId,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "failed to persist google authorization",
    );
    finish(res, target, "failed");
    return;
  }

  logger.info(
    { event: "google_oauth_connected", userId: consumed.userId },
    "google calendar linked",
  );
  finish(res, target, "connected");
});

export { CALLBACK_PATH as GOOGLE_CALLBACK_PATH };
