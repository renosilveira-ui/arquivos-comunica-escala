import { eq } from "drizzle-orm";
import type { MySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";

import {
  departurePlans,
  externalCalendarEventLinks,
  googleOauthStates,
  operationalEmailVerificationTokens,
  personalCalendarExternalLinks,
  personalCalendarImportCursors,
  personalCalendarItems,
  userDeparturePreferences,
  userExternalCredentials,
  userOperationalEmailTrust,
  userTravelOrigins,
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../drizzle/schema";
import type { getDb } from "./db";

/**
 * O que some com a conta.
 *
 * A exclusão de conta é um soft-delete de `users` (a linha fica, anonimizada,
 * porque escala, auditoria e trocas passadas apontam para ela). Consequência
 * que ninguém vê no schema: nenhum `ON DELETE CASCADE` para `users` dispara
 * nunca. Toda tabela que guarda dado da PESSOA (credencial externa, endereço
 * de casa, agenda pessoal, conversa no WhatsApp) precisa ser apagada aqui,
 * explicitamente, dentro da mesma transação da exclusão.
 *
 * Este módulo é a única lista. `tests/account-data-purge-registry.test.ts`
 * varre o schema e reprova qualquer tabela com FK para `users` que não esteja
 * nem aqui nem em `USER_LINKED_TABLES_KEPT_ON_PURPOSE` — uma tabela nova sem
 * decisão vira teste vermelho, não dado pessoal retido em silêncio.
 *
 * A ordem importa: filhas antes das mães. Sem isso o CASCADE da mãe apaga a
 * filha primeiro e a contagem gravada na auditoria sai zero.
 */
export type UserOwnedPurgeEntry = {
  /** Nome curto que vai para a auditoria com a contagem de linhas. */
  key: string;
  table: MySqlTable;
  column: MySqlColumn;
};

export const USER_OWNED_DATA_PURGE: readonly UserOwnedPurgeEntry[] = [
  // Google Agenda: credencial (refresh token selado), espelho dos eventos
  // exportados e estados OAuth ainda abertos.
  {
    key: "externalCredentials",
    table: userExternalCredentials,
    column: userExternalCredentials.userId,
  },
  {
    key: "calendarEventLinks",
    table: externalCalendarEventLinks,
    column: externalCalendarEventLinks.userId,
  },
  {
    key: "oauthStates",
    table: googleOauthStates,
    column: googleOauthStates.userId,
  },
  // Agenda pessoal: vínculos importados e cursores ANTES dos itens (a FK do
  // vínculo para o item é CASCADE).
  {
    key: "importedCalendarLinks",
    table: personalCalendarExternalLinks,
    column: personalCalendarExternalLinks.ownerUserId,
  },
  {
    key: "importCursors",
    table: personalCalendarImportCursors,
    column: personalCalendarImportCursors.ownerUserId,
  },
  {
    key: "personalCalendarItems",
    table: personalCalendarItems,
    column: personalCalendarItems.ownerUserId,
  },
  // Aviso de saída: planos antes de preferências e origens (a FK do plano
  // para a origem é SET NULL; apagar na ordem natural dispensa depender dela).
  {
    key: "departurePlans",
    table: departurePlans,
    column: departurePlans.userId,
  },
  {
    key: "departurePreferences",
    table: userDeparturePreferences,
    column: userDeparturePreferences.userId,
  },
  {
    key: "travelOrigins",
    table: userTravelOrigins,
    column: userTravelOrigins.userId,
  },
  // WhatsApp: intenções em aberto. As mensagens recebidas ficam (registro
  // operacional do canal), mas desvinculadas e sem conteúdo — ver
  // `purgeUserOwnedData`.
  {
    key: "whatsappPendingIntents",
    table: whatsappPendingIntents,
    column: whatsappPendingIntents.userId,
  },
  // E-mail operacional (tabelas ainda dormentes, mas com FK para users).
  {
    key: "operationalEmailTrust",
    table: userOperationalEmailTrust,
    column: userOperationalEmailTrust.userId,
  },
  {
    key: "operationalEmailVerificationTokens",
    table: operationalEmailVerificationTokens,
    column: operationalEmailVerificationTokens.userId,
  },
];

/**
 * Tabelas com FK para `users` que ficam DE PROPÓSITO depois da exclusão.
 *
 * São registro operacional do hospital, não dado da pessoa: quem cobriu qual
 * plantão, quem aprovou o quê, o que foi notificado. A conta anonimizada
 * continua sendo a referência histórica dessas linhas. Cada nome aqui é uma
 * decisão, não um esquecimento — adicionar um nome exige justificar por que
 * o dado não é pessoal.
 */
export const USER_LINKED_TABLES_KEPT_ON_PURPOSE: ReadonlySet<string> = new Set(
  [
    // Identidade e vínculo institucional: anonimizados/desativados no handler.
    "professionals",
    "professional_institutions",
    "password_resets",
    "user_contact_channels",
    "auth_recovery_requests",
    "push_tokens",
    "sso_launch_codes",
    // Escala e operação: histórico do hospital.
    "shift_assignments_v2",
    "shift_reminders",
    "notifications",
    "operational_event_recipients",
    "swap_request_dismissals",
    "duty_confirmations",
    "personal_calendar_recurrences",
    "personal_calendar_alert_rules",
    "personal_calendar_occurrences",
    "personal_calendar_occurrence_exceptions",
    "whatsapp_inbound_messages",
    // Atribuição de autoria e trocas: quem criou, aprovou, convidou. Registro
    // do hospital, não dado da pessoa; a conta anonimizada segue como autor.
    "hospitals",
    "institution_feature_entitlements",
    "operational_events",
    "schedule_invites",
    "schedule_invite_issuance_fences",
    "shift_instances",
    "swap_requests",
  ],
);

type PurgeDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "delete" | "update"
>;

export type UserOwnedDataPurgeSummary = Record<string, number>;

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const value = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof value === "number" ? value : 0;
}

/**
 * Apaga o que pertence à pessoa, na ordem do registro, e devolve as
 * contagens para a auditoria. Roda DENTRO da transação da exclusão: se ela
 * for recusada (plantão futuro, último admin, sessão mudou), nada disto
 * persiste.
 */
export async function purgeUserOwnedData(
  db: PurgeDb,
  userId: number,
  now: Date,
): Promise<UserOwnedDataPurgeSummary> {
  const summary: UserOwnedDataPurgeSummary = {};
  for (const entry of USER_OWNED_DATA_PURGE) {
    summary[entry.key] = affectedRows(
      await db.delete(entry.table).where(eq(entry.column, userId)),
    );
  }
  // Mensagem recebida é registro do canal e fica; mas o que a FK `SET NULL`
  // faria numa exclusão física é feito aqui à mão, e o conteúdo (texto,
  // mídia) sai junto — o mesmo "limpo" que a retenção aplica no vencimento.
  summary.whatsappInboundMessagesUnlinked = affectedRows(
    await db
      .update(whatsappInboundMessages)
      .set({
        userId: null,
        operationalText: null,
        mediaUrl: null,
        mediaMime: null,
        payloadClearedAt: now,
      })
      .where(eq(whatsappInboundMessages.userId, userId)),
  );
  return summary;
}
