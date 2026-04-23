import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  managerScope,
  professionalInstitutions,
  professionals,
} from "../../drizzle/schema";
import type { TrpcContext } from "./context";

export type InstitutionRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

export type TenantActor = {
  userId: number;
  institutionId: number;
  professionalId: number | null;
  roleInInstitution: InstitutionRole;
  isGlobalAdmin: boolean;
};

export type TenantCapabilities = {
  canViewDashboard: boolean;
  canViewReports: boolean;
  canViewVacancies: boolean;
  canViewWeekly: boolean;
  canViewAdmin: boolean;
  canCreateShift: boolean;
  canEditShift: boolean;
  canApproveSwaps: boolean;
  canRequestSwap: boolean;
  canApproveAssignments: boolean;
};

export async function resolveTenantActor(
  userId: number,
  institutionId: number,
  isGlobalAdmin: boolean,
): Promise<TenantActor> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [membership] = await db
    .select({
      professionalId: professionalInstitutions.professionalId,
      roleInInstitution: professionalInstitutions.roleInInstitution,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Usuário sem vínculo ativo para a instituição",
    });
  }

  return {
    userId,
    institutionId,
    professionalId: membership.professionalId,
    roleInInstitution: membership.roleInInstitution,
    isGlobalAdmin,
  };
}

export async function getTenantActorFromContext(ctx: TrpcContext): Promise<TenantActor> {
  if (!ctx.user || !ctx.institutionId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Contexto autenticado e tenant ativo são obrigatórios",
    });
  }

  return resolveTenantActor(ctx.user.id, ctx.institutionId, ctx.user.role === "admin");
}

export function actorCapabilities(actor: TenantActor): TenantCapabilities {
  if (actor.isGlobalAdmin) {
    return {
      canViewDashboard: true,
      canViewReports: true,
      canViewVacancies: true,
      canViewWeekly: true,
      canViewAdmin: true,
      canCreateShift: true,
      canEditShift: true,
      canApproveSwaps: true,
      canRequestSwap: true,
      canApproveAssignments: true,
    };
  }

  if (actor.roleInInstitution === "GESTOR_PLUS") {
    return {
      canViewDashboard: true,
      canViewReports: true,
      canViewVacancies: true,
      canViewWeekly: true,
      canViewAdmin: false,
      canCreateShift: true,
      canEditShift: true,
      canApproveSwaps: true,
      canRequestSwap: true,
      canApproveAssignments: true,
    };
  }

  if (actor.roleInInstitution === "GESTOR_MEDICO") {
    return {
      canViewDashboard: true,
      canViewReports: true,
      canViewVacancies: true,
      canViewWeekly: true,
      canViewAdmin: false,
      canCreateShift: true,
      canEditShift: true,
      canApproveSwaps: true,
      canRequestSwap: true,
      canApproveAssignments: true,
    };
  }

  return {
    canViewDashboard: false,
    canViewReports: false,
    canViewVacancies: true,
    canViewWeekly: false,
    canViewAdmin: false,
    canCreateShift: false,
    canEditShift: false,
    canApproveSwaps: false,
    canRequestSwap: true,
    canApproveAssignments: false,
  };
}

export function assertCanManageInstitutionSchedule(actor: TenantActor): void {
  if (actor.isGlobalAdmin) return;
  if (actor.roleInInstitution === "GESTOR_MEDICO" || actor.roleInInstitution === "GESTOR_PLUS") return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Apenas gestores da instituição podem gerenciar escalas",
  });
}

export async function assertManagerScopeAccess(
  actor: TenantActor,
  hospitalId: number,
  sectorId?: number,
): Promise<void> {
  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") return;
  if (actor.roleInInstitution !== "GESTOR_MEDICO" || !actor.professionalId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Usuário sem permissão de gestão neste tenant",
    });
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const scopes = await db
    .select({ id: managerScope.id, sectorId: managerScope.sectorId })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.institutionId, actor.institutionId),
        eq(managerScope.managerProfessionalId, actor.professionalId),
        eq(managerScope.hospitalId, hospitalId),
        eq(managerScope.active, true),
      ),
    );

  if (scopes.length === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Gestor sem jurisdição para este hospital",
    });
  }

  const hasHospitalScope = scopes.some((s) => s.sectorId === null);
  const hasSectorScope =
    typeof sectorId === "number" ? scopes.some((s) => s.sectorId === sectorId) : false;
  const authorized = typeof sectorId === "number" ? hasHospitalScope || hasSectorScope : hasHospitalScope;
  if (!authorized) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        typeof sectorId === "number"
          ? "Gestor sem jurisdição para este setor"
          : "Gestor sem jurisdição hospitalar",
    });
  }
}

export async function getProfessionalIdForActor(actor: TenantActor): Promise<number | null> {
  if (actor.professionalId) return actor.professionalId;
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [professional] = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, actor.userId))
    .limit(1);
  return professional?.id ?? null;
}
