import { getDb } from "./db";
import { professionals, managerScope } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";

/**
 * Busca o manager_scope de um gestor (GESTOR_MEDICO ou GESTOR_PLUS)
 * Retorna lista de hospitais e setores que o gestor pode gerenciar
 */
export async function getManagerScope(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Buscar profissional do usuário
  const [professional] = await db
    .select()
    .from(professionals)
    .where(eq(professionals.userId, userId));

  if (!professional) {
    throw new Error("Profissional não encontrado");
  }

  const role = professional.userRole;

  // USER não tem manager_scope
  if (role === "USER") {
    return {
      role: "USER" as const,
      hospitals: [],
      sectors: [],
      canManageAll: false,
    };
  }

  // GESTOR_PLUS pode gerenciar tudo
  if (role === "GESTOR_PLUS") {
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
        eq(managerScope.managerProfessionalId, professional.id),
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
