import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  EXTERNAL_LINK_STATES,
  EXTERNAL_LINK_STATE_LABELS,
  PROVIDER_CONFIGURATION_STATES,
  requiresUserAction,
} from "../lib/integration-providers";
import { router, sessionProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { googleCalendarConfiguration } from "./integrations/providers/configuration";
import { createGoogleCalendarProvider } from "./integrations/google/calendar-client";
import {
  disconnectGoogleLink,
  readGoogleLink,
} from "./integrations/google/link-service";
import {
  GOOGLE_OAUTH_RETURN_TARGETS,
  readGoogleOAuthConfig,
  revokeGoogleToken,
  startGoogleAuthorization,
} from "./integrations/google/oauth";
import {
  pullGoogleCalendarChanges,
  runGoogleCalendarExport,
} from "./integrations/google/sync";

/**
 * Vínculo da conta com o Google Agenda.
 *
 * Recurso account-wide: `sessionProcedure` é a única fronteira de autoridade,
 * e nenhum procedimento aceita `userId`, instituição ou papel vindos do
 * cliente. Um gestor não conecta o Google de outra pessoa.
 *
 * Nenhuma resposta carrega token. O que sai daqui é estado, rótulo da conta
 * e contagem — o suficiente para a tela decidir o que mostrar.
 */

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2}$/,
    "Fuso horário inválido.",
  );

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Integração indisponível no momento.",
    });
  }
  return db;
}

/**
 * Exige provedor configurado. `NOT_CONFIGURED` e `MISCONFIGURED` produzem a
 * mesma resposta para o cliente — dizer qual variável falta seria expor
 * detalhe de infraestrutura a quem não opera o servidor.
 */
function requireConfig() {
  const config = readGoogleOAuthConfig();
  if (!config) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "A integração com o Google Agenda ainda não está disponível nesta instalação.",
    });
  }
  return config;
}

export const googleCalendarRouter = router({
  /**
   * Estado do vínculo. Chamado por toda abertura da tela, então é barato de
   * propósito: uma leitura, sem rede.
   */
  status: sessionProcedure.query(async ({ ctx }) => {
    const configuration = googleCalendarConfiguration();
    const available =
      configuration.state === PROVIDER_CONFIGURATION_STATES.configured;
    if (!available) {
      return {
        available: false,
        linkState: EXTERNAL_LINK_STATES.disconnected,
        stateLabel:
          EXTERNAL_LINK_STATE_LABELS[EXTERNAL_LINK_STATES.disconnected],
        needsUserAction: false,
        accountLabel: null,
        lastSyncedAt: null,
        consecutiveFailureCount: 0,
      };
    }

    const db = await requireDb();
    const link = await readGoogleLink(db, ctx.user.id);
    const linkState = link?.linkState ?? EXTERNAL_LINK_STATES.disconnected;
    return {
      available: true,
      linkState,
      stateLabel: EXTERNAL_LINK_STATE_LABELS[linkState],
      needsUserAction: requiresUserAction(linkState),
      accountLabel: link?.accountLabel ?? null,
      lastSyncedAt: link?.lastSyncedAt ?? null,
      consecutiveFailureCount: link?.consecutiveFailureCount ?? 0,
    };
  }),

  /**
   * Abre a autorização e devolve a URL para o navegador.
   *
   * O cliente escolhe apenas o RÓTULO do destino de retorno (`WEB` ou
   * `MOBILE`), nunca a URL. Aceitar URL aqui transformaria o callback em
   * redirecionador aberto.
   */
  startLink: sessionProcedure
    .input(
      z
        .object({
          returnTarget: z.enum(["WEB", "MOBILE"]).default("WEB"),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const config = requireConfig();
      const db = await requireDb();
      const started = await startGoogleAuthorization({
        db,
        userId: ctx.user.id,
        returnTarget:
          input.returnTarget === "MOBILE"
            ? GOOGLE_OAUTH_RETURN_TARGETS.mobile
            : GOOGLE_OAUTH_RETURN_TARGETS.web,
        config,
      });
      return {
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt,
      };
    }),

  /**
   * Desvincula. Revoga no Google antes de apagar o envelope: sem isso, o
   * Escala+ continuaria listado como app autorizado na conta do médico.
   */
  disconnect: sessionProcedure.mutation(async ({ ctx }) => {
    const db = await requireDb();
    const result = await disconnectGoogleLink({
      db,
      userId: ctx.user.id,
      revoke: (refreshToken) => revokeGoogleToken({ refreshToken }),
    });
    return { revoked: result.revoked };
  }),

  /**
   * Sincroniza agora, a pedido do usuário.
   *
   * Exporta e depois lê. A ordem importa: ler primeiro faria o ciclo
   * processar mudanças que ele mesmo está prestes a causar.
   */
  syncNow: sessionProcedure
    .input(z.object({ timeZone: timeZoneSchema }).strict())
    .mutation(async ({ ctx, input }) => {
      const config = requireConfig();
      const db = await requireDb();
      const provider = createGoogleCalendarProvider(config);

      const exported = await runGoogleCalendarExport({
        db,
        userId: ctx.user.id,
        config,
        provider,
        timeZone: input.timeZone,
      });
      if (!exported.ok) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            exported.reason === "AUTH_REJECTED"
              ? "O Google pediu uma nova autorização. Reconecte sua conta."
              : "O Google não respondeu agora. Tentaremos de novo em instantes.",
        });
      }

      const pulled = await pullGoogleCalendarChanges({
        db,
        userId: ctx.user.id,
        config,
        provider,
      });

      return {
        created: exported.value.created,
        updated: exported.value.updated,
        deleted: exported.value.deleted,
        unchanged: exported.value.unchanged,
        resynced: pulled.ok ? pulled.value.resynced : false,
      };
    }),
});
