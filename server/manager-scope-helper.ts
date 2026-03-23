import { getDb } from "./db";
import { managerScope, professionalInstitutions, professionals } from "../drizzle/schema";
import { eq, and, inArray } from "drizzle-orm";

/**
 * Busca o manager_scope de um gestor (GESTOR_MEDICO ou GESTOR_PLUS)
 * Retorna lista de hospitais e setores que o gestor pode gerenciar
 */
export async function getManagerScope(userId: number, institutionId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Buscar todos os vínculos profissionais do usuário.
  const professionalRows = await db
    .select()
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
      ),
    )
    .where(
      and(
        eq(professionals.userId, userId),
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    );

  if (professionalRows.length === 0) {
    throw new Error("Profissional não encontrado");
  }

  const hasGestorPlus = professionalRows.some((p) => p.professionals.userRole === "GESTOR_PLUS");
  const managerProfessionalIds = professionalRows
    .filter((p) => p.professionals.userRole === "GESTOR_MEDICO")
    .map((p) => p.professionals.id);
  const hasOnlyUserRole = !hasGestorPlus && managerProfessionalIds.length === 0;

  // USER não tem manager_scope
  if (hasOnlyUserRole) {
    return {
      role: "USER" as const,
      hospitals: [],
      sectors: [],
      canManageAll: false,
    };
  }

  // GESTOR_PLUS pode gerenciar tudo
  if (hasGestorPlus) {
    return {
      role: "GESTOR_PLUS" as const,
      hospitals: [],
      sectors: [],
      canManageAll: true,
    };
  }

  // GESTOR_MEDICO: buscar scopes específicos
  const scopes = await db
    .select({
      hospitalId: managerScope.hospitalId,
      sectorId: managerScope.sectorId,
    })
    .from(managerScope)
    .where(
      and(
        inArray(managerScope.managerProfessionalId, managerProfessionalIds),
        eq(managerScope.institutionId, institutionId),
        eq(managerScope.active, true)
      )
    );

  if (scopes.length === 0) {
    throw new Error("Gestor sem escopo configurado. Entre em contato com o administrador.");
  }

  // Separar scopes por nível (hospital-level vs sector-level)
  const hospitalScopes = scopes
    .filter(s => s.sectorId === null)
    .map(s => ({ hospitalId: s.hospitalId }));

  const sectorScopes = scopes
    .filter(s => s.sectorId !== null)
    .map(s => ({ hospitalId: s.hospitalId, sectorId: s.sectorId! }));

  // Obter lista única de hospitalIds
  const uniqueHospitalIds = Array.from(
    new Set([
      ...hospitalScopes.map(h => h.hospitalId),
      ...sectorScopes.map(s => s.hospitalId),
    ])
  );

  return {
    role: "GESTOR_MEDICO" as const,
    hospitals: uniqueHospitalIds,
    sectors: sectorScopes,
    canManageAll: false,
  };
}
