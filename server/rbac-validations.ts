import { professionals, managerScope, shiftInstances, professionalInstitutions } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { getDb } from "./db";
import { yearMonthFromDate } from "../lib/date-utils";

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

// ── shared helper ────────────────────────────────────────────────────────────

/** Resolve shiftInstanceId → institution / hospital / sector / startAt */
async function resolveShift(shiftInstanceId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      startAt: shiftInstances.startAt,
    })
    .from(shiftInstances)
    .where(eq(shiftInstances.id, shiftInstanceId));
  return row ?? null;
}

async function getInstitutionRoleForProfessional(
  professionalId: number,
  institutionId: number,
): Promise<UserRole | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [membership] = await db
    .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.professionalId, professionalId),
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  return (membership?.roleInInstitution as UserRole | undefined) ?? null;
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
  sectorId: number,
  institutionId?: number,
): Promise<JurisdictionCheck> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Buscar role contextual do profissional no tenant ativo
  let role: UserRole | null = null;
  if (institutionId) {
    role = await getInstitutionRoleForProfessional(professionalId, institutionId);
  }
  if (!role) {
    role = await getProfessionalRole(professionalId);
  }
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
      institutionId
        ? and(
            eq(managerScope.institutionId, institutionId),
            eq(managerScope.managerProfessionalId, professionalId),
            eq(managerScope.hospitalId, hospitalId),
            eq(managerScope.active, true),
          )
        : and(
            eq(managerScope.managerProfessionalId, professionalId),
            eq(managerScope.hospitalId, hospitalId),
            eq(managerScope.active, true),
          ),
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
 * Verifica se a data do turno está no mês corrente para GESTOR_MEDICO.
 * GESTOR_PLUS ignora a janela; USER não edita.
 */
export async function checkEditWindow(
  professionalId: number,
  institutionId: number,
  shiftDate: Date
): Promise<EditWindowCheck> {
  const role = await getInstitutionRoleForProfessional(professionalId, institutionId);

  const isRetroactive = shiftDate < new Date();

  // GESTOR_PLUS pode tudo
  if (role === "GESTOR_PLUS") {
    return { canEdit: true, isRetroactive };
  }

  // USER não pode editar
  if (role === "USER") {
    return { canEdit: false, isRetroactive, reason: "Usuários não podem editar turnos retroativos" };
  }

  if (yearMonthFromDate(shiftDate) !== yearMonthFromDate(new Date())) {
    return {
      canEdit: false,
      isRetroactive,
      reason: "Gestor de hospital só pode editar escala do mês corrente",
    };
  }

  return { canEdit: true, isRetroactive };
}

/**
 * Validação C: Pode aprovar alocação (GESTOR_MEDICO com jurisdição ou GESTOR_PLUS)
 * Aceita (managerId, hospitalId, sectorId) OU (managerId, shiftInstanceId).
 */
export async function canApproveAssignment(
  managerId: number,
  hospitalIdOrShiftId: number,
  sectorId?: number,
): Promise<PermissionCheck> {
  let hospitalId: number;
  let resolvedSectorId: number;

  if (sectorId !== undefined) {
    hospitalId = hospitalIdOrShiftId;
    resolvedSectorId = sectorId;
  } else {
    const shift = await resolveShift(hospitalIdOrShiftId);
    if (!shift) return { allowed: false, reason: "Turno não encontrado" };
    hospitalId = shift.hospitalId;
    resolvedSectorId = shift.sectorId;
    const role = await getInstitutionRoleForProfessional(managerId, shift.institutionId);
    if (!role) return { allowed: false, reason: "Profissional sem vínculo ativo na instituição" };
    if (role === "USER") return { allowed: false, reason: "Apenas gestores podem aprovar" };
    if (role === "GESTOR_PLUS") return { allowed: true };

    const jurisdiction = await checkJurisdiction(
      managerId,
      hospitalId,
      resolvedSectorId,
      shift.institutionId,
    );
    if (!jurisdiction.hasAccess) return { allowed: false, reason: jurisdiction.reason };
    return { allowed: true };
  }
  const role = await getProfessionalRole(managerId);
  if (!role) return { allowed: false, reason: "Profissional sem vínculo ativo na instituição" };
  if (role === "USER") return { allowed: false, reason: "Apenas gestores podem aprovar" };
  if (role === "GESTOR_PLUS") return { allowed: true };

  const jurisdiction = await checkJurisdiction(managerId, hospitalId, resolvedSectorId);
  if (!jurisdiction.hasAccess) {
    return { allowed: false, reason: jurisdiction.reason };
  }

  return { allowed: true };
}

// ── Convenience helpers used by tests / endpoints ────────────────────────────

/**
 * canEditShift — combina jurisdiction + edit-window para um shift concreto.
 * USER não pode editar; GESTOR_PLUS sempre pode; GESTOR_MEDICO depende de
 * jurisdição + janela temporal.
 */
export async function canEditShift(
  professionalId: number,
  shiftInstanceId: number,
): Promise<PermissionCheck> {
  const shift = await resolveShift(shiftInstanceId);
  if (!shift) return { allowed: false, reason: "Turno não encontrado" };

  const role = await getInstitutionRoleForProfessional(professionalId, shift.institutionId);
  if (!role) return { allowed: false, reason: "Profissional não encontrado" };
  if (role === "USER") return { allowed: false, reason: "Usuários comuns não podem editar turnos" };
  if (role === "GESTOR_PLUS") return { allowed: true };

  // GESTOR_MEDICO: jurisdiction + edit window
  const jurisdiction = await checkJurisdiction(
    professionalId,
    shift.hospitalId,
    shift.sectorId,
    shift.institutionId,
  );
  if (!jurisdiction.hasAccess) {
    return { allowed: false, reason: jurisdiction.reason };
  }

  const editWindow = await checkEditWindow(professionalId, shift.institutionId, shift.startAt);
  if (!editWindow.canEdit) {
    return { allowed: false, reason: editWindow.reason };
  }

  return { allowed: true };
}

/**
 * canAssumeVacancy — qualquer profissional existente pode assumir uma vaga.
 * Conflitos de horário são validados separadamente por validateAssignment.
 */
export async function canAssumeVacancy(
  professionalId: number,
): Promise<PermissionCheck> {
  const role = await getProfessionalRole(professionalId);
  if (!role) return { allowed: false, reason: "Profissional não encontrado ou sem vínculo ativo" };
  return { allowed: true };
}
