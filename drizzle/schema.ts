import {
  mysqlTable,
  int,
  varchar,
  text,
  mysqlEnum,
  timestamp,
  datetime,
  boolean,
  time,
  json,
  unique,
  index,
  decimal,
  foreignKey,
  customType,
  check,
  tinyint,
  bigint,
  char,
  date,
} from "drizzle-orm/mysql-core";
import { relations, sql } from "drizzle-orm";

const binaryVarchar = customType<{
  data: string;
  driverData: string;
  config: { length: number };
  configRequired: true;
}>({
  dataType(config) {
    return `varchar(${config.length}) COLLATE utf8mb4_bin`;
  },
});

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Kept for legacy compatibility — nullable for email/password users. */
  openId: varchar("openId", { length: 64 }).unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }).unique(),
  passwordHash: varchar("password_hash", { length: 255 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["admin", "manager", "doctor", "nurse", "tech"])
    .default("doctor")
    .notNull(),
  /**
   * Auto-cadastro (2026-08-18): contas criadas pela página pública de
   * cadastro nascem PENDING e só operam após aprovação do gestor na aba
   * Admin. Default APPROVED preserva todas as contas existentes e as
   * criadas pelo admin.
   */
  approvalStatus: mysqlEnum("approval_status", ["PENDING", "APPROVED"])
    .default("APPROVED")
    .notNull(),
  /**
   * Senha temporária definida pelo admin (2026-08-22): o app força a
   * troca antes de liberar qualquer tela. change-password limpa a flag.
   */
  mustChangePassword: boolean("must_change_password").default(false).notNull(),
  /**
   * Versão da sessão (2026-08-23). O JWT de sessão carrega `sv`; trocar ou
   * redefinir a senha incrementa a versão e TODAS as sessões anteriores
   * (outros aparelhos/abas) passam a ser rejeitadas — auditoria 22/08, B3.
   * Migração manual: drizzle/migrations/manual/2026-08-23-users-session-version.sql
   */
  sessionVersion: int("session_version").notNull().default(1),
  /**
   * Exclusão de conta pelo próprio usuário (Apple 5.1.1(v)). Soft-delete:
   * a linha permanece (FKs de audit/assignments) mas anonimizada; login e
   * sessões falham quando preenchido.
   */
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Tokens de "esqueci minha senha". Só o sha256 do token é gravado;
 * o token em claro vai apenas no link do e-mail. Uso único (used_at)
 * e TTL curto (expires_at, 30 min).
 */
export const passwordResets = mysqlTable(
  "password_resets",
  {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxPasswordResetsTokenHash: index("idx_password_resets_token_hash").on(
      table.tokenHash,
    ),
  }),
);

export type PasswordReset = typeof passwordResets.$inferSelect;

/**
 * Canais de contato do usuário (WhatsApp V1).
 * Identidade canônica: user → channel → E.164 normalizado.
 * verifiedAt só é preenchido server-side após Twilio Verify (status approved) —
 * mutations de perfil NUNCA marcam verificado.
 * Migração: drizzle/migrations/manual/2026-08-31-user-contact-channels.sql
 */
export const contactChannelEnum = mysqlEnum("channel", ["WHATSAPP"]);

export const userContactChannels = mysqlTable(
  "user_contact_channels",
  {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: contactChannelEnum.notNull(),
    /** Valor de exibição / última entrada do usuário (não canônico). */
    address: varchar("address", { length: 32 }).notNull(),
    /** E.164 canônico (+5511…). Persistência sempre normalizada. */
    normalizedAddress: varchar("normalized_address", { length: 20 }).notNull(),
    verifiedAt: timestamp("verified_at"),
    active: boolean("active").notNull().default(true),
    /**
     * Coluna gerada: espelha normalized_address só quando active=1.
     * UNIQUE (channel, active_normalized_address) garante E.164 ativo
     * único entre usuários; NULL em inativos permite reuso.
     */
    activeNormalizedAddress: varchar("active_normalized_address", {
      length: 20,
    }).generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`IF(\`active\` = 1, \`normalized_address\`, NULL)`,
      { mode: "stored" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    uniqUserContactChannel: unique("uniq_user_contact_channel").on(
      table.userId,
      table.channel,
    ),
    uniqContactChannelActiveAddress: unique(
      "uniq_contact_channel_active_address",
    ).on(table.channel, table.activeNormalizedAddress),
    idxUserContactChannelsUser: index("idx_user_contact_channels_user").on(
      table.userId,
    ),
  }),
);

export type UserContactChannel = typeof userContactChannels.$inferSelect;
export type InsertUserContactChannel = typeof userContactChannels.$inferInsert;

/**
 * Agenda pessoal do titular da conta.
 *
 * Este domínio é deliberadamente account-wide: não carrega institution_id,
 * professional_id, hospital_id ou sector_id. Esses eixos governam escalas
 * institucionais e nunca podem se tornar autoridade sobre um compromisso
 * privado. O owner sempre é derivado da sessão pelo servidor.
 *
 * Datas e horas são civis no fuso IANA informado. Instantes UTC destinados a
 * busca, conflito e alertas vivem somente em personal_calendar_occurrences,
 * onde são materializados pelo motor de recorrência.
 */
export const personalCalendarItems = mysqlTable(
  "personal_calendar_items",
  {
    id: int("id").primaryKey().autoincrement(),
    ownerUserId: int("owner_user_id").notNull(),
    clientMutationId: binaryVarchar("client_mutation_id", {
      length: 64,
    }).notNull(),
    kind: mysqlEnum("kind", ["APPOINTMENT", "REMINDER", "BIRTHDAY"]).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    locationLabel: varchar("location_label", { length: 255 }),
    /** Identificador futuro de Google Maps; nunca é autoridade de acesso. */
    locationProvider: varchar("location_provider", { length: 32 }),
    locationExternalId: varchar("location_external_id", { length: 191 }),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    notes: text("notes"),
    startLocalDate: date("start_local_date", { mode: "string" }),
    startLocalTime: time("start_local_time"),
    endLocalDate: date("end_local_date", { mode: "string" }),
    endLocalTime: time("end_local_time"),
    birthdayMonth: tinyint("birthday_month", { unsigned: true }),
    birthdayDay: tinyint("birthday_day", { unsigned: true }),
    birthdayYear: int("birthday_year"),
    allDay: boolean("all_day").notNull().default(false),
    /** VARCHAR + CHECK evita o default implícito do primeiro valor de ENUM. */
    availability: varchar("availability", {
      length: 4,
      enum: ["BUSY", "FREE"],
    }).notNull(),
    timeZone: varchar("time_zone", { length: 64 }).notNull(),
    version: int("version").notNull().default(1),
    deletedAt: datetime("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqPersonalCalendarItemOwnerMutation: unique(
      "uniq_pc_item_owner_mutation",
    ).on(table.ownerUserId, table.clientMutationId),
    uniqPersonalCalendarItemIdOwner: unique("uniq_pc_item_id_owner").on(
      table.id,
      table.ownerUserId,
    ),
    idxPersonalCalendarItemOwnerRange: index("idx_pc_item_owner_range").on(
      table.ownerUserId,
      table.deletedAt,
      table.startLocalDate,
      table.id,
    ),
    fkPersonalCalendarItemOwner: foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
      name: "fk_pc_item_owner",
    }).onDelete("cascade"),
    chkPersonalCalendarItemTitle: check(
      "chk_pc_item_title",
      sql`CHAR_LENGTH(TRIM(${table.title})) BETWEEN 1 AND 160`,
    ),
    chkPersonalCalendarItemMutationId: check(
      "chk_pc_item_mutation_id",
      sql`CHAR_LENGTH(${table.clientMutationId}) BETWEEN 1 AND 64`,
    ),
    chkPersonalCalendarItemTimezone: check(
      "chk_pc_item_timezone",
      sql`CHAR_LENGTH(TRIM(${table.timeZone})) BETWEEN 1 AND 64`,
    ),
    chkPersonalCalendarItemLocation: check(
      "chk_pc_item_location",
      sql`(
        (${table.latitude} IS NULL AND ${table.longitude} IS NULL)
        OR
        (
          ${table.latitude} BETWEEN -90 AND 90
          AND ${table.longitude} BETWEEN -180 AND 180
        )
      )`,
    ),
    chkPersonalCalendarItemLocationBinding: check(
      "chk_pc_item_location_binding",
      sql`(
        (${table.locationProvider} IS NULL AND ${table.locationExternalId} IS NULL)
        OR
        (
          CHAR_LENGTH(TRIM(${table.locationProvider})) BETWEEN 1 AND 32
          AND CHAR_LENGTH(TRIM(${table.locationExternalId})) BETWEEN 1 AND 191
        )
      )`,
    ),
    chkPersonalCalendarItemAvailability: check(
      "chk_pc_item_availability",
      sql`${table.availability} IN ('BUSY', 'FREE')
        AND (${table.kind} = 'APPOINTMENT' OR ${table.availability} = 'FREE')`,
    ),
    chkPersonalCalendarItemVersion: check(
      "chk_pc_item_version",
      sql`${table.version} >= 1`,
    ),
    chkPersonalCalendarItemShape: check(
      "chk_pc_item_shape",
      sql`(
        (
          ${table.kind} = 'APPOINTMENT'
          AND ${table.startLocalDate} IS NOT NULL
          AND ${table.endLocalDate} IS NOT NULL
          AND ${table.birthdayMonth} IS NULL
          AND ${table.birthdayDay} IS NULL
          AND ${table.birthdayYear} IS NULL
          AND (
            (
              ${table.allDay} = 1
              AND ${table.startLocalTime} IS NULL
              AND ${table.endLocalTime} IS NULL
              AND ${table.endLocalDate} > ${table.startLocalDate}
            )
            OR
            (
              ${table.allDay} = 0
              AND ${table.startLocalTime} IS NOT NULL
              AND ${table.endLocalTime} IS NOT NULL
              AND TIMESTAMP(${table.endLocalDate}, ${table.endLocalTime})
                > TIMESTAMP(${table.startLocalDate}, ${table.startLocalTime})
            )
          )
        )
        OR
        (
          ${table.kind} = 'REMINDER'
          AND ${table.startLocalDate} IS NOT NULL
          AND ${table.endLocalDate} IS NULL
          AND ${table.endLocalTime} IS NULL
          AND ${table.birthdayMonth} IS NULL
          AND ${table.birthdayDay} IS NULL
          AND ${table.birthdayYear} IS NULL
          AND (
            (${table.allDay} = 1 AND ${table.startLocalTime} IS NULL)
            OR
            (${table.allDay} = 0 AND ${table.startLocalTime} IS NOT NULL)
          )
        )
        OR
        (
          ${table.kind} = 'BIRTHDAY'
          AND ${table.allDay} = 1
          AND ${table.startLocalDate} IS NULL
          AND ${table.startLocalTime} IS NULL
          AND ${table.endLocalDate} IS NULL
          AND ${table.endLocalTime} IS NULL
          AND ${table.birthdayMonth} BETWEEN 1 AND 12
          AND ${table.birthdayDay} BETWEEN 1 AND
            CASE ${table.birthdayMonth}
              WHEN 2 THEN 29
              WHEN 4 THEN 30
              WHEN 6 THEN 30
              WHEN 9 THEN 30
              WHEN 11 THEN 30
              ELSE 31
            END
          AND (${table.birthdayYear} IS NULL OR ${table.birthdayYear} BETWEEN 1800 AND 2200)
        )
      )`,
    ),
  }),
);

export type PersonalCalendarItem = typeof personalCalendarItems.$inferSelect;
export type InsertPersonalCalendarItem =
  typeof personalCalendarItems.$inferInsert;

/**
 * Subconjunto normalizado de recorrência. O cliente nunca fornece RRULE
 * arbitrária: o servidor traduz estas colunas para uma regra limitada.
 */
export const personalCalendarRecurrences = mysqlTable(
  "personal_calendar_recurrences",
  {
    id: int("id").primaryKey().autoincrement(),
    itemId: int("item_id").notNull(),
    ownerUserId: int("owner_user_id").notNull(),
    frequency: mysqlEnum("frequency", [
      "DAILY",
      "WEEKLY",
      "MONTHLY",
      "YEARLY",
    ]).notNull(),
    interval: int("interval_count").notNull().default(1),
    /** Bits 0..6 representam domingo..sábado; obrigatório só em WEEKLY. */
    weekdaysMask: tinyint("weekdays_mask", { unsigned: true }),
    invalidDatePolicy: mysqlEnum("invalid_date_policy", [
      "SKIP",
      "CLAMP_LAST_DAY",
    ])
      .notNull()
      .default("SKIP"),
    termination: mysqlEnum("termination", ["NEVER", "UNTIL", "COUNT"])
      .notNull()
      .default("NEVER"),
    untilLocalDate: date("until_local_date", { mode: "string" }),
    occurrenceCount: int("occurrence_count"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqPersonalCalendarRecurrenceItem: unique("uniq_pc_recurrence_item").on(
      table.itemId,
    ),
    idxPersonalCalendarRecurrenceOwner: index("idx_pc_recurrence_owner").on(
      table.ownerUserId,
      table.itemId,
    ),
    fkPersonalCalendarRecurrenceItemOwner: foreignKey({
      columns: [table.itemId, table.ownerUserId],
      foreignColumns: [
        personalCalendarItems.id,
        personalCalendarItems.ownerUserId,
      ],
      name: "fk_pc_recurrence_item_owner",
    }).onDelete("cascade"),
    chkPersonalCalendarRecurrenceInterval: check(
      "chk_pc_recurrence_interval",
      sql`${table.interval} BETWEEN 1 AND 100`,
    ),
    chkPersonalCalendarRecurrenceWeekdays: check(
      "chk_pc_recurrence_weekdays",
      sql`(
        (${table.frequency} = 'WEEKLY' AND ${table.weekdaysMask} BETWEEN 1 AND 127)
        OR
        (${table.frequency} <> 'WEEKLY' AND ${table.weekdaysMask} IS NULL)
      )`,
    ),
    chkPersonalCalendarRecurrenceTermination: check(
      "chk_pc_recurrence_termination",
      sql`(
        (
          ${table.termination} = 'NEVER'
          AND ${table.untilLocalDate} IS NULL
          AND ${table.occurrenceCount} IS NULL
        )
        OR
        (
          ${table.termination} = 'UNTIL'
          AND ${table.untilLocalDate} IS NOT NULL
          AND ${table.occurrenceCount} IS NULL
        )
        OR
        (
          ${table.termination} = 'COUNT'
          AND ${table.untilLocalDate} IS NULL
          AND ${table.occurrenceCount} BETWEEN 1 AND 10000
        )
      )`,
    ),
  }),
);

export type PersonalCalendarRecurrence =
  typeof personalCalendarRecurrences.$inferSelect;
export type InsertPersonalCalendarRecurrence =
  typeof personalCalendarRecurrences.$inferInsert;

/**
 * Regras semânticas de aviso por item. O offset é persistido em minutos para
 * suportar os atalhos do produto e valores customizados sem aceitar expressões
 * livres do cliente. A materialização e a entrega pertencem a uma outbox
 * futura; esta tabela nunca representa que um push já foi enviado.
 */
export const personalCalendarAlertRules = mysqlTable(
  "personal_calendar_alert_rules",
  {
    id: int("id").primaryKey().autoincrement(),
    itemId: int("item_id").notNull(),
    ownerUserId: int("owner_user_id").notNull(),
    minutesBefore: int("minutes_before").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqPersonalCalendarAlertOffset: unique("uniq_pc_alert_item_offset").on(
      table.itemId,
      table.minutesBefore,
    ),
    idxPersonalCalendarAlertOwner: index("idx_pc_alert_owner").on(
      table.ownerUserId,
      table.itemId,
    ),
    fkPersonalCalendarAlertItemOwner: foreignKey({
      columns: [table.itemId, table.ownerUserId],
      foreignColumns: [
        personalCalendarItems.id,
        personalCalendarItems.ownerUserId,
      ],
      name: "fk_pc_alert_item_owner",
    }).onDelete("cascade"),
    chkPersonalCalendarAlertOffset: check(
      "chk_pc_alert_offset",
      sql`${table.minutesBefore} BETWEEN 0 AND 525600`,
    ),
  }),
);

export type PersonalCalendarAlertRule =
  typeof personalCalendarAlertRules.$inferSelect;
export type InsertPersonalCalendarAlertRule =
  typeof personalCalendarAlertRules.$inferInsert;

/** Ocorrências UTC materializadas e limitadas pelo motor de recorrência. */
export const personalCalendarOccurrences = mysqlTable(
  "personal_calendar_occurrences",
  {
    id: int("id").primaryKey().autoincrement(),
    itemId: int("item_id").notNull(),
    ownerUserId: int("owner_user_id").notNull(),
    occurrenceKey: binaryVarchar("occurrence_key", { length: 64 }).notNull(),
    originalLocalDate: date("original_local_date", {
      mode: "string",
    }).notNull(),
    originalLocalTime: time("original_local_time"),
    startsAtUtc: datetime("starts_at_utc").notNull(),
    endsAtUtc: datetime("ends_at_utc").notNull(),
    state: mysqlEnum("state", ["ACTIVE", "CANCELLED", "REPLACED"])
      .notNull()
      .default("ACTIVE"),
    sourceVersion: int("source_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqPersonalCalendarOccurrence: unique("uniq_pc_occurrence_item_key").on(
      table.itemId,
      table.occurrenceKey,
    ),
    idxPersonalCalendarOccurrenceOwnerRange: index(
      "idx_pc_occurrence_owner_range",
    ).on(table.ownerUserId, table.state, table.startsAtUtc, table.endsAtUtc),
    fkPersonalCalendarOccurrenceItemOwner: foreignKey({
      columns: [table.itemId, table.ownerUserId],
      foreignColumns: [
        personalCalendarItems.id,
        personalCalendarItems.ownerUserId,
      ],
      name: "fk_pc_occurrence_item_owner",
    }).onDelete("cascade"),
    chkPersonalCalendarOccurrenceKey: check(
      "chk_pc_occurrence_key",
      sql`CHAR_LENGTH(${table.occurrenceKey}) BETWEEN 1 AND 64`,
    ),
    chkPersonalCalendarOccurrenceRange: check(
      "chk_pc_occurrence_range",
      sql`${table.endsAtUtc} > ${table.startsAtUtc}`,
    ),
    chkPersonalCalendarOccurrenceVersion: check(
      "chk_pc_occurrence_version",
      sql`${table.sourceVersion} >= 1`,
    ),
  }),
);

export type PersonalCalendarOccurrence =
  typeof personalCalendarOccurrences.$inferSelect;
export type InsertPersonalCalendarOccurrence =
  typeof personalCalendarOccurrences.$inferInsert;

/**
 * Exceção estável de uma ocorrência. Alterar somente uma data cria um item
 * não recorrente substituto; a série guarda apenas o vínculo, sem duplicar
 * título, local ou anotações em JSON.
 */
export const personalCalendarOccurrenceExceptions = mysqlTable(
  "personal_calendar_occurrence_exceptions",
  {
    id: int("id").primaryKey().autoincrement(),
    seriesItemId: int("series_item_id").notNull(),
    ownerUserId: int("owner_user_id").notNull(),
    occurrenceKey: binaryVarchar("occurrence_key", { length: 64 }).notNull(),
    action: mysqlEnum("action", ["CANCELLED", "REPLACED"]).notNull(),
    replacementItemId: int("replacement_item_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqPersonalCalendarOccurrenceException: unique(
      "uniq_pc_exception_series_key",
    ).on(table.seriesItemId, table.occurrenceKey),
    idxPersonalCalendarExceptionReplacement: index(
      "idx_pc_exception_replacement",
    ).on(table.ownerUserId, table.replacementItemId),
    fkPersonalCalendarExceptionSeriesOwner: foreignKey({
      columns: [table.seriesItemId, table.ownerUserId],
      foreignColumns: [
        personalCalendarItems.id,
        personalCalendarItems.ownerUserId,
      ],
      name: "fk_pc_exception_series_owner",
    }).onDelete("cascade"),
    fkPersonalCalendarExceptionReplacementOwner: foreignKey({
      columns: [table.replacementItemId, table.ownerUserId],
      foreignColumns: [
        personalCalendarItems.id,
        personalCalendarItems.ownerUserId,
      ],
      name: "fk_pc_exception_replacement_owner",
    }).onDelete("cascade"),
    chkPersonalCalendarExceptionKey: check(
      "chk_pc_exception_key",
      sql`CHAR_LENGTH(${table.occurrenceKey}) BETWEEN 1 AND 64`,
    ),
    chkPersonalCalendarExceptionAction: check(
      "chk_pc_exception_action",
      sql`(
        (${table.action} = 'CANCELLED' AND ${table.replacementItemId} IS NULL)
        OR
        (
          ${table.action} = 'REPLACED'
          AND ${table.replacementItemId} IS NOT NULL
          AND ${table.replacementItemId} <> ${table.seriesItemId}
        )
      )`,
    ),
  }),
);

export type PersonalCalendarOccurrenceException =
  typeof personalCalendarOccurrenceExceptions.$inferSelect;
export type InsertPersonalCalendarOccurrenceException =
  typeof personalCalendarOccurrenceExceptions.$inferInsert;

/**
 * Inbound técnico WhatsApp (Incremento A). Fila assíncrona:
 * idempotência + payload operacional temporário (texto/mídia) com retenção curta.
 * Sem dump Twilio, signature, Auth Token ou telefone.
 * `sender_address_hash` permanece no schema (migration #402 já aplicada);
 * o runtime não calcula nem grava esse valor.
 * READY_FOR_* = material suficiente persistido para o próximo estágio.
 * Migração: drizzle/migrations/manual/2026-09-04-whatsapp-inbound-messages.sql
 */
export const whatsappInboundMessages = mysqlTable(
  "whatsapp_inbound_messages",
  {
    id: int("id").primaryKey().autoincrement(),
    provider: mysqlEnum("provider", ["TWILIO"]).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 64 }).notNull(),
    userId: int("user_id").references(() => users.id, { onDelete: "set null" }),
    contentKind: mysqlEnum("content_kind", [
      "TEXT",
      "AUDIO",
      "UNSUPPORTED_MEDIA",
    ]).notNull(),
    forwarded: boolean("forwarded").notNull().default(false),
    processingStatus: mysqlEnum("processing_status", [
      "RECEIVED",
      "IDENTIFIED",
      "RETRYABLE",
      "IDENTITY_NOT_FOUND",
      "IDENTITY_CONFLICT",
      "UNSUPPORTED",
      "READY_FOR_NL",
      "READY_FOR_TRANSCRIPTION",
    ]).notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    senderAddressHash: char("sender_address_hash", { length: 16 }),
    operationalText: text("operational_text"),
    mediaUrl: varchar("media_url", { length: 768 }),
    mediaMime: varchar("media_mime", { length: 64 }),
    payloadExpiresAt: timestamp("payload_expires_at"),
    payloadClearedAt: timestamp("payload_cleared_at"),
    receivedAt: timestamp("received_at").notNull(),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
    /**
     * Child inbound → unique OPEN pending in CLARIFICATION|CONFIRMATION.
     * Null = not attached. Named FK lives in SQL
     * (`fk_whatsapp_inbound_continuation_pending`) because the Drizzle
     * auto-name exceeds MySQL's 64-char identifier limit.
     * Authority of apply is continuation_outcome, not this pointer alone.
     */
    continuationPendingId: int("continuation_pending_id"),
    continuationOutcome: mysqlEnum("continuation_outcome", [
      "APPLIED",
      "NOOP",
    ]),
  },
  (table) => ({
    uniqWhatsappInboundProviderMessage: unique(
      "uniq_whatsapp_inbound_provider_message",
    ).on(table.provider, table.providerMessageId),
    idxWhatsappInboundUser: index("idx_whatsapp_inbound_user").on(table.userId),
    idxWhatsappInboundReceived: index("idx_whatsapp_inbound_received").on(
      table.receivedAt,
    ),
    idxWhatsappInboundPayloadExpires: index(
      "idx_whatsapp_inbound_payload_expires",
    ).on(table.payloadExpiresAt),
    idxWhatsappInboundNlPoll: index("idx_whatsapp_inbound_nl_poll").on(
      table.provider,
      table.processingStatus,
      table.contentKind,
      table.payloadClearedAt,
      table.receivedAt,
      table.id,
    ),
    idxWhatsappInboundContinuationPending: index(
      "idx_whatsapp_inbound_continuation_pending",
    ).on(table.continuationPendingId),
  }),
);

export type WhatsappInboundMessage = typeof whatsappInboundMessages.$inferSelect;
export type InsertWhatsappInboundMessage =
  typeof whatsappInboundMessages.$inferInsert;

// ========================================
// NOVO MODELO MULTI-INSTITUCIONAL
// ========================================

/**
 * Instituições (nível mais alto da hierarquia)
 * Ex: "Rede D'Or", "Hospital Sírio-Libanês"
 */
export const institutions = mysqlTable("institutions", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 255 }).notNull(),
  cnpj: varchar("cnpj", { length: 14 }).notNull().unique(),
  legalName: varchar("legal_name", { length: 255 }),
  tradeName: varchar("trade_name", { length: 255 }),
  isActive: boolean("is_active").notNull().default(true),
  metadata: json("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

/**
 * Recursos comerciais habilitados por instituição.
 *
 * Ausência de linha mantém o padrão do produto definido no servidor. Uma
 * linha registra a materialização ou um override institucional explícito e
 * não altera papel, manager_scope, professional_access ou elegibilidade.
 */
export const institutionFeatureEntitlements = mysqlTable(
  "institution_feature_entitlements",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id").notNull(),
    featureCode: varchar("feature_code", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    source: mysqlEnum("source", [
      "LEGACY_COMPATIBILITY",
      "ADMIN_OVERRIDE",
      "COMMERCIAL_PACKAGE",
    ]).notNull(),
    version: int("version").notNull().default(1),
    updatedByUserId: int("updated_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqInstitutionFeature: unique("uniq_institution_feature").on(
      table.institutionId,
      table.featureCode,
    ),
    idxInstitutionFeatureLookup: index("idx_institution_feature_lookup").on(
      table.institutionId,
      table.enabled,
      table.featureCode,
    ),
    fkInstitutionFeatureInstitution: foreignKey({
      columns: [table.institutionId],
      foreignColumns: [institutions.id],
      name: "fk_institution_feature_institution",
    }),
    fkInstitutionFeatureUpdatedBy: foreignKey({
      columns: [table.updatedByUserId],
      foreignColumns: [users.id],
      name: "fk_institution_feature_updated_by",
    }).onDelete("set null"),
  }),
);

/**
 * Conversa/intenção WhatsApp pendente (Incremento B1).
 * Memória de conversa — não é autoridade de acesso, elegibilidade ou swap.
 * institution_id nasce null; nunca vem de texto/webhook.
 * Uma mensagem inbound → no máximo um pending (UNIQUE source).
 * No máximo um OPEN por usuário (coluna gerada + UNIQUE).
 * Migração: drizzle/migrations/manual/2026-09-04-whatsapp-pending-intents.sql
 */
export const whatsappPendingIntents = mysqlTable(
  "whatsapp_pending_intents",
  {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull(),
    sourceInboundMessageId: int("source_inbound_message_id").notNull(),
    institutionId: int("institution_id"),
    status: mysqlEnum("status", [
      "OPEN",
      "CANCELLED",
      "EXPIRED",
      "CONSUMED",
    ]).notNull(),
    stage: mysqlEnum("stage", [
      "PARSE",
      "CLARIFICATION",
      "CONFIRMATION",
      "EXECUTION",
    ]).notNull(),
    intentKind: mysqlEnum("intent_kind", ["SWAP", "CESSAO"]),
    parsedPayload: json("parsed_payload"),
    resolvedPayload: json("resolved_payload"),
    clarificationPayload: json("clarification_payload"),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    payloadClearedAt: timestamp("payload_cleared_at"),
    /**
     * Explicit user confirmation recorded while OPEN/CONFIRMATION.
     * Null until AFFIRM. Does not mean executed, CONSUMED or createSwapOffer.
     */
    confirmationDisposition: mysqlEnum("confirmation_disposition", [
      "AFFIRMED",
    ]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
    /**
     * 1 só enquanto status=OPEN; NULL nos terminais.
     * UNIQUE (user_id, open_slot) garante um único fluxo WhatsApp OPEN
     * por usuário sem copiar user_id (FK + generated column no MySQL 8).
     */
    openSlot: tinyint("open_slot").generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`IF(\`status\` = 'OPEN', 1, NULL)`,
      { mode: "stored" },
    ),
  },
  (table) => ({
    uniqWhatsappPendingSource: unique("uniq_whatsapp_pending_source").on(
      table.sourceInboundMessageId,
    ),
    uniqWhatsappPendingOpenUser: unique("uniq_whatsapp_pending_open_user").on(
      table.userId,
      table.openSlot,
    ),
    idxWhatsappPendingUser: index("idx_whatsapp_pending_user").on(table.userId),
    idxWhatsappPendingExpires: index("idx_whatsapp_pending_expires").on(
      table.expiresAt,
    ),
    fkWhatsappPendingUser: foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "fk_whatsapp_pending_user",
    }).onDelete("cascade"),
    fkWhatsappPendingSource: foreignKey({
      columns: [table.sourceInboundMessageId],
      foreignColumns: [whatsappInboundMessages.id],
      name: "fk_whatsapp_pending_source",
    }).onDelete("restrict"),
    fkWhatsappPendingInstitution: foreignKey({
      columns: [table.institutionId],
      foreignColumns: [institutions.id],
      name: "fk_whatsapp_pending_institution",
    }).onDelete("set null"),
  }),
);

export type WhatsappPendingIntent = typeof whatsappPendingIntents.$inferSelect;
export type InsertWhatsappPendingIntent =
  typeof whatsappPendingIntents.$inferInsert;

/**
 * Journal imutável de invalidações de prontidão por instituição.
 *
 * Não há foreign key intencionalmente: uma FK com cascade apagaria a prova
 * histórica no delete da instituição, enquanto uma FK restrict impediria a
 * própria exclusão. Qualquer retenção, expurgo ou tombstone futuro precisa de
 * uma política explícita e auditada; nunca de uma exclusão referencial
 * implícita. Esta tabela tampouco guarda uma decisão de prontidão.
 */
export const institutionReadinessFenceEvents = mysqlTable(
  "institution_readiness_fence_events",
  {
    id: bigint("id", { mode: "bigint", unsigned: true })
      .primaryKey()
      .autoincrement(),
    institutionId: int("institution_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxReadinessFenceEventInstitutionId: index(
      "idx_rdf_event_institution_id",
    ).on(table.institutionId, table.id),
  }),
);

export type InstitutionReadinessFenceEvent =
  typeof institutionReadinessFenceEvents.$inferSelect;

/**
 * Recibo singleton da instalação integral da fence V1.
 *
 * A ausência, multiplicidade ou divergência deste recibo deve permanecer uma
 * falha fechada em qualquer consumidor futuro.
 */
export const institutionReadinessFenceInstallations = mysqlTable(
  "institution_readiness_fence_installations",
  {
    id: tinyint("id", { unsigned: true }).primaryKey(),
    coverageVersion: varchar("coverage_version", { length: 64 }).notNull(),
    coverageHash: char("coverage_hash", { length: 64 }).notNull(),
    installedAt: timestamp("installed_at").notNull().defaultNow(),
  },
);

export type InstitutionReadinessFenceInstallation =
  typeof institutionReadinessFenceInstallations.$inferSelect;

/**
 * Hospitais (pertence a uma instituição)
 * Ex: "Hospital Copa D'Or", "Hospital São Luiz Itaim"
 */
export const hospitals = mysqlTable(
  "hospitals",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxHospitalInstitutionId: index("idx_hospitals_institution_id").on(
      table.institutionId,
      table.id,
    ),
    uniqHospitalTopologyId: unique("uniq_hospitals_topology_id").on(
      table.institutionId,
      table.id,
    ),
  }),
);

/**
 * Setores hospitalares (pertence a um hospital)
 * Sincronizado com HospitalAlert (23 setores)
 */
export const sectors = mysqlTable(
  "sectors",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    name: varchar("name", { length: 255 }).notNull(),
    category: mysqlEnum("category", [
      "internacao",
      "cirurgico",
      "servico",
    ]).notNull(),
    color: varchar("color", { length: 7 }).notNull(), // Hex color
    minStaffCount: int("min_staff_count").notNull().default(2),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxSectorInstitutionId: index("idx_sectors_institution_id").on(
      table.institutionId,
      table.id,
    ),
    uniqSectorTopologyId: unique("uniq_sectors_topology_id").on(
      table.institutionId,
      table.hospitalId,
      table.id,
    ),
    fkSectorHospitalTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId],
      foreignColumns: [hospitals.institutionId, hospitals.id],
      name: "fk_sectors_hospital_topology",
    }),
  }),
);

/**
 * Profissionais (usuários que atuam em plantões)
 * Relacionamento com users para manter separação entre auth e dados profissionais
 */
/**
 * Enum para roles de usuário (RBAC)
 */
export const userRoleEnum = mysqlEnum("user_role", [
  "USER",
  "GESTOR_MEDICO",
  "GESTOR_PLUS",
]);

/**
 * Papel no vínculo institucional. Precisa de enum próprio: reusar
 * `userRoleEnum` faria o Drizzle criar a coluna como `user_role` (o
 * nome do enum), e o `drizzle-kit push` do CI não materializaria
 * `role_in_institution`. A migração manual
 * `2026-08-27-professional-institutions-role.sql` já usa este nome.
 */
export const roleInInstitutionEnum = mysqlEnum("role_in_institution", [
  "USER",
  "GESTOR_MEDICO",
  "GESTOR_PLUS",
]);

/**
 * Catálogo versionado de especialidades reconhecidas pelo CFM. O código é a
 * identidade estável; o nome é somente o rótulo oficial da versão declarada.
 */
export const medicalSpecialties = mysqlTable(
  "medical_specialties",
  {
    id: int("id").primaryKey().autoincrement(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    sourceVersion: varchar("source_version", { length: 32 }).notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: int("sort_order").notNull(),
  },
  (table) => ({
    uniqMedicalSpecialtyCode: unique("uniq_medical_specialty_code").on(
      table.code,
    ),
    idxMedicalSpecialtySortOrder: index("idx_medical_specialty_sort_order").on(
      table.sortOrder,
    ),
  }),
);

export type MedicalSpecialtyRow = typeof medicalSpecialties.$inferSelect;
export type InsertMedicalSpecialty = typeof medicalSpecialties.$inferInsert;

/**
 * Especialidades assistenciais descritas por setor.
 *
 * Esta relação é deliberadamente distinta de `schedule_contexts` e da
 * qualificação de `professionals`: ela descreve o serviço prestado pelo
 * setor, mas não autoriza, impede ou seleciona profissionais para uma
 * escala. A chave composta mantém a referência na topologia canônica.
 */
export const sectorServiceSpecialties = mysqlTable(
  "sector_service_specialties",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id").notNull(),
    hospitalId: int("hospital_id").notNull(),
    sectorId: int("sector_id").notNull(),
    medicalSpecialtyId: int("medical_specialty_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqSectorServiceSpecialty: unique("uniq_sector_service_specialty").on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
      table.medicalSpecialtyId,
    ),
    idxSectorServiceSpecialtySpecialty: index(
      "idx_sector_service_specialty_specialty",
    ).on(table.medicalSpecialtyId, table.institutionId),
    fkSectorServiceSpecialtyInstitution: foreignKey({
      columns: [table.institutionId],
      foreignColumns: [institutions.id],
      name: "fk_sector_service_specialty_institution",
    }),
    fkSectorServiceSpecialtyHospital: foreignKey({
      columns: [table.hospitalId],
      foreignColumns: [hospitals.id],
      name: "fk_sector_service_specialty_hospital",
    }),
    fkSectorServiceSpecialtySector: foreignKey({
      columns: [table.sectorId],
      foreignColumns: [sectors.id],
      name: "fk_sector_service_specialty_sector",
    }),
    fkSectorServiceSpecialtyMedicalSpecialty: foreignKey({
      columns: [table.medicalSpecialtyId],
      foreignColumns: [medicalSpecialties.id],
      name: "fk_sector_service_specialty_medical_specialty",
    }),
    fkSectorServiceSpecialtyTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId, table.sectorId],
      foreignColumns: [
        sectors.institutionId,
        sectors.hospitalId,
        sectors.id,
      ],
      name: "fk_sector_service_specialty_topology",
    }),
  }),
);

export type SectorServiceSpecialty =
  typeof sectorServiceSpecialties.$inferSelect;
export type InsertSectorServiceSpecialty =
  typeof sectorServiceSpecialties.$inferInsert;

/** Perfil assistencial que não representa título de especialista do CFM. */
export const operationalProfileCodeEnum = mysqlEnum(
  "operational_profile_code",
  ["MEDICO_GENERALISTA", "RESIDENTE_ANESTESIOLOGIA"],
);

export const scheduleContextAdmissionPolicyEnum = mysqlEnum(
  "admission_policy",
  [
    "PINNED_QUALIFICATION",
    "ALL_CFM_SPECIALTIES",
    "ALL_CFM_EXCEPT_GENERALIST",
    "QUALIFICATION_ALLOWLIST",
  ],
);

export const professionals = mysqlTable(
  "professionals",
  {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    name: varchar("name", { length: 255 }).notNull(),
    role: varchar("role", { length: 100 }).notNull(), // Ex: "Médico", "Enfermeiro", "Técnico"
    /**
     * Serviço/especialidade (2026-08-19): eixo de separação entre
     * especialistas (ex.: "Anestesiologia", "Cirurgia Geral"). Alinhado
     * ao campo specialty do Comunica+. NULL = sem restrição (legado).
     */
    specialty: varchar("specialty", { length: 100 }),
    /** Especialidade CFM canônica. NULL preserva cadastros legados/ignorados. */
    medicalSpecialtyId: int("medical_specialty_id").references(
      () => medicalSpecialties.id,
    ),
    /** Perfil não-CFM, por exemplo médico generalista. */
    operationalProfileCode: operationalProfileCodeEnum,
    /**
     * Código de profissão do catálogo de domínio (`lib/profession-definitions.ts`).
     * Identidade profissional — não é papel institucional, não concede gestão
     * nem ocupação de plantão. VARCHAR (não ENUM MySQL) para permitir extensão
     * sem redesenhar AuthZ. NULL = legado ainda não classificado.
     * Sem UNIQUE(user_id): a cardinalidade 1:1 não está provada no runtime.
     */
    professionCode: varchar("profession_code", { length: 64 }),
    /**
     * Nome livre quando professionCode = OTHER. Obrigatório no produto para
     * Outro; a coluna permanece nullable para legado e linhas sem classificação.
     */
    customProfessionName: varchar("custom_profession_name", { length: 120 }),
    userRole: userRoleEnum.notNull().default("USER"), // RBAC: USER, GESTOR_MEDICO, GESTOR_PLUS
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxProfessionalsMedicalSpecialty: index(
      "idx_professionals_medical_specialty",
    ).on(table.medicalSpecialtyId),
    idxProfessionalsProfessionCode: index("idx_professionals_profession_code").on(
      table.professionCode,
    ),
    chkProfessionalsAtMostOneMedicalQualification: check(
      "chk_professionals_at_most_one_medical_qualification",
      sql`(${table.medicalSpecialtyId} is null or ${table.operationalProfileCode} is null)`,
    ),
  }),
);

/**
 * Vínculo multi-institucional de profissionais (SaaS multi-tenant enterprise).
 * Permite que o mesmo profissional atue em múltiplos clientes sem duplicar usuário.
 */
export const professionalInstitutions = mysqlTable(
  "professional_institutions",
  {
    id: int("id").primaryKey().autoincrement(),
    professionalId: int("professional_id")
      .notNull()
      .references(() => professionals.id, { onDelete: "cascade" }),
    userId: int("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    /** Migração manual: drizzle/migrations/manual/2026-08-27-professional-institutions-role.sql */
    roleInInstitution: roleInInstitutionEnum.notNull().default("USER"),
    isPrimary: boolean("is_primary").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqProfessionalInstitution: unique().on(
      table.professionalId,
      table.institutionId,
    ),
    uniqUserInstitution: unique().on(table.userId, table.institutionId),
    idxProfessionalInstitution: index("idx_prof_inst_prof").on(
      table.professionalId,
      table.institutionId,
    ),
    idxInstitutionActive: index("idx_prof_inst_institution_active").on(
      table.institutionId,
      table.active,
    ),
    idxProfessionalInstitutionId: index("idx_prof_inst_institution_id").on(
      table.institutionId,
      table.id,
    ),
  }),
);

/**
 * Controle de acesso de profissionais (permissões TI)
 * Define quais hospitais/setores cada profissional pode atuar
 */
export const professionalAccess = mysqlTable(
  "professional_access",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    professionalId: int("professional_id")
      .notNull()
      .references(() => professionals.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    sectorId: int("sector_id").references(() => sectors.id), // Null = acesso a todos os setores do hospital
    canAccess: boolean("can_access").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxProfessionalAccessInstitutionId: index(
      "idx_prof_access_institution_id",
    ).on(table.institutionId, table.id),
    idxProfessionalAccessActorActive: index("idx_prof_access_actor_active").on(
      table.institutionId,
      table.professionalId,
      table.canAccess,
      table.hospitalId,
      table.sectorId,
    ),
  }),
);

/**
 * Jurisdição dos gestores médicos (manager_scope)
 * Define quais hospitais/setores cada GESTOR_MEDICO pode gerenciar
 */
export const managerScope = mysqlTable(
  "manager_scope",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    managerProfessionalId: int("manager_professional_id")
      .notNull()
      .references(() => professionals.id, { onDelete: "cascade" }),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id, { onDelete: "cascade" }),
    sectorId: int("sector_id").references(() => sectors.id, {
      onDelete: "cascade",
    }), // Null = gestor de todo o hospital
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxManagerScopeInstitutionId: index("idx_manager_scope_institution_id").on(
      table.institutionId,
      table.id,
    ),
    idxManagerScopeActorActive: index("idx_manager_scope_actor_active").on(
      table.institutionId,
      table.managerProfessionalId,
      table.active,
      table.hospitalId,
      table.sectorId,
    ),
  }),
);

/**
 * Configurações por instituição
 */
export const institutionConfig = mysqlTable(
  "institution_config",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .unique()
      .references(() => institutions.id, { onDelete: "cascade" }),
    editWindowDays: int("edit_window_days").notNull().default(3), // Janela de edição retroativa (0 = não permite passado)
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxInstitutionConfigInstitutionId: index(
      "idx_institution_config_institution_id",
    ).on(table.institutionId, table.id),
  }),
);

/**
 * Enum para tipo de alocação
 */
export const assignmentTypeEnum = mysqlEnum("assignment_type", [
  "ON_DUTY",
  "BACKUP",
  "ON_CALL",
]);

/**
 * Templates de turnos (customizáveis por hospital ou setor)
 * Ex: "Manhã 7h-13h", "Cinderela 19h-1h", "Noite UTI 19h-7h"
 *
 * Regra: templates de setor (sectorId != null) sobrepõem templates do hospital (sectorId = null)
 */
export const shiftTemplates = mysqlTable(
  "shift_templates",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    sectorId: int("sector_id").references(() => sectors.id), // Null = template do hospital, não-null = template específico do setor
    name: varchar("name", { length: 100 }).notNull(), // Ex: "Manhã", "Tarde", "Noite", "Cinderela"
    startTime: time("start_time").notNull(), // Horário de início (HH:MM:SS)
    endTime: time("end_time").notNull(), // Horário de término (HH:MM:SS)
    isActive: boolean("is_active").notNull().default(true),
    priority: int("priority").notNull().default(0), // Ordenação na UI (menor = mais prioritário)
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxShiftTemplateInstitutionId: index(
      "idx_shift_templates_institution_id",
    ).on(table.institutionId, table.id),
  }),
);

/**
 * Escala operacional selecionável pelo usuário.
 *
 * Uma escala é o cruzamento instituição → hospital → setor com política
 * de admissão: qualificação fixa, todas as especialidades CFM, ou todas
 * exceto generalista. Dois índices UNIQUE complementares cobrem o caso
 * pinado porque o MySQL permite múltiplos NULLs em um índice composto.
 */
export const scheduleContexts = mysqlTable(
  "schedule_contexts",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    sectorId: int("sector_id")
      .notNull()
      .references(() => sectors.id),
    medicalSpecialtyId: int("medical_specialty_id").references(
      () => medicalSpecialties.id,
    ),
    operationalProfileCode: operationalProfileCodeEnum,
    admissionPolicy: scheduleContextAdmissionPolicyEnum
      .notNull()
      .default("PINNED_QUALIFICATION"),
    active: boolean("active").notNull().default(true),
    /**
     * Slot físico da escala ativa. NULL preserva múltiplos contextos
     * históricos inativos; 1 torna impossível haver dois ativos no setor.
     */
    activeSectorSlot: tinyint("active_sector_slot").generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`IF(\`active\` = 1, 1, NULL)`,
      { mode: "stored" },
    ),
  },
  (table) => ({
    uniqScheduleContextSpecialty: unique("uniq_schedule_context_specialty").on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
      table.medicalSpecialtyId,
    ),
    uniqScheduleContextOperationalProfile: unique(
      "uniq_schedule_context_operational_profile",
    ).on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
      table.operationalProfileCode,
    ),
    idxScheduleContextInstitution: index("idx_schedule_context_institution").on(
      table.institutionId,
      table.id,
    ),
    idxScheduleContextHospital: index("idx_schedule_context_hospital").on(
      table.hospitalId,
    ),
    idxScheduleContextSector: index("idx_schedule_context_sector").on(
      table.sectorId,
    ),
    idxScheduleContextMedicalSpecialty: index(
      "idx_schedule_context_medical_specialty",
    ).on(table.medicalSpecialtyId),
    uniqScheduleContextTopologyId: unique(
      "uniq_schedule_context_topology_id",
    ).on(table.institutionId, table.hospitalId, table.sectorId, table.id),
    uniqScheduleContextActiveSector: unique(
      "uniq_schedule_context_active_sector",
    ).on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
      table.activeSectorSlot,
    ),
    fkScheduleContextHospitalTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId],
      foreignColumns: [hospitals.institutionId, hospitals.id],
      name: "fk_schedule_context_hospital_topology",
    }),
    fkScheduleContextSectorTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId, table.sectorId],
      foreignColumns: [sectors.institutionId, sectors.hospitalId, sectors.id],
      name: "fk_schedule_context_sector_topology",
    }),
    chkScheduleContextQualificationMatchesPolicy: check(
      "chk_schedule_context_qualification_matches_policy",
      sql`(
        (
          ${table.admissionPolicy} = 'PINNED_QUALIFICATION'
          and (
            (${table.medicalSpecialtyId} is not null and ${table.operationalProfileCode} is null)
            or
            (${table.medicalSpecialtyId} is null and ${table.operationalProfileCode} is not null)
          )
        )
        or
        (
          ${table.admissionPolicy} in (
            'ALL_CFM_SPECIALTIES',
            'ALL_CFM_EXCEPT_GENERALIST',
            'QUALIFICATION_ALLOWLIST'
          )
          and ${table.medicalSpecialtyId} is null
          and ${table.operationalProfileCode} is null
        )
      )`,
    ),
  }),
);

/**
 * Qualificações permitidas em escalas com política QUALIFICATION_ALLOWLIST.
 * Uma escala por setor; a admissão é validada contra esta lista.
 */
export const scheduleContextAllowedQualifications = mysqlTable(
  "schedule_context_allowed_qualifications",
  {
    id: int("id").primaryKey().autoincrement(),
    scheduleContextId: int("schedule_context_id").notNull(),
    medicalSpecialtyId: int("medical_specialty_id"),
    operationalProfileCode: operationalProfileCodeEnum,
  },
  (table) => ({
    uniqAllowlistSpecialty: unique("uniq_sc_allowlist_specialty").on(
      table.scheduleContextId,
      table.medicalSpecialtyId,
    ),
    uniqAllowlistProfile: unique("uniq_sc_allowlist_profile").on(
      table.scheduleContextId,
      table.operationalProfileCode,
    ),
    idxAllowlistContext: index("idx_sc_allowlist_context").on(
      table.scheduleContextId,
    ),
    fkScAllowlistContext: foreignKey({
      columns: [table.scheduleContextId],
      foreignColumns: [scheduleContexts.id],
      name: "fk_sc_allowlist_context",
    }).onDelete("cascade"),
    fkScAllowlistSpecialty: foreignKey({
      columns: [table.medicalSpecialtyId],
      foreignColumns: [medicalSpecialties.id],
      name: "fk_sc_allowlist_specialty",
    }),
    chkAllowlistExactlyOneQualification: check(
      "chk_sc_allowlist_exactly_one_qualification",
      sql`(
        (${table.medicalSpecialtyId} is not null and ${table.operationalProfileCode} is null)
        or
        (${table.medicalSpecialtyId} is null and ${table.operationalProfileCode} is not null)
      )`,
    ),
  }),
);

/** Weekly staffing targets, scoped to one operational schedule. */
export const scheduleCapacityRules = mysqlTable(
  "schedule_capacity_rules",
  {
    id: int("id").primaryKey().autoincrement(),
    scheduleContextId: int("schedule_context_id").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    weekday: tinyint("weekday").notNull(),
    requiredCapacity: int("required_capacity").notNull(),
  },
  (table) => ({
    uniqScheduleCapacityRule: unique("uniq_schedule_capacity_rule").on(
      table.scheduleContextId,
      table.startTime,
      table.endTime,
      table.weekday,
    ),
    fkCapacityRuleContext: foreignKey({
      columns: [table.scheduleContextId],
      foreignColumns: [scheduleContexts.id],
      name: "fk_capacity_rule_context",
    }),
    chkCapacityRuleWeekday: check(
      "chk_capacity_rule_weekday",
      sql`${table.weekday} BETWEEN 0 AND 6`,
    ),
    chkCapacityRuleValue: check(
      "chk_capacity_rule_value",
      sql`${table.requiredCapacity} BETWEEN 1 AND 1000`,
    ),
  }),
);

export type ScheduleContext = typeof scheduleContexts.$inferSelect;
export type InsertScheduleContext = typeof scheduleContexts.$inferInsert;

/**
 * Convite nominal de uma escala (instituição + hospital + setor).
 * O código em claro só vai no e-mail do convidado; o banco guarda o hash.
 * Uso único, 24 h, amarrado a um usuário já cadastrado.
 */
export const scheduleInvites = mysqlTable(
  "schedule_invites",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    sectorId: int("sector_id")
      .notNull()
      .references(() => sectors.id),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    createdByUserId: int("created_by_user_id")
      .notNull()
      .references(() => users.id),
    invitedUserId: int("invited_user_id").references(() => users.id),
    invitedEmail: varchar("invited_email", { length: 320 }),
    maxRedemptions: int("max_redemptions").notNull().default(1),
    redeemedCount: int("redeemed_count").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    declinedAt: timestamp("declined_at"),
    declinedByUserId: int("declined_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqScheduleInviteCodeHash: unique("uniq_schedule_invite_code_hash").on(
      table.codeHash,
    ),
    // Dá suporte à FK composta do destinatário de evento sem depender de
    // uma alteração manual posterior em bancos criados a partir do schema.
    uniqScheduleInvitesIdInstitution: unique(
      "uniq_schedule_invites_id_institution",
    ).on(table.id, table.institutionId),
    idxScheduleInviteInstitution: index("idx_schedule_invite_institution").on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
    ),
    idxScheduleInviteNamed: index("idx_schedule_invite_named").on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
      table.invitedUserId,
    ),
    fkScheduleInviteHospitalTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId],
      foreignColumns: [hospitals.institutionId, hospitals.id],
      name: "fk_schedule_invite_hospital_topology",
    }),
    fkScheduleInviteSectorTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId, table.sectorId],
      foreignColumns: [sectors.institutionId, sectors.hospitalId, sectors.id],
      name: "fk_schedule_invite_sector_topology",
    }),
  }),
);

export type ScheduleInvite = typeof scheduleInvites.$inferSelect;

// ========================================
// INSTÂNCIAS DE TURNO E ALOCAÇÕES (V2)
// ========================================

/**
 * Instâncias de turno (uma instância = um bloco de horário real no calendário)
 */
export const shiftInstances = mysqlTable(
  "shift_instances",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    sectorId: int("sector_id")
      .notNull()
      .references(() => sectors.id),
    /** Contexto canônico; NULL mantém instâncias legadas não classificadas. */
    scheduleContextId: int("schedule_context_id").references(
      () => scheduleContexts.id,
    ),
    /** NULL preserves pre-capacity historical records. New turns default to one place. */
    requiredCapacity: int("required_capacity").default(1),
    capacityContextId: int("capacity_context_id").generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`IF(\`required_capacity\` IS NULL, NULL, \`schedule_context_id\`)`,
      { mode: "stored" },
    ),
    label: varchar("label", { length: 100 }).notNull(),
    /** Serviço/especialidade do plantão (separação entre especialistas). */
    specialty: varchar("specialty", { length: 100 }),
    startAt: timestamp("start_at").notNull(),
    endAt: timestamp("end_at").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("VAGO"),

    // Modalidade estruturada (docs/product/escala-ux.md §5).
    // Antes destes campos, `label` era texto livre ("Plantão", "Sobreaviso")
    // e não suportava filtragem nem cálculo financeiro. A estrutura aqui
    // separa: o que é (PLANTAO vs SOBREAVISO), o que cobre quando é
    // plantão (urgência vs eletivas), e como é remunerado.
    modality: mysqlEnum("modality", ["PLANTAO", "SOBREAVISO"])
      .notNull()
      .default("PLANTAO"),
    // coverage_type só faz sentido para PLANTAO; null em SOBREAVISO.
    coverageType: mysqlEnum("coverage_type", [
      "URGENCIA_EMERGENCIA",
      "ELETIVAS",
    ]),
    paymentModel: mysqlEnum("payment_model", [
      "FIXO",
      "FIXO_PRODUTIVIDADE_TETO",
      "FIXO_PRODUTIVIDADE_SEM_TETO",
      "PRODUTIVIDADE_PURA",
    ])
      .notNull()
      .default("FIXO"),
    // Teto da produtividade em BRL; só usado quando paymentModel inclui
    // teto. decimal(12,2) suporta valores até 9.999.999.999,99 — mais
    // do que suficiente para um plantão.
    productivityCapBrl: decimal("productivity_cap_brl", {
      precision: 12,
      scale: 2,
    }),

    createdBy: int("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxShiftInstanceInstitutionId: index(
      "idx_shift_instances_institution_id",
    ).on(table.institutionId, table.id),
    uniqShiftCapacitySlot: unique("uniq_shift_capacity_slot").on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
      table.capacityContextId,
      table.startAt,
      table.endAt,
    ),
    chkShiftCapacity: check(
      "chk_shift_capacity",
      sql`${table.requiredCapacity} IS NULL OR ${table.requiredCapacity} BETWEEN 1 AND 1000`,
    ),
    // Chave-pai física da FK composta de eventos operacionais. Mantém o
    // vínculo de um turno com a topologia em instalações novas do schema.
    uniqShiftInstancesTopologyId: unique("uniq_shift_instances_topology_id").on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
      table.id,
    ),
    idxShiftInstanceScheduleContext: index(
      "idx_shift_instances_schedule_context",
    ).on(table.institutionId, table.scheduleContextId),
    idxShiftInstanceVacancyLookup: index(
      "idx_shift_instances_vacancy_lookup",
    ).on(
      table.institutionId,
      table.status,
      table.scheduleContextId,
      table.startAt,
    ),
    fkShiftInstanceScheduleContextTopology: foreignKey({
      columns: [
        table.institutionId,
        table.hospitalId,
        table.sectorId,
        table.scheduleContextId,
      ],
      foreignColumns: [
        scheduleContexts.institutionId,
        scheduleContexts.hospitalId,
        scheduleContexts.sectorId,
        scheduleContexts.id,
      ],
      name: "fk_shift_instance_schedule_context_topology",
    }),
    // Permite filtragem por modalidade no Radar (e.g. mostrar só
    // plantões PLANTAO/URGENCIA_EMERGENCIA num determinado dia).
    idxShiftInstanceModality: index("idx_shift_instances_modality").on(
      table.institutionId,
      table.modality,
    ),
  }),
);

/**
 * Alocações de profissionais a turnos (V2)
 */
export const shiftAssignmentsV2 = mysqlTable(
  "shift_assignments_v2",
  {
    id: int("id").primaryKey().autoincrement(),
    shiftInstanceId: int("shift_instance_id")
      .notNull()
      .references(() => shiftInstances.id),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    sectorId: int("sector_id")
      .notNull()
      .references(() => sectors.id),
    professionalId: int("professional_id")
      .notNull()
      .references(() => professionals.id),
    assignmentType: assignmentTypeEnum.notNull().default("ON_DUTY"),
    status: varchar("status", { length: 20 }).notNull().default("PENDENTE"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: int("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxShiftAssignmentInstitutionId: index(
      "idx_shift_assignments_institution_id",
    ).on(table.institutionId, table.id),
    idxShiftAssignmentShiftActive: index(
      "idx_shift_assignments_shift_active",
    ).on(table.shiftInstanceId, table.isActive),
    idxShiftAssignmentProfessionalActive: index(
      "idx_shift_assignments_prof_active",
    ).on(table.professionalId, table.isActive, table.shiftInstanceId),
    // Chave-pai física da FK composta de eventos operacionais. A migration
    // manual conserva o mesmo nome para instalações legadas.
    uniqShiftAssignmentsTopologyId: unique(
      "uniq_shift_assignments_topology_id",
    ).on(table.institutionId, table.hospitalId, table.sectorId, table.id),
  }),
);

/**
 * Idempotência de lembretes de plantão.
 * Evita envio duplicado do mesmo lembrete para o mesmo usuário/plantão.
 */
export const shiftReminders = mysqlTable(
  "shift_reminders",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    shiftInstanceId: int("shift_instance_id")
      .notNull()
      .references(() => shiftInstances.id),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    reminderType: mysqlEnum("reminder_type", ["PRE_SHIFT"])
      .notNull()
      .default("PRE_SHIFT"),
    reminderAt: timestamp("reminder_at").notNull(),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqShiftReminder: unique().on(
      table.shiftInstanceId,
      table.userId,
      table.reminderType,
    ),
    idxShiftRemindersInstitutionId: index(
      "idx_shift_reminders_institution_id",
    ).on(table.institutionId, table.id),
    idxShiftRemindersReminderAt: index("idx_shift_reminders_reminder_at").on(
      table.reminderAt,
    ),
  }),
);

/**
 * Audit log para turnos (governança e compliance)
 */
export const shiftAuditLog = mysqlTable(
  "shift_audit_log",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    event: varchar("event", { length: 50 }).notNull(),
    shiftInstanceId: int("shift_instance_id")
      .notNull()
      .references(() => shiftInstances.id),
    professionalId: int("professional_id").references(() => professionals.id),
    reason: text("reason"),
    metadata: json("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxShiftAuditInstitutionId: index("idx_shift_audit_institution_id").on(
      table.institutionId,
      table.id,
    ),
  }),
);

/**
 * Push notification tokens
 */
export const pushTokens = mysqlTable(
  "push_tokens",
  {
    id: int("id").primaryKey().autoincrement(),
    // Proveniência do tenant ativo no registro, nunca autoridade de entrega.
    // O token pertence à conta/dispositivo e pode nascer antes da hidratação
    // do tenant; o destino é sempre revalidado no intent de push.
    institutionId: int("institution_id").references(() => institutions.id),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    // Expo tokens são opacos e case-sensitive. A mesma igualdade binária
    // governa UNIQUE, queries e o SHA-256 usado pelo mutex distribuído.
    token: binaryVarchar("token", { length: 512 }).notNull(),
    platform: varchar("platform", { length: 20 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqPushToken: unique("uniq_push_token").on(table.token),
    chkPushTokenNoWhitespace: check(
      "chk_push_token_no_whitespace",
      sql`${table.token} NOT REGEXP '[[:space:]]'`,
    ),
    idxPushTokenInstitutionId: index("idx_push_tokens_institution_id").on(
      table.institutionId,
      table.id,
    ),
  }),
);

/**
 * Notifications
 */
export const notifications = mysqlTable(
  "notifications",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    type: mysqlEnum("type", ["GENERAL", "SHIFT_REMINDER"])
      .notNull()
      .default("GENERAL"),
    status: mysqlEnum("status", ["PENDING", "SENT", "FAILED"])
      .notNull()
      .default("PENDING"),
    shiftInstanceId: int("shift_instance_id").references(
      () => shiftInstances.id,
    ),
    reminderType: mysqlEnum("reminder_type", ["RADAR_11H", "RADAR_3H"]),
    dedupKey: varchar("dedup_key", { length: 191 }).unique(),
    deepLink: varchar("deep_link", { length: 1024 }),
    providerReceipt: json("provider_receipt"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at"),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxNotificationInstitutionId: index("idx_notifications_institution_id").on(
      table.institutionId,
      table.id,
    ),
    idxNotificationsStatus: index("idx_notifications_status").on(
      table.status,
      table.createdAt,
    ),
  }),
);

/**
 * Fundação persistente de eventos operacionais. Nenhum emissor, worker ou
 * entrega usa estas tabelas nesta frente: elas registram apenas a topologia
 * canônica que uma integração futura deverá respeitar.
 *
 * As 21 FKs simples são declaradas explicitamente — sem `.references()` nas
 * colunas — para que o nome físico seja estável e <= 64 caracteres no MySQL.
 * As FKs compostas mantêm a hierarquia instituição → hospital → setor no
 * banco, mesmo se um writer futuro ignorar a validação de aplicação.
 *
 * Esta fundação não autoriza ativação de writers, workers nem entregas. Antes
 * de qualquer ativação, uma frente própria precisa provar e impor duas
 * coerências que a topologia comum não expressa sozinha: (1) o profissional
 * atribuído ao ator pertence ao mesmo usuário e à mesma instituição; e (2)
 * quando contexto, turno e alocação coexistem, a alocação pertence ao turno e
 * o turno pertence ao contexto informado. Sem essa prova, o armazenamento
 * permanece somente como fundação não ativa.
 */
export const operationalEvents = mysqlTable(
  "operational_events",
  {
    id: int("id").primaryKey().autoincrement(),
    idempotencyKeyHash: binaryVarchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    eventHash: varchar("event_hash", { length: 64 }).notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    deliveryPolicy: mysqlEnum("delivery_policy", [
      "NOTIFY",
      "BROADCAST",
      "SILENT_AUDITED",
    ]).notNull(),
    recipientResolution: mysqlEnum("recipient_resolution", [
      "RESOLVED",
      "NO_ELIGIBLE_RECIPIENTS",
      "NO_RESPONSIBLE_MANAGERS",
      "NO_DELIVERABLE_RECIPIENTS",
      "NOT_APPLICABLE",
    ]).notNull(),
    aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
    aggregateId: int("aggregate_id").notNull(),
    aggregateVersion: int("aggregate_version").notNull(),
    transitionFrom: varchar("transition_from", { length: 80 }),
    transitionTo: varchar("transition_to", { length: 80 }),
    actorKind: mysqlEnum("actor_kind", ["USER", "SYSTEM"]).notNull(),
    actorUserId: int("actor_user_id"),
    actorProfessionalId: int("actor_professional_id"),
    actorRole: varchar("actor_role", { length: 32 }).notNull(),
    institutionId: int("institution_id").notNull(),
    hospitalId: int("hospital_id"),
    scopeKind: mysqlEnum("scope_kind", [
      "INSTITUTION",
      "HOSPITAL",
      "SECTOR",
    ]).notNull(),
    sectorId: int("sector_id"),
    scheduleContextId: int("schedule_context_id"),
    shiftInstanceId: int("shift_instance_id"),
    assignmentId: int("assignment_id"),
    occurredAt: datetime("occurred_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxOperationalEventContext: index("idx_operational_events_context").on(
      table.institutionId,
      table.hospitalId,
      table.sectorId,
      table.occurredAt,
    ),
    idxOperationalEventAggregate: index("idx_operational_events_aggregate").on(
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    uniqOperationalEventIdempotency: unique(
      "uniq_operational_event_idempotency",
    ).on(table.institutionId, table.idempotencyKeyHash),
    uniqOperationalEventIdInstitution: unique(
      "uniq_operational_events_id_institution",
    ).on(table.id, table.institutionId),
    idxOperationalEventShift: index("idx_operational_events_shift").on(
      table.shiftInstanceId,
    ),
    fkOperationalEventActorUser: foreignKey({
      columns: [table.actorUserId],
      foreignColumns: [users.id],
      name: "fk_operational_events_actor_user",
    }),
    fkOperationalEventActorUserInstitution: foreignKey({
      columns: [table.actorUserId, table.institutionId],
      foreignColumns: [
        professionalInstitutions.userId,
        professionalInstitutions.institutionId,
      ],
      name: "fk_operational_events_actor_user_institution",
    }),
    fkOperationalEventActorProfessional: foreignKey({
      columns: [table.actorProfessionalId],
      foreignColumns: [professionals.id],
      name: "fk_operational_events_actor_professional",
    }),
    fkOperationalEventInstitution: foreignKey({
      columns: [table.institutionId],
      foreignColumns: [institutions.id],
      name: "fk_operational_events_institution",
    }),
    fkOperationalEventHospital: foreignKey({
      columns: [table.hospitalId],
      foreignColumns: [hospitals.id],
      name: "fk_operational_events_hospital",
    }),
    fkOperationalEventSector: foreignKey({
      columns: [table.sectorId],
      foreignColumns: [sectors.id],
      name: "fk_operational_events_sector",
    }),
    fkOperationalEventScheduleContext: foreignKey({
      columns: [table.scheduleContextId],
      foreignColumns: [scheduleContexts.id],
      name: "fk_operational_events_schedule_context",
    }),
    fkOperationalEventShift: foreignKey({
      columns: [table.shiftInstanceId],
      foreignColumns: [shiftInstances.id],
      name: "fk_operational_events_shift",
    }),
    fkOperationalEventAssignment: foreignKey({
      columns: [table.assignmentId],
      foreignColumns: [shiftAssignmentsV2.id],
      name: "fk_operational_events_assignment",
    }),
    fkOperationalEventHospitalTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId],
      foreignColumns: [hospitals.institutionId, hospitals.id],
      name: "fk_operational_events_hospital_topology",
    }),
    fkOperationalEventSectorTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId, table.sectorId],
      foreignColumns: [sectors.institutionId, sectors.hospitalId, sectors.id],
      name: "fk_operational_events_sector_topology",
    }),
    fkOperationalEventScheduleContextTopology: foreignKey({
      columns: [
        table.institutionId,
        table.hospitalId,
        table.sectorId,
        table.scheduleContextId,
      ],
      foreignColumns: [
        scheduleContexts.institutionId,
        scheduleContexts.hospitalId,
        scheduleContexts.sectorId,
        scheduleContexts.id,
      ],
      name: "fk_operational_events_schedule_context_topology",
    }),
    fkOperationalEventShiftTopology: foreignKey({
      columns: [
        table.institutionId,
        table.hospitalId,
        table.sectorId,
        table.shiftInstanceId,
      ],
      foreignColumns: [
        shiftInstances.institutionId,
        shiftInstances.hospitalId,
        shiftInstances.sectorId,
        shiftInstances.id,
      ],
      name: "fk_operational_events_shift_topology",
    }),
    fkOperationalEventAssignmentTopology: foreignKey({
      columns: [
        table.institutionId,
        table.hospitalId,
        table.sectorId,
        table.assignmentId,
      ],
      foreignColumns: [
        shiftAssignmentsV2.institutionId,
        shiftAssignmentsV2.hospitalId,
        shiftAssignmentsV2.sectorId,
        shiftAssignmentsV2.id,
      ],
      name: "fk_operational_events_assignment_topology",
    }),
    chkOperationalEventScope: check(
      "chk_operational_event_scope",
      sql`(
        (
          ${table.scopeKind} = 'INSTITUTION'
          AND ${table.hospitalId} IS NULL
          AND ${table.sectorId} IS NULL
          AND ${table.scheduleContextId} IS NULL
          AND ${table.shiftInstanceId} IS NULL
          AND ${table.assignmentId} IS NULL
        )
        OR
        (
          ${table.scopeKind} = 'HOSPITAL'
          AND ${table.hospitalId} IS NOT NULL
          AND ${table.sectorId} IS NULL
          AND ${table.scheduleContextId} IS NULL
          AND ${table.shiftInstanceId} IS NULL
          AND ${table.assignmentId} IS NULL
        )
        OR
        (
          ${table.scopeKind} = 'SECTOR'
          AND ${table.hospitalId} IS NOT NULL
          AND ${table.sectorId} IS NOT NULL
        )
      )`,
    ),
    chkOperationalEventActor: check(
      "chk_operational_event_actor",
      sql`(
        (
          ${table.actorKind} = 'USER'
          AND ${table.actorUserId} IS NOT NULL
        )
        OR
        (
          ${table.actorKind} = 'SYSTEM'
          AND ${table.actorUserId} IS NULL
          AND ${table.actorProfessionalId} IS NULL
        )
      )`,
    ),
  }),
);

export const operationalEventRelatedContexts = mysqlTable(
  "operational_event_related_contexts",
  {
    id: int("id").primaryKey().autoincrement(),
    operationalEventId: int("operational_event_id").notNull(),
    relationKind: mysqlEnum("relation_kind", [
      "COUNTERPART",
      "AFFECTED_SCOPE",
    ]).notNull(),
    institutionId: int("institution_id").notNull(),
    hospitalId: int("hospital_id"),
    scopeKind: mysqlEnum("scope_kind", [
      "INSTITUTION",
      "HOSPITAL",
      "SECTOR",
    ]).notNull(),
    sectorId: int("sector_id"),
    scheduleContextId: int("schedule_context_id"),
    shiftInstanceId: int("shift_instance_id"),
    assignmentId: int("assignment_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxOperationalEventRelatedContext: index(
      "idx_operational_event_related_context",
    ).on(table.operationalEventId, table.relationKind, table.id),
    fkOperationalEventRelatedContextEventInstitution: foreignKey({
      columns: [table.operationalEventId, table.institutionId],
      foreignColumns: [operationalEvents.id, operationalEvents.institutionId],
      name: "fk_operational_event_related_context_event_institution",
    }).onDelete("cascade"),
    fkOperationalEventRelatedContextInstitution: foreignKey({
      columns: [table.institutionId],
      foreignColumns: [institutions.id],
      name: "fk_operational_event_related_context_institution",
    }),
    fkOperationalEventRelatedContextHospital: foreignKey({
      columns: [table.hospitalId],
      foreignColumns: [hospitals.id],
      name: "fk_operational_event_related_context_hospital",
    }),
    fkOperationalEventRelatedContextSector: foreignKey({
      columns: [table.sectorId],
      foreignColumns: [sectors.id],
      name: "fk_operational_event_related_context_sector",
    }),
    fkOperationalEventRelatedContextScheduleContext: foreignKey({
      columns: [table.scheduleContextId],
      foreignColumns: [scheduleContexts.id],
      name: "fk_operational_event_related_context_schedule_context",
    }),
    fkOperationalEventRelatedContextShift: foreignKey({
      columns: [table.shiftInstanceId],
      foreignColumns: [shiftInstances.id],
      name: "fk_operational_event_related_context_shift",
    }),
    fkOperationalEventRelatedContextAssignment: foreignKey({
      columns: [table.assignmentId],
      foreignColumns: [shiftAssignmentsV2.id],
      name: "fk_operational_event_related_context_assignment",
    }),
    fkOperationalEventRelatedContextHospitalTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId],
      foreignColumns: [hospitals.institutionId, hospitals.id],
      name: "fk_operational_event_related_context_hospital_topology",
    }),
    fkOperationalEventRelatedContextSectorTopology: foreignKey({
      columns: [table.institutionId, table.hospitalId, table.sectorId],
      foreignColumns: [sectors.institutionId, sectors.hospitalId, sectors.id],
      name: "fk_operational_event_related_context_sector_topology",
    }),
    fkOperationalEventRelatedContextScheduleContextTopology: foreignKey({
      columns: [
        table.institutionId,
        table.hospitalId,
        table.sectorId,
        table.scheduleContextId,
      ],
      foreignColumns: [
        scheduleContexts.institutionId,
        scheduleContexts.hospitalId,
        scheduleContexts.sectorId,
        scheduleContexts.id,
      ],
      name: "fk_operational_event_related_context_schedule_context_topology",
    }),
    fkOperationalEventRelatedContextShiftTopology: foreignKey({
      columns: [
        table.institutionId,
        table.hospitalId,
        table.sectorId,
        table.shiftInstanceId,
      ],
      foreignColumns: [
        shiftInstances.institutionId,
        shiftInstances.hospitalId,
        shiftInstances.sectorId,
        shiftInstances.id,
      ],
      name: "fk_operational_event_related_context_shift_topology",
    }),
    fkOperationalEventRelatedContextAssignmentTopology: foreignKey({
      columns: [
        table.institutionId,
        table.hospitalId,
        table.sectorId,
        table.assignmentId,
      ],
      foreignColumns: [
        shiftAssignmentsV2.institutionId,
        shiftAssignmentsV2.hospitalId,
        shiftAssignmentsV2.sectorId,
        shiftAssignmentsV2.id,
      ],
      name: "fk_operational_event_related_context_assignment_topology",
    }),
    chkOperationalEventRelatedContextScope: check(
      "chk_operational_event_related_context_scope",
      sql`(
        (
          ${table.scopeKind} = 'INSTITUTION'
          AND ${table.hospitalId} IS NULL
          AND ${table.sectorId} IS NULL
          AND ${table.scheduleContextId} IS NULL
          AND ${table.shiftInstanceId} IS NULL
          AND ${table.assignmentId} IS NULL
        )
        OR
        (
          ${table.scopeKind} = 'HOSPITAL'
          AND ${table.hospitalId} IS NOT NULL
          AND ${table.sectorId} IS NULL
          AND ${table.scheduleContextId} IS NULL
          AND ${table.shiftInstanceId} IS NULL
          AND ${table.assignmentId} IS NULL
        )
        OR
        (
          ${table.scopeKind} = 'SECTOR'
          AND ${table.hospitalId} IS NOT NULL
          AND ${table.sectorId} IS NOT NULL
        )
      )`,
    ),
  }),
);

export const operationalEventRecipients = mysqlTable(
  "operational_event_recipients",
  {
    id: int("id").primaryKey().autoincrement(),
    operationalEventId: int("operational_event_id").notNull(),
    institutionId: int("institution_id").notNull(),
    recipientKind: mysqlEnum("recipient_kind", [
      "USER",
      "SCHEDULE_INVITE",
    ]).notNull(),
    userId: int("user_id"),
    scheduleInviteId: int("schedule_invite_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqOperationalEventRecipientUser: unique(
      "uniq_operational_event_recipient_user",
    ).on(table.operationalEventId, table.userId),
    uniqOperationalEventRecipientInvite: unique(
      "uniq_operational_event_recipient_invite",
    ).on(table.operationalEventId, table.scheduleInviteId),
    idxOperationalEventRecipientTarget: index(
      "idx_operational_event_recipient_target",
    ).on(table.recipientKind, table.userId, table.scheduleInviteId),
    fkOperationalEventRecipientsEvent: foreignKey({
      columns: [table.operationalEventId],
      foreignColumns: [operationalEvents.id],
      name: "fk_operational_event_recipients_event",
    }).onDelete("cascade"),
    fkOperationalEventRecipientEventInstitution: foreignKey({
      columns: [table.operationalEventId, table.institutionId],
      foreignColumns: [operationalEvents.id, operationalEvents.institutionId],
      name: "fk_operational_event_recipient_event_institution",
    }).onDelete("cascade"),
    fkOperationalEventRecipientInstitution: foreignKey({
      columns: [table.institutionId],
      foreignColumns: [institutions.id],
      name: "fk_operational_event_recipient_institution",
    }),
    fkOperationalEventRecipientsUser: foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "fk_operational_event_recipients_user",
    }),
    fkOperationalEventRecipientUserInstitution: foreignKey({
      columns: [table.userId, table.institutionId],
      foreignColumns: [
        professionalInstitutions.userId,
        professionalInstitutions.institutionId,
      ],
      name: "fk_operational_event_recipient_user_institution",
    }),
    fkOperationalEventRecipientsScheduleInvite: foreignKey({
      columns: [table.scheduleInviteId],
      foreignColumns: [scheduleInvites.id],
      name: "fk_operational_event_recipients_schedule_invite",
    }),
    fkOperationalEventRecipientScheduleInviteInstitution: foreignKey({
      columns: [table.scheduleInviteId, table.institutionId],
      foreignColumns: [scheduleInvites.id, scheduleInvites.institutionId],
      name: "fk_operational_event_recipient_schedule_invite_institution",
    }),
    chkOperationalEventRecipientTarget: check(
      "chk_operational_event_recipient_target",
      sql`(
        (${table.recipientKind} = 'USER' AND ${table.userId} IS NOT NULL AND ${table.scheduleInviteId} IS NULL)
        OR
        (${table.recipientKind} = 'SCHEDULE_INVITE' AND ${table.userId} IS NULL AND ${table.scheduleInviteId} IS NOT NULL)
      )`,
    ),
  }),
);

export const notificationDeliveries = mysqlTable(
  "notification_deliveries",
  {
    id: int("id").primaryKey().autoincrement(),
    operationalEventRecipientId: int(
      "operational_event_recipient_id",
    ).notNull(),
    channel: mysqlEnum("channel", ["PUSH", "EMAIL"]).notNull(),
    status: mysqlEnum("status", [
      "QUEUED",
      "PROCESSING",
      "PROVIDER_ACCEPTED",
      "DELIVERED",
      "FAILED",
      "DEAD",
      "SKIPPED",
    ])
      .notNull()
      .default("QUEUED"),
    dedupKey: binaryVarchar("dedup_key", { length: 64 })
      .notNull()
      .unique("uniq_notification_delivery_dedup"),
    attemptCount: int("attempt_count").notNull().default(0),
    availableAt: datetime("available_at").notNull(),
    leaseUntil: datetime("lease_until"),
    providerAcceptedAt: datetime("provider_accepted_at"),
    deliveredAt: datetime("delivered_at"),
    providerReference: varchar("provider_reference", { length: 255 }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqNotificationDeliveryChannel: unique(
      "uniq_notification_delivery_channel",
    ).on(table.operationalEventRecipientId, table.channel),
    idxNotificationDeliveryReady: index("idx_notification_deliveries_ready").on(
      table.status,
      table.availableAt,
      table.id,
    ),
    idxNotificationDeliveryRecipient: index(
      "idx_notification_deliveries_recipient",
    ).on(table.operationalEventRecipientId, table.id),
    fkNotificationDeliveriesRecipient: foreignKey({
      columns: [table.operationalEventRecipientId],
      foreignColumns: [operationalEventRecipients.id],
      name: "fk_notification_deliveries_recipient",
    }).onDelete("cascade"),
  }),
);

/**
 * Preparação isolada para confiança de e-mail. Nenhum fluxo atual consulta
 * ou escreve essas tabelas; valores sensíveis permanecem somente em hash.
 */
export const userOperationalEmailTrust = mysqlTable(
  "user_operational_email_trust",
  {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull(),
    emailHash: varchar("email_hash", { length: 64 }).notNull(),
    state: mysqlEnum("state", ["PENDING", "TRUSTED", "REVOKED"])
      .notNull()
      .default("PENDING"),
    source: mysqlEnum("source", [
      "ADMIN_CREATED",
      "INVITE_ACTIVATED",
      "USER_CONFIRMED",
      "LEGACY",
    ]).notNull(),
    trustedAt: datetime("trusted_at"),
    invalidatedAt: datetime("invalidated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqOperationalEmailTrustUser: unique(
      "uniq_operational_email_trust_user",
    ).on(table.userId),
    idxOperationalEmailTrustHash: index("idx_operational_email_trust_hash").on(
      table.emailHash,
    ),
    fkOperationalEmailTrustUser: foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "fk_operational_email_trust_user",
    }).onDelete("cascade"),
  }),
);

export const operationalEmailVerificationTokens = mysqlTable(
  "operational_email_verification_tokens",
  {
    id: int("id").primaryKey().autoincrement(),
    userId: int("user_id").notNull(),
    emailHash: varchar("email_hash", { length: 64 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: datetime("expires_at").notNull(),
    usedAt: datetime("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqOperationalEmailVerificationToken: unique(
      "uniq_operational_email_verification_token",
    ).on(table.tokenHash),
    idxOperationalEmailVerificationUser: index(
      "idx_operational_email_verification_user",
    ).on(table.userId, table.expiresAt),
    fkOperationalEmailVerificationUser: foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "fk_operational_email_verification_user",
    }).onDelete("cascade"),
  }),
);

/**
 * Tokens SSO já consumidos para defesa anti-replay (jti único).
 */
export const ssoUsedTokens = mysqlTable(
  "sso_used_tokens",
  {
    id: int("id").primaryKey().autoincrement(),
    jti: varchar("jti", { length: 191 }).notNull().unique(),
    sub: varchar("sub", { length: 191 }).notNull(),
    tenantKey: varchar("tenant_key", { length: 191 }).notNull(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    expiresAt: datetime("expires_at").notNull(),
    usedAt: timestamp("used_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxSsoUsedTokensExpiresAt: index("idx_sso_used_tokens_expires_at").on(
      table.expiresAt,
    ),
    idxSsoUsedTokensInstitutionId: index(
      "idx_sso_used_tokens_institution_id",
    ).on(table.institutionId, table.id),
  }),
);

/**
 * Controle de estado mensal da escala (DRAFT → PUBLISHED → LOCKED)
 * Usado por month-guards.ts para restringir edições em meses publicados/trancados.
 */
export const monthlyRosters = mysqlTable(
  "monthly_rosters",
  {
    id: int("id").autoincrement().primaryKey(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    yearMonth: varchar("year_month", { length: 7 }).notNull(), // formato "YYYY-MM"
    status: mysqlEnum("status", ["DRAFT", "PUBLISHED", "LOCKED"])
      .notNull()
      .default("DRAFT"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
    publishedAt: datetime("published_at"),
    publishedByUserId: int("published_by_user_id"),
    lockedAt: datetime("locked_at"),
    lockedByUserId: int("locked_by_user_id"),
    version: int("version").notNull().default(1),
  },
  (table) => ({
    uniquePerMonth: unique().on(
      table.institutionId,
      table.hospitalId,
      table.yearMonth,
    ),
    fkInstitution: index("idx_monthly_rosters_institution").on(
      table.institutionId,
    ),
    idxMonthlyRosterInstitutionId: index(
      "idx_monthly_rosters_institution_id",
    ).on(table.institutionId, table.id),
    fkHospital: index("idx_monthly_rosters_hospital").on(table.hospitalId),
  }),
);

/**
 * Tabela de audit trail completo para governança e compliance.
 * Regista TODOS os eventos relevantes com ator, entidade, contexto e metadados.
 */
export const auditTrail = mysqlTable(
  "audit_trail",
  {
    id: int("id").primaryKey().autoincrement(),

    // Quem fez
    actorUserId: int("actor_user_id").notNull(),
    actorRole: varchar("actor_role", { length: 20 }).notNull(),
    actorName: varchar("actor_name", { length: 255 }),

    // O que fez
    action: mysqlEnum("action", [
      // Shifts
      "SHIFT_CREATED",
      "SHIFT_UPDATED",
      "SHIFT_DELETED",
      // Assignments
      "ASSIGNMENT_CREATED",
      "ASSIGNMENT_REMOVED",
      "ASSIGNMENT_ASSUMED_VACANCY",
      "ASSIGNMENT_APPROVED",
      "ASSIGNMENT_REJECTED",
      // Swaps
      "SWAP_REQUESTED",
      "SWAP_ACCEPTED",
      "SWAP_REJECTED",
      "SWAP_APPROVED_BY_MANAGER",
      "SWAP_APPROVED_BY_OWNER",
      "SWAP_CANCELLED",
      // Transfers (repasse) — alias legado de cessão
      "TRANSFER_OFFERED",
      "TRANSFER_ACCEPTED",
      "TRANSFER_REJECTED",
      "TRANSFER_APPROVED_BY_MANAGER",
      "TRANSFER_APPROVED_BY_OWNER",
      "TRANSFER_CANCELLED",
      // Cessão (PR #59 — owner approves cessão sem gestor)
      "CESSAO_OFFERED",
      "CESSAO_ACCEPTED",
      "CESSAO_REJECTED",
      "CESSAO_APPROVED_BY_OWNER",
      "CESSAO_CANCELLED",
      // Roster
      "ROSTER_PUBLISHED",
      "ROSTER_LOCKED",
      // User management
      "USER_CREATED",
      "USER_UPDATED",
      "USER_ROLE_CHANGED",
      "INSTITUTION_FEATURE_UPDATED",
      "SECTOR_SERVICE_SPECIALTIES_UPDATED",
      "SSO_JIT_LINK_CREATED",
      "PUSH_DISPATCHED",
      // Conflict
      "CONFLICT_DETECTED",
      "CONFLICT_OVERRIDDEN",
    ]).notNull(),

    // Contexto
    entityType: mysqlEnum("entity_type", [
      "SHIFT_INSTANCE",
      "SHIFT_ASSIGNMENT",
      "SWAP_REQUEST",
      "TRANSFER_REQUEST",
      "MONTHLY_ROSTER",
      "USER",
      "PROFESSIONAL",
      "INSTITUTION",
      "SECTOR",
    ]).notNull(),
    entityId: int("entity_id").notNull(),

    // Detalhes
    description: varchar("description", { length: 500 }).notNull(),
    metadata: json("metadata"),

    // Origem e destino (para trocas/transferências)
    fromProfessionalId: int("from_professional_id"),
    toProfessionalId: int("to_professional_id"),
    fromUserId: int("from_user_id"),
    toUserId: int("to_user_id"),

    // Contexto organizacional
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id"),
    sectorId: int("sector_id"),
    shiftInstanceId: int("shift_instance_id"),

    // Timestamp
    createdAt: timestamp("created_at").defaultNow().notNull(),

    // IP/device (para auditoria de segurança)
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: varchar("user_agent", { length: 500 }),
  },
  (table) => ({
    idxAuditActor: index("idx_audit_actor").on(table.actorUserId),
    idxAuditEntity: index("idx_audit_entity").on(
      table.entityType,
      table.entityId,
    ),
    idxAuditShift: index("idx_audit_shift").on(table.shiftInstanceId),
    idxAuditInstitutionId: index("idx_audit_institution_id").on(
      table.institutionId,
      table.id,
    ),
    idxAuditDate: index("idx_audit_date").on(table.createdAt),
  }),
);

/**
 * Solicitações de troca (SWAP) e repasse (TRANSFER) entre profissionais.
 */
export const swapRequests = mysqlTable(
  "swap_requests",
  {
    id: int("id").primaryKey().autoincrement(),

    // Tipo da operação. CESSAO é o nome canônico para o handoff
    // unidirecional do plantão (A → B sem contrapartida); TRANSFER é o
    // valor legado, mantido enquanto o frontend antigo migra. SWAP é a
    // troca bidirecional A↔B. Cf. docs/product/escala-ux.md §6.
    type: mysqlEnum("type", ["SWAP", "TRANSFER", "CESSAO"]).notNull(),

    // Status do fluxo
    status: mysqlEnum("status", [
      "PENDING",
      "ACCEPTED",
      "APPROVED",
      "REJECTED_BY_PEER",
      "REJECTED_BY_MANAGER",
      "CANCELLED",
      "EXPIRED",
    ])
      .notNull()
      .default("PENDING"),

    // Quem está oferecendo
    fromProfessionalId: int("from_professional_id")
      .notNull()
      .references(() => professionals.id),
    fromUserId: int("from_user_id")
      .notNull()
      .references(() => users.id),
    fromShiftInstanceId: int("from_shift_instance_id")
      .notNull()
      .references(() => shiftInstances.id),
    fromAssignmentId: int("from_assignment_id")
      .notNull()
      .references(() => shiftAssignmentsV2.id),

    // Quem aceitou (preenchido quando alguém aceita)
    toProfessionalId: int("to_professional_id").references(
      () => professionals.id,
    ),
    toUserId: int("to_user_id").references(() => users.id),
    // Para SWAP: qual shift o receptor está oferecendo em troca
    toShiftInstanceId: int("to_shift_instance_id").references(
      () => shiftInstances.id,
    ),
    toAssignmentId: int("to_assignment_id").references(
      () => shiftAssignmentsV2.id,
    ),

    // Quem aprovou/rejeitou (gestor)
    reviewedByUserId: int("reviewed_by_user_id").references(() => users.id),
    reviewedAt: datetime("reviewed_at"),
    reviewNote: varchar("review_note", { length: 500 }),

    // Contexto
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    hospitalId: int("hospital_id")
      .notNull()
      .references(() => hospitals.id),
    sectorId: int("sector_id").references(() => sectors.id),

    // Detalhes
    reason: varchar("reason", { length: 500 }),

    // Controle
    expiresAt: datetime("expires_at"),
    version: int("version").notNull().default(1),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    idxFrom: index("idx_swap_from").on(table.fromProfessionalId),
    idxTo: index("idx_swap_to").on(table.toProfessionalId),
    idxStatus: index("idx_swap_status").on(table.status),
    idxShift: index("idx_swap_shift").on(table.fromShiftInstanceId),
    idxSwapInstitutionId: index("idx_swap_institution_id").on(
      table.institutionId,
      table.id,
    ),
  }),
);

/**
 * Recusa individual de oferta ABERTA (sem destinatário).
 * A linha some da lista de quem recusou; a solicitação permanece PENDING
 * para os demais elegíveis. Oferta direcionada não usa esta tabela —
 * fecha com REJECTED_BY_PEER.
 * Migração: drizzle/migrations/manual/2026-08-28-swap-request-dismissals.sql
 */
export const swapRequestDismissals = mysqlTable(
  "swap_request_dismissals",
  {
    id: int("id").primaryKey().autoincrement(),
    swapRequestId: int("swap_request_id")
      .notNull()
      .references(() => swapRequests.id, { onDelete: "cascade" }),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    professionalId: int("professional_id")
      .notNull()
      .references(() => professionals.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    uniqSwapDismissalActor: unique("uniq_swap_dismissal_actor").on(
      table.swapRequestId,
      table.userId,
    ),
    idxSwapDismissalInstitution: index("idx_swap_dismissal_institution").on(
      table.institutionId,
      table.swapRequestId,
    ),
  }),
);

// ========================================
// CONFIRMAÇÃO DE PRESENÇA PRÉ-PLANTÃO
// ========================================

/**
 * Confirmação de presença antes do plantão.
 *
 * Fluxo:
 *   tick due-based (dueAt = startAt - lead ≤ agora, startAt futuro)
 *     → Push "Confirma plantão?" → PENDING
 *     → SIM: CONFIRMED (declara o intervalo no Comunica+ via duty-sync; sem SSO)
 *     → NÃO: DECLINED (abre tela indicar substituto)
 *     → sem resposta +30min: mantém estado e escala para decisão humana
 *
 * Lead (owner): 9h se início ∈ [06:30, 07:30] hospital local; 2h nos demais.
 * Ver server/cron/confirmation-due.ts.
 *
 * Substituição:
 *   Médico original DECLINED → indica substituto → NOMINATED
 *   Substituto aceita → REPLACEMENT_CONFIRMED
 *   Substituto recusa/ignora → alerta gerencial, sem confirmação automática
 */
export const dutyConfirmations = mysqlTable(
  "duty_confirmations",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    shiftInstanceId: int("shift_instance_id")
      .notNull()
      .references(() => shiftInstances.id),
    assignmentId: int("assignment_id")
      .notNull()
      .references(() => shiftAssignmentsV2.id),

    // Profissional escalado originalmente
    professionalId: int("professional_id")
      .notNull()
      .references(() => professionals.id),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),

    status: mysqlEnum("status", [
      "PENDING", // Notificação enviada, aguardando resposta
      "CONFIRMED", // Médico confirmou presença
      "DECLINED", // Médico recusou, pode indicar substituto
      "NOMINATED", // Substituto indicado, aguardando aceite
      "REPLACEMENT_CONFIRMED", // Substituto aceitou
      "REPLACEMENT_DECLINED", // Substituto recusou
      "AUTO_CONFIRMED", // Legado somente leitura; não é mais produzido
    ])
      .notNull()
      .default("PENDING"),

    // Substituto (preenchido quando NOMINATED).
    // FK declarada explicitamente no callback (fkReplacementProf) porque
    // o nome auto-gerado pelo drizzle
    // (duty_confirmations_replacement_professional_id_professionals_id_fk,
    // 66 chars) excede o limite de 64 do MySQL — ER_TOO_LONG_IDENT
    // abortava o drizzle-kit push no CI.
    replacementProfessionalId: int("replacement_professional_id"),
    replacementUserId: int("replacement_user_id").references(() => users.id),

    // Controle de tempo
    notifiedAt: timestamp("notified_at"), // Quando o push foi enviado
    respondedAt: timestamp("responded_at"), // Quando médico respondeu
    recheckAt: timestamp("recheck_at"), // Quando rodar rechecagem (+30min)
    autoConfirmedAt: timestamp("auto_confirmed_at"), // Legado histórico
    ssoTriggeredAt: timestamp("sso_triggered_at"), // Ticket Expo do SSO aceito

    // Token único para deep link de confirmação
    confirmationToken: varchar("confirmation_token", { length: 191 })
      .notNull()
      .unique(),

    // Metadata
    declineReason: varchar("decline_reason", { length: 500 }),
    managerNotified: boolean("manager_notified").notNull().default(false),

    // Push de início de plantão ("seu plantão começou — abra o Comunica+").
    // Marcado pelo cron quando o push é enviado; NULL = ainda não enviado.
    // Dedupe: o cron roda a cada 60s e só envia onde isto é NULL.
    startPushSentAt: timestamp("start_push_sent_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    uniqAssignment: unique().on(table.assignmentId),
    idxStatus: index("idx_duty_conf_status").on(table.status),
    idxRecheck: index("idx_duty_conf_recheck").on(table.recheckAt),
    idxShift: index("idx_duty_conf_shift").on(table.shiftInstanceId),
    idxInstitution: index("idx_duty_conf_institution").on(
      table.institutionId,
      table.id,
    ),
    // Nome explícito ≤64 chars (ver comentário na coluna).
    fkReplacementProf: foreignKey({
      columns: [table.replacementProfessionalId],
      foreignColumns: [professionals.id],
      name: "duty_conf_replacement_prof_fk",
    }),
  }),
);

/**
 * Códigos de lançamento SSO de uso único (Escala → Comunica+).
 *
 * Resolvem o problema do handoff em mobile: o app nativo não consegue
 * fazer form-POST no browser externo, então o app gera um código opaco
 * (POST /api/sso/launch-code) e abre o browser em GET /api/sso/launch
 * ?code=... — o servidor consome o código (one-time), gera o handoff
 * JWT NA HORA (nunca persiste o token nem o coloca em URL) e devolve
 * HTML com form auto-submit para o Comunica+; o browser recebe o
 * cookie de sessão e cai logado.
 *
 * TTL: 90s (expiresAt). usedAt marca consumo — one-time garantido via
 * UPDATE condicional (WHERE used_at IS NULL).
 */
export const ssoLaunchCodes = mysqlTable(
  "sso_launch_codes",
  {
    id: int("id").primaryKey().autoincrement(),
    code: varchar("code", { length: 128 }).notNull().unique(),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    institutionId: int("institution_id")
      .notNull()
      .references(() => institutions.id),
    clientNonce: varchar("client_nonce", { length: 191 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    idxSsoLaunchExpires: index("idx_sso_launch_expires").on(table.expiresAt),
  }),
);

// ========================================
// RELATIONS (Multi-Tenant Hierarchy)
// ========================================

export const dutyConfirmationsRelations = relations(
  dutyConfirmations,
  ({ one }) => ({
    institution: one(institutions, {
      fields: [dutyConfirmations.institutionId],
      references: [institutions.id],
    }),
    shiftInstance: one(shiftInstances, {
      fields: [dutyConfirmations.shiftInstanceId],
      references: [shiftInstances.id],
    }),
    assignment: one(shiftAssignmentsV2, {
      fields: [dutyConfirmations.assignmentId],
      references: [shiftAssignmentsV2.id],
    }),
    professional: one(professionals, {
      fields: [dutyConfirmations.professionalId],
      references: [professionals.id],
    }),
    user: one(users, {
      fields: [dutyConfirmations.userId],
      references: [users.id],
    }),
  }),
);

export const institutionsRelations = relations(institutions, ({ many }) => ({
  hospitals: many(hospitals),
  sectors: many(sectors),
  professionalInstitutions: many(professionalInstitutions),
  professionalAccesses: many(professionalAccess),
  managerScopes: many(managerScope),
  shiftTemplates: many(shiftTemplates),
  scheduleContexts: many(scheduleContexts),
  shiftInstances: many(shiftInstances),
  shiftAssignments: many(shiftAssignmentsV2),
  shiftAuditLogs: many(shiftAuditLog),
  pushTokens: many(pushTokens),
  notifications: many(notifications),
  ssoUsedTokens: many(ssoUsedTokens),
  shiftReminders: many(shiftReminders),
  monthlyRosters: many(monthlyRosters),
  auditTrails: many(auditTrail),
  swapRequests: many(swapRequests),
  swapRequestDismissals: many(swapRequestDismissals),
  dutyConfirmations: many(dutyConfirmations),
}));

export const usersRelations = relations(users, ({ many }) => ({
  professionals: many(professionals),
  professionalInstitutions: many(professionalInstitutions),
  pushTokens: many(pushTokens),
  notifications: many(notifications),
  shiftReminders: many(shiftReminders),
}));

export const hospitalsRelations = relations(hospitals, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [hospitals.institutionId],
    references: [institutions.id],
  }),
  sectors: many(sectors),
  shiftTemplates: many(shiftTemplates),
  scheduleContexts: many(scheduleContexts),
  shiftInstances: many(shiftInstances),
  shiftAssignments: many(shiftAssignmentsV2),
  monthlyRosters: many(monthlyRosters),
  swapRequests: many(swapRequests),
}));

export const sectorsRelations = relations(sectors, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [sectors.institutionId],
    references: [institutions.id],
  }),
  hospital: one(hospitals, {
    fields: [sectors.hospitalId],
    references: [hospitals.id],
  }),
  shiftTemplates: many(shiftTemplates),
  scheduleContexts: many(scheduleContexts),
  shiftInstances: many(shiftInstances),
  shiftAssignments: many(shiftAssignmentsV2),
  swapRequests: many(swapRequests),
  serviceSpecialties: many(sectorServiceSpecialties),
}));

export const professionalsRelations = relations(
  professionals,
  ({ one, many }) => ({
    user: one(users, {
      fields: [professionals.userId],
      references: [users.id],
    }),
    medicalSpecialty: one(medicalSpecialties, {
      fields: [professionals.medicalSpecialtyId],
      references: [medicalSpecialties.id],
    }),
    institutionLinks: many(professionalInstitutions),
    accesses: many(professionalAccess),
  }),
);

export const medicalSpecialtiesRelations = relations(
  medicalSpecialties,
  ({ many }) => ({
    professionals: many(professionals),
    scheduleContexts: many(scheduleContexts),
    serviceSectors: many(sectorServiceSpecialties),
  }),
);

export const sectorServiceSpecialtiesRelations = relations(
  sectorServiceSpecialties,
  ({ one }) => ({
    sector: one(sectors, {
      fields: [
        sectorServiceSpecialties.institutionId,
        sectorServiceSpecialties.hospitalId,
        sectorServiceSpecialties.sectorId,
      ],
      references: [sectors.institutionId, sectors.hospitalId, sectors.id],
    }),
    medicalSpecialty: one(medicalSpecialties, {
      fields: [sectorServiceSpecialties.medicalSpecialtyId],
      references: [medicalSpecialties.id],
    }),
  }),
);

export const professionalInstitutionsRelations = relations(
  professionalInstitutions,
  ({ one }) => ({
    professional: one(professionals, {
      fields: [professionalInstitutions.professionalId],
      references: [professionals.id],
    }),
    user: one(users, {
      fields: [professionalInstitutions.userId],
      references: [users.id],
    }),
    institution: one(institutions, {
      fields: [professionalInstitutions.institutionId],
      references: [institutions.id],
    }),
  }),
);

export const shiftTemplatesRelations = relations(shiftTemplates, ({ one }) => ({
  institution: one(institutions, {
    fields: [shiftTemplates.institutionId],
    references: [institutions.id],
  }),
  hospital: one(hospitals, {
    fields: [shiftTemplates.hospitalId],
    references: [hospitals.id],
  }),
  sector: one(sectors, {
    fields: [shiftTemplates.sectorId],
    references: [sectors.id],
  }),
}));

export const scheduleContextsRelations = relations(
  scheduleContexts,
  ({ one, many }) => ({
    institution: one(institutions, {
      fields: [scheduleContexts.institutionId],
      references: [institutions.id],
    }),
    hospital: one(hospitals, {
      fields: [scheduleContexts.hospitalId],
      references: [hospitals.id],
    }),
    sector: one(sectors, {
      fields: [scheduleContexts.sectorId],
      references: [sectors.id],
    }),
    medicalSpecialty: one(medicalSpecialties, {
      fields: [scheduleContexts.medicalSpecialtyId],
      references: [medicalSpecialties.id],
    }),
    allowedQualifications: many(scheduleContextAllowedQualifications),
    shiftInstances: many(shiftInstances),
  }),
);

export const scheduleContextAllowedQualificationsRelations = relations(
  scheduleContextAllowedQualifications,
  ({ one }) => ({
    scheduleContext: one(scheduleContexts, {
      fields: [scheduleContextAllowedQualifications.scheduleContextId],
      references: [scheduleContexts.id],
    }),
    medicalSpecialty: one(medicalSpecialties, {
      fields: [scheduleContextAllowedQualifications.medicalSpecialtyId],
      references: [medicalSpecialties.id],
    }),
  }),
);

export const shiftInstancesRelations = relations(
  shiftInstances,
  ({ one, many }) => ({
    institution: one(institutions, {
      fields: [shiftInstances.institutionId],
      references: [institutions.id],
    }),
    hospital: one(hospitals, {
      fields: [shiftInstances.hospitalId],
      references: [hospitals.id],
    }),
    sector: one(sectors, {
      fields: [shiftInstances.sectorId],
      references: [sectors.id],
    }),
    scheduleContext: one(scheduleContexts, {
      fields: [shiftInstances.scheduleContextId],
      references: [scheduleContexts.id],
    }),
    assignments: many(shiftAssignmentsV2),
    reminders: many(shiftReminders),
  }),
);

export const ssoUsedTokensRelations = relations(ssoUsedTokens, ({ one }) => ({
  institution: one(institutions, {
    fields: [ssoUsedTokens.institutionId],
    references: [institutions.id],
  }),
}));

export const shiftRemindersRelations = relations(shiftReminders, ({ one }) => ({
  institution: one(institutions, {
    fields: [shiftReminders.institutionId],
    references: [institutions.id],
  }),
  shiftInstance: one(shiftInstances, {
    fields: [shiftReminders.shiftInstanceId],
    references: [shiftInstances.id],
  }),
  user: one(users, {
    fields: [shiftReminders.userId],
    references: [users.id],
  }),
}));

export const shiftAssignmentsRelations = relations(
  shiftAssignmentsV2,
  ({ one }) => ({
    institution: one(institutions, {
      fields: [shiftAssignmentsV2.institutionId],
      references: [institutions.id],
    }),
    hospital: one(hospitals, {
      fields: [shiftAssignmentsV2.hospitalId],
      references: [hospitals.id],
    }),
    sector: one(sectors, {
      fields: [shiftAssignmentsV2.sectorId],
      references: [sectors.id],
    }),
    shiftInstance: one(shiftInstances, {
      fields: [shiftAssignmentsV2.shiftInstanceId],
      references: [shiftInstances.id],
    }),
    professional: one(professionals, {
      fields: [shiftAssignmentsV2.professionalId],
      references: [professionals.id],
    }),
  }),
);

export const monthlyRostersRelations = relations(monthlyRosters, ({ one }) => ({
  institution: one(institutions, {
    fields: [monthlyRosters.institutionId],
    references: [institutions.id],
  }),
  hospital: one(hospitals, {
    fields: [monthlyRosters.hospitalId],
    references: [hospitals.id],
  }),
}));

export const swapRequestsRelations = relations(swapRequests, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [swapRequests.institutionId],
    references: [institutions.id],
  }),
  hospital: one(hospitals, {
    fields: [swapRequests.hospitalId],
    references: [hospitals.id],
  }),
  sector: one(sectors, {
    fields: [swapRequests.sectorId],
    references: [sectors.id],
  }),
  fromProfessional: one(professionals, {
    fields: [swapRequests.fromProfessionalId],
    references: [professionals.id],
  }),
  toProfessional: one(professionals, {
    fields: [swapRequests.toProfessionalId],
    references: [professionals.id],
  }),
  dismissals: many(swapRequestDismissals),
}));

export const swapRequestDismissalsRelations = relations(
  swapRequestDismissals,
  ({ one }) => ({
    swapRequest: one(swapRequests, {
      fields: [swapRequestDismissals.swapRequestId],
      references: [swapRequests.id],
    }),
    institution: one(institutions, {
      fields: [swapRequestDismissals.institutionId],
      references: [institutions.id],
    }),
    user: one(users, {
      fields: [swapRequestDismissals.userId],
      references: [users.id],
    }),
    professional: one(professionals, {
      fields: [swapRequestDismissals.professionalId],
      references: [professionals.id],
    }),
  }),
);
