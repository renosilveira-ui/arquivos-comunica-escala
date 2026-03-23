import { mysqlTable, int, varchar, text, mysqlEnum, timestamp, datetime, boolean, time, json, unique, index } from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";

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
  role: mysqlEnum("role", ["admin", "manager", "doctor", "nurse", "tech"]).default("doctor").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

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
 * Hospitais (pertence a uma instituição)
 * Ex: "Hospital Copa D'Or", "Hospital São Luiz Itaim"
 */
export const hospitals = mysqlTable(
  "hospitals",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxHospitalInstitutionId: index("idx_hospitals_institution_id").on(table.institutionId, table.id),
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
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
    name: varchar("name", { length: 255 }).notNull(),
    category: mysqlEnum("category", ["internacao", "cirurgico", "servico"]).notNull(),
    color: varchar("color", { length: 7 }).notNull(), // Hex color
    minStaffCount: int("min_staff_count").notNull().default(2),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxSectorInstitutionId: index("idx_sectors_institution_id").on(table.institutionId, table.id),
  }),
);

/**
 * Profissionais (usuários que atuam em plantões)
 * Relacionamento com users para manter separação entre auth e dados profissionais
 */
/**
 * Enum para roles de usuário (RBAC)
 */
export const userRoleEnum = mysqlEnum("user_role", ["USER", "GESTOR_MEDICO", "GESTOR_PLUS"]);

export const professionals = mysqlTable("professionals", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull().references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 100 }).notNull(), // Ex: "Médico", "Enfermeiro", "Técnico"
  userRole: userRoleEnum.notNull().default("USER"), // RBAC: USER, GESTOR_MEDICO, GESTOR_PLUS
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Vínculo multi-institucional de profissionais (SaaS multi-tenant enterprise).
 * Permite que o mesmo profissional atue em múltiplos clientes sem duplicar usuário.
 */
export const professionalInstitutions = mysqlTable(
  "professional_institutions",
  {
    id: int("id").primaryKey().autoincrement(),
    professionalId: int("professional_id").notNull().references(() => professionals.id, { onDelete: "cascade" }),
    userId: int("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    institutionId: int("institution_id").notNull().references(() => institutions.id, { onDelete: "cascade" }),
    roleInInstitution: userRoleEnum.notNull().default("USER"),
    isPrimary: boolean("is_primary").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqProfessionalInstitution: unique().on(table.professionalId, table.institutionId),
    uniqUserInstitution: unique().on(table.userId, table.institutionId),
    idxProfessionalInstitution: index("idx_prof_inst_prof").on(table.professionalId, table.institutionId),
    idxInstitutionActive: index("idx_prof_inst_institution_active").on(table.institutionId, table.active),
    idxProfessionalInstitutionId: index("idx_prof_inst_institution_id").on(table.institutionId, table.id),
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
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    professionalId: int("professional_id").notNull().references(() => professionals.id),
    hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
    sectorId: int("sector_id").references(() => sectors.id), // Null = acesso a todos os setores do hospital
    canAccess: boolean("can_access").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxProfessionalAccessInstitutionId: index("idx_prof_access_institution_id").on(table.institutionId, table.id),
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
    institutionId: int("institution_id").notNull().references(() => institutions.id, { onDelete: "cascade" }),
    managerProfessionalId: int("manager_professional_id").notNull().references(() => professionals.id, { onDelete: "cascade" }),
    hospitalId: int("hospital_id").notNull().references(() => hospitals.id, { onDelete: "cascade" }),
    sectorId: int("sector_id").references(() => sectors.id, { onDelete: "cascade" }), // Null = gestor de todo o hospital
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxManagerScopeInstitutionId: index("idx_manager_scope_institution_id").on(table.institutionId, table.id),
  }),
);

/**
 * Configurações por instituição
 */
export const institutionConfig = mysqlTable(
  "institution_config",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id").notNull().unique().references(() => institutions.id, { onDelete: "cascade" }),
    editWindowDays: int("edit_window_days").notNull().default(3), // Janela de edição retroativa (0 = não permite passado)
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxInstitutionConfigInstitutionId: index("idx_institution_config_institution_id").on(table.institutionId, table.id),
  }),
);

/**
 * Enum para tipo de alocação
 */
export const assignmentTypeEnum = mysqlEnum("assignment_type", ["ON_DUTY", "BACKUP", "ON_CALL"]);

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
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
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
    idxShiftTemplateInstitutionId: index("idx_shift_templates_institution_id").on(table.institutionId, table.id),
  }),
);

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
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
    sectorId: int("sector_id").notNull().references(() => sectors.id),
    label: varchar("label", { length: 100 }).notNull(),
    startAt: timestamp("start_at").notNull(),
    endAt: timestamp("end_at").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("VAGO"),
    createdBy: int("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxShiftInstanceInstitutionId: index("idx_shift_instances_institution_id").on(table.institutionId, table.id),
  }),
);

/**
 * Alocações de profissionais a turnos (V2)
 */
export const shiftAssignmentsV2 = mysqlTable(
  "shift_assignments_v2",
  {
    id: int("id").primaryKey().autoincrement(),
    shiftInstanceId: int("shift_instance_id").notNull().references(() => shiftInstances.id),
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
    sectorId: int("sector_id").notNull().references(() => sectors.id),
    professionalId: int("professional_id").notNull().references(() => professionals.id),
    assignmentType: assignmentTypeEnum.notNull().default("ON_DUTY"),
    status: varchar("status", { length: 20 }).notNull().default("PENDENTE"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: int("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idxShiftAssignmentInstitutionId: index("idx_shift_assignments_institution_id").on(table.institutionId, table.id),
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
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    shiftInstanceId: int("shift_instance_id").notNull().references(() => shiftInstances.id),
    userId: int("user_id").notNull().references(() => users.id),
    reminderType: mysqlEnum("reminder_type", ["PRE_SHIFT"]).notNull().default("PRE_SHIFT"),
    reminderAt: timestamp("reminder_at").notNull(),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqShiftReminder: unique().on(table.shiftInstanceId, table.userId, table.reminderType),
    idxShiftRemindersInstitutionId: index("idx_shift_reminders_institution_id").on(
      table.institutionId,
      table.id,
    ),
    idxShiftRemindersReminderAt: index("idx_shift_reminders_reminder_at").on(table.reminderAt),
  }),
);

/**
 * Audit log para turnos (governança e compliance)
 */
export const shiftAuditLog = mysqlTable(
  "shift_audit_log",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    event: varchar("event", { length: 50 }).notNull(),
    shiftInstanceId: int("shift_instance_id").notNull().references(() => shiftInstances.id),
    professionalId: int("professional_id").references(() => professionals.id),
    reason: text("reason"),
    metadata: json("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxShiftAuditInstitutionId: index("idx_shift_audit_institution_id").on(table.institutionId, table.id),
  }),
);

/**
 * Push notification tokens
 */
export const pushTokens = mysqlTable(
  "push_tokens",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    userId: int("user_id").notNull().references(() => users.id),
    token: varchar("token", { length: 512 }).notNull(),
    platform: varchar("platform", { length: 20 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxPushTokenInstitutionId: index("idx_push_tokens_institution_id").on(table.institutionId, table.id),
  }),
);

/**
 * Notifications
 */
export const notifications = mysqlTable(
  "notifications",
  {
    id: int("id").primaryKey().autoincrement(),
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    userId: int("user_id").notNull().references(() => users.id),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    type: mysqlEnum("type", ["GENERAL", "SHIFT_REMINDER"]).notNull().default("GENERAL"),
    status: mysqlEnum("status", ["PENDING", "SENT", "FAILED"]).notNull().default("PENDING"),
    shiftInstanceId: int("shift_instance_id").references(() => shiftInstances.id),
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
    idxNotificationInstitutionId: index("idx_notifications_institution_id").on(table.institutionId, table.id),
    idxNotificationsStatus: index("idx_notifications_status").on(table.status, table.createdAt),
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
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    expiresAt: datetime("expires_at").notNull(),
    usedAt: timestamp("used_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idxSsoUsedTokensExpiresAt: index("idx_sso_used_tokens_expires_at").on(table.expiresAt),
    idxSsoUsedTokensInstitutionId: index("idx_sso_used_tokens_institution_id").on(
      table.institutionId,
      table.id,
    ),
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
    institutionId: int("institution_id").notNull().references(() => institutions.id),
    hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
    yearMonth: varchar("year_month", { length: 7 }).notNull(), // formato "YYYY-MM"
    status: mysqlEnum("status", ["DRAFT", "PUBLISHED", "LOCKED"]).notNull().default("DRAFT"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
    publishedAt: datetime("published_at"),
    publishedByUserId: int("published_by_user_id"),
    lockedAt: datetime("locked_at"),
    lockedByUserId: int("locked_by_user_id"),
    version: int("version").notNull().default(1),
  },
  (table) => ({
    uniquePerMonth: unique().on(table.institutionId, table.hospitalId, table.yearMonth),
    fkInstitution: index("idx_monthly_rosters_institution").on(table.institutionId),
    idxMonthlyRosterInstitutionId: index("idx_monthly_rosters_institution_id").on(table.institutionId, table.id),
    fkHospital: index("idx_monthly_rosters_hospital").on(table.hospitalId),
  })
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
      "SWAP_CANCELLED",
      // Transfers (repasse)
      "TRANSFER_OFFERED",
      "TRANSFER_ACCEPTED",
      "TRANSFER_REJECTED",
      "TRANSFER_APPROVED_BY_MANAGER",
      "TRANSFER_CANCELLED",
      // Roster
      "ROSTER_PUBLISHED",
      "ROSTER_LOCKED",
      // User management
      "USER_CREATED",
      "USER_UPDATED",
      "USER_ROLE_CHANGED",
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
    institutionId: int("institution_id").notNull().references(() => institutions.id),
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
    idxAuditEntity: index("idx_audit_entity").on(table.entityType, table.entityId),
    idxAuditShift: index("idx_audit_shift").on(table.shiftInstanceId),
    idxAuditInstitutionId: index("idx_audit_institution_id").on(table.institutionId, table.id),
    idxAuditDate: index("idx_audit_date").on(table.createdAt),
  })
);


/**
 * Solicitações de troca (SWAP) e repasse (TRANSFER) entre profissionais.
 */
export const swapRequests = mysqlTable("swap_requests", {
  id: int("id").primaryKey().autoincrement(),

  // Tipo da operação
  type: mysqlEnum("type", ["SWAP", "TRANSFER"]).notNull(),

  // Status do fluxo
  status: mysqlEnum("status", [
    "PENDING",
    "ACCEPTED",
    "APPROVED",
    "REJECTED_BY_PEER",
    "REJECTED_BY_MANAGER",
    "CANCELLED",
    "EXPIRED",
  ]).notNull().default("PENDING"),

  // Quem está oferecendo
  fromProfessionalId: int("from_professional_id").notNull().references(() => professionals.id),
  fromUserId: int("from_user_id").notNull().references(() => users.id),
  fromShiftInstanceId: int("from_shift_instance_id").notNull().references(() => shiftInstances.id),
  fromAssignmentId: int("from_assignment_id").notNull().references(() => shiftAssignmentsV2.id),

  // Quem aceitou (preenchido quando alguém aceita)
  toProfessionalId: int("to_professional_id").references(() => professionals.id),
  toUserId: int("to_user_id").references(() => users.id),
  // Para SWAP: qual shift o receptor está oferecendo em troca
  toShiftInstanceId: int("to_shift_instance_id").references(() => shiftInstances.id),
  toAssignmentId: int("to_assignment_id").references(() => shiftAssignmentsV2.id),

  // Quem aprovou/rejeitou (gestor)
  reviewedByUserId: int("reviewed_by_user_id").references(() => users.id),
  reviewedAt: datetime("reviewed_at"),
  reviewNote: varchar("review_note", { length: 500 }),

  // Contexto
  institutionId: int("institution_id").notNull().references(() => institutions.id),
  hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
  sectorId: int("sector_id").references(() => sectors.id),

  // Detalhes
  reason: varchar("reason", { length: 500 }),

  // Controle
  expiresAt: datetime("expires_at"),
  version: int("version").notNull().default(1),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  idxFrom: index("idx_swap_from").on(table.fromProfessionalId),
  idxTo: index("idx_swap_to").on(table.toProfessionalId),
  idxStatus: index("idx_swap_status").on(table.status),
  idxShift: index("idx_swap_shift").on(table.fromShiftInstanceId),
  idxSwapInstitutionId: index("idx_swap_institution_id").on(table.institutionId, table.id),
}));

// ========================================
// RELATIONS (Multi-Tenant Hierarchy)
// ========================================

export const institutionsRelations = relations(institutions, ({ many }) => ({
  hospitals: many(hospitals),
  sectors: many(sectors),
  professionalInstitutions: many(professionalInstitutions),
  professionalAccesses: many(professionalAccess),
  managerScopes: many(managerScope),
  shiftTemplates: many(shiftTemplates),
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
  shiftInstances: many(shiftInstances),
  shiftAssignments: many(shiftAssignmentsV2),
  swapRequests: many(swapRequests),
}));

export const professionalsRelations = relations(professionals, ({ one, many }) => ({
  user: one(users, {
    fields: [professionals.userId],
    references: [users.id],
  }),
  institutionLinks: many(professionalInstitutions),
  accesses: many(professionalAccess),
}));

export const professionalInstitutionsRelations = relations(professionalInstitutions, ({ one }) => ({
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
}));

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

export const shiftInstancesRelations = relations(shiftInstances, ({ one, many }) => ({
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
  assignments: many(shiftAssignmentsV2),
  reminders: many(shiftReminders),
}));

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

export const shiftAssignmentsRelations = relations(shiftAssignmentsV2, ({ one }) => ({
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
}));

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

export const swapRequestsRelations = relations(swapRequests, ({ one }) => ({
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
}));
