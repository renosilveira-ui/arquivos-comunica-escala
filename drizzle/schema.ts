
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
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Hospitais (pertence a uma instituição)
 * Ex: "Hospital Copa D'Or", "Hospital São Luiz Itaim"
 */
export const hospitals = mysqlTable("hospitals", {
  id: int("id").primaryKey().autoincrement(),
  institutionId: int("institution_id").notNull().references(() => institutions.id),
  name: varchar("name", { length: 255 }).notNull(),
  address: text("address"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Setores hospitalares (pertence a um hospital)
 * Sincronizado com HospitalAlert (23 setores)
 */
export const sectors = mysqlTable("sectors", {
  id: int("id").primaryKey().autoincrement(),
  hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
  name: varchar("name", { length: 255 }).notNull(),
  category: mysqlEnum("category", ["internacao", "cirurgico", "servico"]).notNull(),
  color: varchar("color", { length: 7 }).notNull(), // Hex color
  minStaffCount: int("min_staff_count").notNull().default(2),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
  institutionId: int("institution_id").notNull().references(() => institutions.id),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 100 }).notNull(), // Ex: "Médico", "Enfermeiro", "Técnico"
  userRole: userRoleEnum.notNull().default("USER"), // RBAC: USER, GESTOR_MEDICO, GESTOR_PLUS
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Controle de acesso de profissionais (permissões TI)
 * Define quais hospitais/setores cada profissional pode atuar
 */
export const professionalAccess = mysqlTable("professional_access", {
  id: int("id").primaryKey().autoincrement(),
  professionalId: int("professional_id").notNull().references(() => professionals.id),
  hospitalId: int("hospital_id").notNull().references(() => hospitals.id),
  sectorId: int("sector_id").references(() => sectors.id), // Null = acesso a todos os setores do hospital
  canAccess: boolean("can_access").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

/**
 * Jurisdição dos gestores médicos (manager_scope)
 * Define quais hospitais/setores cada GESTOR_MEDICO pode gerenciar
 */
export const managerScope = mysqlTable("manager_scope", {
  id: int("id").primaryKey().autoincrement(),
  managerProfessionalId: int("manager_professional_id").notNull().references(() => professionals.id, { onDelete: "cascade" }),
  hospitalId: int("hospital_id").notNull().references(() => hospitals.id, { onDelete: "cascade" }),
  sectorId: int("sector_id").references(() => sectors.id, { onDelete: "cascade" }), // Null = gestor de todo o hospital
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

/**
 * Configurações por instituição
 */
export const institutionConfig = mysqlTable("institution_config", {
  id: int("id").primaryKey().autoincrement(),
  institutionId: int("institution_id").notNull().unique().references(() => institutions.id, { onDelete: "cascade" }),
  editWindowDays: int("edit_window_days").notNull().default(3), // Janela de edição retroativa (0 = não permite passado)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

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
export const shiftTemplates = mysqlTable("shift_templates", {
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
});
