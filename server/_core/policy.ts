import { and, eq, isNull, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  managerScope,
  institutions,
  professionalInstitutions,
  professionals,
  users,
} from "../../drizzle/schema";
import { addMonthsYearMonth, yearMonthBrt } from "../local-time";
import type { TrpcContext } from "./context";
import { assertInstitutionHierarchy } from "./tenant";

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
  canViewSwapHistory: boolean;
  /** @deprecated Gestores não decidem trocas/cessões; mantido para compatibilidade tipada. */
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
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
      ),
    )
    .innerJoin(
      users,
      and(
        eq(users.id, professionalInstitutions.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, professionalInstitutions.institutionId),
        eq(institutions.isActive, true),
      ),
    )
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
      canViewSwapHistory: true,
      canApproveSwaps: false,
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
      canViewSwapHistory: true,
      canApproveSwaps: false,
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
      canViewSwapHistory: true,
      canApproveSwaps: false,
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
    canViewSwapHistory: false,
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

/**
 * Cadastrar hospital é catálogo da instituição, não jurisdição de escala.
 * GESTOR_MEDICO (mesmo com escopo hospital-wide) opera hospital existente;
 * só GESTOR_PLUS e admin criam o nó. Sem isto o próximo tenant não abre
 * calendário — Unimed só escapa porque o seed já tem o hospital.
 */
export function assertCanCreateHospital(actor: TenantActor): void {
  if (actor.isGlobalAdmin) return;
  if (actor.roleInInstitution === "GESTOR_PLUS") return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      actor.roleInInstitution === "GESTOR_MEDICO"
        ? "Apenas o Gestor+ ou o administrador da instituição podem cadastrar hospital."
        : "Apenas gestores da instituição podem cadastrar hospital.",
  });
}

export function isSameCalendarMonth(date: Date, now: Date): boolean {
  // Mês no relógio do hospital (-03:00), não no fuso do servidor (UTC).
  return yearMonthBrt(date) === yearMonthBrt(now);
}

/** GESTOR_MEDICO opera o mês corrente e o imediatamente seguinte (−03:00). */
export function isCurrentOrNextCalendarMonth(date: Date, now: Date): boolean {
  const target = yearMonthBrt(date);
  const current = yearMonthBrt(now);
  return target === current || target === addMonthsYearMonth(current, 1);
}

const GESTOR_MEDICO_MONTH_WINDOW_MESSAGE =
  "Gestor de hospital só pode editar escala do mês corrente ou do próximo.";

export function assertCanEditScheduleDate(actor: TenantActor, date: Date, now = new Date()): void {
  assertCanManageInstitutionSchedule(actor);
  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") return;
  if (actor.roleInInstitution === "GESTOR_MEDICO" && isCurrentOrNextCalendarMonth(date, now)) {
    return;
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: GESTOR_MEDICO_MONTH_WINDOW_MESSAGE,
  });
}

/**
 * `exact`: hospital inteiro (sector null) ou o setor informado.
 * `any-hospital`: qualquer jurisdição naquele hospital — publicar e
 * trancar o mês do hospital é a mesma cadeia operacional de abrir o setor.
 */
export type ManagerScopeMode = "exact" | "any-hospital";

export async function assertManagerScopeAccess(
  actor: TenantActor,
  hospitalId: number,
  sectorId?: number,
  options?: { mode?: ManagerScopeMode },
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const mode = options?.mode ?? "exact";

  await assertInstitutionHierarchy(
    { institutionId: actor.institutionId, hospitalId, sectorId },
    { db },
  );

  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") return;
  if (actor.roleInInstitution !== "GESTOR_MEDICO" || !actor.professionalId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Usuário sem permissão de gestão neste tenant",
    });
  }

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

  if (mode === "any-hospital") return;

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

type PolicyDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

/**
 * Revalida papel contextual e jurisdição dentro da transação que fará a
 * escrita. A autorização carregada no início da request não sobrevive a uma
 * revogação concorrente de vínculo, papel ou manager_scope.
 */
export async function assertManagerScopeAccessForUpdate(
  tx: PolicyDb,
  actor: TenantActor,
  expectedActorSessionVersion: number,
  hospitalId: number,
  sectorId: number | undefined,
  dates: readonly Date[] = [],
  options?: { mode?: ManagerScopeMode },
): Promise<"GESTOR_MEDICO" | "GESTOR_PLUS"> {
  await assertInstitutionHierarchy(
    { institutionId: actor.institutionId, hospitalId, sectorId },
    { db: tx, lockForShare: true },
  );
  if (!actor.professionalId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Profissional gestor não encontrado neste tenant",
    });
  }

  const [membershipSnapshot] = await tx
    .select({
      id: professionalInstitutions.id,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, actor.userId),
        eq(professionalInstitutions.professionalId, actor.professionalId),
        eq(professionalInstitutions.institutionId, actor.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  const [currentUser] = await tx
    .select({
      id: users.id,
      globalRole: users.role,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(
      and(
        eq(users.id, actor.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (
    currentUser &&
    currentUser.sessionVersion !== expectedActorSessionVersion
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A sessão gerencial foi revogada durante a operação. Entre novamente e repita.",
    });
  }
  const [currentProfessional] = await tx
    .select({ id: professionals.id })
    .from(professionals)
    .where(
      and(
        eq(professionals.id, actor.professionalId),
        eq(professionals.userId, actor.userId),
      ),
    )
    .limit(1)
    .for("update");
  const [membership] = membershipSnapshot
    ? await tx
        .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.id, membershipSnapshot.id),
            eq(professionalInstitutions.userId, actor.userId),
            eq(professionalInstitutions.professionalId, actor.professionalId),
            eq(professionalInstitutions.institutionId, actor.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        )
        .limit(1)
        .for("update")
    : [];
  if (!currentUser || !currentProfessional || !membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Vínculo institucional ativo não encontrado",
    });
  }

  const role: InstitutionRole =
    actor.isGlobalAdmin && currentUser.globalRole === "admin"
      ? "GESTOR_PLUS"
      : membership.roleInInstitution;
  if (role !== "GESTOR_MEDICO" && role !== "GESTOR_PLUS") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "O usuário não possui mais papel de gestor neste tenant",
    });
  }
  for (const date of dates) {
    if (role === "GESTOR_MEDICO" && !isCurrentOrNextCalendarMonth(date, new Date())) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: GESTOR_MEDICO_MONTH_WINDOW_MESSAGE,
      });
    }
  }
  if (role === "GESTOR_PLUS") return role;

  const mode = options?.mode ?? "exact";
  const scopeFilter =
    mode === "any-hospital"
      ? and(
          eq(managerScope.institutionId, actor.institutionId),
          eq(managerScope.managerProfessionalId, actor.professionalId),
          eq(managerScope.hospitalId, hospitalId),
          eq(managerScope.active, true),
        )
      : and(
          eq(managerScope.institutionId, actor.institutionId),
          eq(managerScope.managerProfessionalId, actor.professionalId),
          eq(managerScope.hospitalId, hospitalId),
          or(
            isNull(managerScope.sectorId),
            typeof sectorId === "number"
              ? eq(managerScope.sectorId, sectorId)
              : isNull(managerScope.sectorId),
          ),
          eq(managerScope.active, true),
        );
  const scopeQuery = tx
    .select({ id: managerScope.id })
    .from(managerScope)
    .where(scopeFilter)
    .limit(1);
  const [scope] = await scopeQuery.for("update");
  if (!scope) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        typeof sectorId === "number"
          ? "Gestor sem jurisdição ativa para este setor"
          : "Gestor sem jurisdição hospitalar ativa",
    });
  }
  return role;
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
