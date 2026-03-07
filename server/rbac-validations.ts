import { professionals, managerScope, institutionConfig, shiftInstances } from "../drizzle/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "./db";

/**
 * Validações RBAC + Jurisdição + Janela Temporal
 * 
 * Regras:
 * - USER: pode assumir vagas, ofertar plantões, propor trocas
 * - GESTOR_MEDICO: pode criar/editar escalas dentro da jurisdição (manager_scope) e janela temporal
 * - GESTOR_PLUS: pode tudo, inclusive retroativo e fora de escopo
 */

export type UserRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

export interface JurisdictionCheck {
  hasAccess: boolean;
  reason?: string;
}

export interface EditWindowCheck {
  canEdit: boolean;
  reason?: string;
  isRetroactive: boolean;
}

export interface PermissionCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Buscar role do profissional
 */
export async function getProfessionalRole(professionalId: number): Promise<UserRole | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [professional] = await db
    .select({ userRole: professionals.userRole })
    .from(professionals)
    .where(eq(professionals.id, professionalId));

  return professional?.userRole || null;
}

/**
 * Validação A: Jurisdição (manager_scope)
 * 
 * Verifica se GESTOR_MEDICO tem acesso ao hospital/setor.
 * GESTOR_PLUS sempre tem acesso.
 * USER não precisa de jurisdição (só pode assumir vagas, não criar turnos).
 */
export async function checkJurisdiction(
  professionalId: number,
  hospitalId: number,
  sectorId: number
): Promise<JurisdictionCheck> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Buscar role do profissional
  const role = await getProfessionalRole(professionalId);
  if (!role) {
    return { hasAccess: false, reason: "Profissional não encontrado" };
  }

  // GESTOR_PLUS tem acesso total
  if (role === "GESTOR_PLUS") {
    return { hasAccess: true };
  }

  // USER não precisa de jurisdição (não cria turnos)
  if (role === "USER") {
    return { hasAccess: true };
  }

  // GESTOR_MEDICO: verificar manager_scope
  const scopes = await db
    .select()
    .from(managerScope)
    .where(
      and(
        eq(managerScope.managerProfessionalId, professionalId),
        eq(managerScope.hospitalId, hospitalId),
        eq(managerScope.active, true)
      )
    );

  if (scopes.length === 0) {
    return {
      hasAccess: false,
      reason: `Gestor não tem jurisdição sobre o hospital ${hospitalId}`,
    };
  }

  // Verificar se tem acesso ao setor específico
  const hasGeneralAccess = scopes.some((s) => s.sectorId === null); // Acesso a todo o hospital
  const hasSpecificAccess = scopes.some((s) => s.sectorId === sectorId); // Acesso ao setor específico

  if (!hasGeneralAccess && !hasSpecificAccess) {
    return {
      hasAccess: false,
      reason: `Gestor não tem jurisdição sobre o setor ${sectorId}`,
    };
  }

  return { hasAccess: true };
}

/**
 * Validação B: Janela Temporal (edit_window_days)
 *
 * Verifica se a data do turno está dentro da janela de edição retroativa.
 * GESTOR_PLUS ignora a janela.
 */
export async function checkEditWindow(
  professionalId: number,
  institutionId: number,
  shiftDate: Date
): Promise<EditWindowCheck> {
  const role = await getProfessionalRole(professionalId);

  const isRetroactive = shiftDate < new Date();

  // GESTOR_PLUS pode tudo
  if (role === "GESTOR_PLUS") {
    return { canEdit: true, isRetroactive };
  }

  // USER não pode editar
  if (role === "USER") {
    return { canEdit: false, isRetroactive, reason: "Usuários não podem editar turnos retroativos" };
  }

  if (!isRetroactive) {
    return { canEdit: true, isRetroactive: false };
  }

  // GESTOR_MEDICO: verificar janela
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [config] = await db
    .select()
    .from(institutionConfig)
    .where(eq(institutionConfig.institutionId, institutionId));

  const editWindowDays = config?.editWindowDays ?? 3;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - editWindowDays);

  if (shiftDate < cutoffDate) {
    return {
      canEdit: false,
      isRetroactive: true,
      reason: `Turno fora da janela de edição (${editWindowDays} dias)`,
    };
  }

  return { canEdit: true, isRetroactive };
}

/**
 * Validação C: Pode aprovar alocação (GESTOR_MEDICO com jurisdição ou GESTOR_PLUS)
 */
export async function canApproveAssignment(
  managerId: number,
  hospitalId: number,
  sectorId: number
): Promise<PermissionCheck> {
  const role = await getProfessionalRole(managerId);
  if (!role) return { allowed: false, reason: "Profissional não encontrado" };
  if (role === "USER") return { allowed: false, reason: "Apenas gestores podem aprovar" };
  if (role === "GESTOR_PLUS") return { allowed: true };

  const jurisdiction = await checkJurisdiction(managerId, hospitalId, sectorId);
  if (!jurisdiction.hasAccess) {
    return { allowed: false, reason: jurisdiction.reason };
  }

  return { allowed: true };
}