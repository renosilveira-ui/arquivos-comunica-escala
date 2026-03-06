import { professionals, managerScope, institutionConfig, shiftInstances } from "../drizzle/schema";
import { eq, and, isNull } from "drizzle-orm";

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
