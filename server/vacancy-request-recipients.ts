import { and, eq, isNull, or } from "drizzle-orm";
import {
  hospitals,
  managerScope,
  professionalInstitutions,
  professionals,
  users,
} from "../drizzle/schema";
import type { OperationalEventTx } from "./operational-events";

/**
 * Identifica, por IDs canônicos, quem pode decidir uma solicitação de vaga
 * em um setor. A consulta espelha a política de decisão: GESTOR_MEDICO com
 * manager_scope hospitalar ou setorial, GESTOR_PLUS no tenant e admin global
 * com vínculo institucional ativo. Não carrega nome, e-mail ou texto livre.
 */
export type VacancyRequestRecipientScope = Readonly<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
}>;

/** Autoridade de decisão, preservando a combinação usuário-profissional. */
export type CanonicalVacancyRequestManager = Readonly<{
  userId: number;
  professionalId: number;
}>;

export type CanonicalVacancyRequestRequester = Readonly<{
  institutionId: number;
  professionalId: number;
  userId: number;
}>;

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} deve ser um ID positivo`);
  }
}

function canonicalManagers(
  rows: readonly CanonicalVacancyRequestManager[],
): readonly CanonicalVacancyRequestManager[] {
  const byIdentity = new Map<string, CanonicalVacancyRequestManager>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.userId) ||
      row.userId <= 0 ||
      !Number.isSafeInteger(row.professionalId) ||
      row.professionalId <= 0
    ) {
      throw new Error("Gestor responsável sem identidade canônica");
    }
    byIdentity.set(
      `${row.userId}:${row.professionalId}`,
      Object.freeze({ ...row }),
    );
  }
  return Object.freeze(
    [...byIdentity.values()].sort(
      (left, right) =>
        left.userId - right.userId ||
        left.professionalId - right.professionalId,
    ),
  );
}

export function canonicalVacancyRequestManagerUserIds(
  managers: readonly CanonicalVacancyRequestManager[],
): readonly number[] {
  return Object.freeze(
    [...new Set(managers.map((manager) => manager.userId))].sort(
      (left, right) => left - right,
    ),
  );
}

export function isCanonicalVacancyRequestManagerActor(
  managers: readonly CanonicalVacancyRequestManager[],
  actor: Readonly<{
    userId: number;
    professionalId?: number | null | undefined;
  }>,
): boolean {
  return (
    typeof actor.professionalId === "number" &&
    managers.some(
      (manager) =>
        manager.userId === actor.userId &&
        manager.professionalId === actor.professionalId,
    )
  );
}

/**
 * Todas as leituras ficam sob lock na mesma transação que persiste o fato.
 * Isso impede que um destinatário removido, desativado ou movido de escopo
 * entre a derivação e o ledger. Uma inclusão posterior é naturalmente
 * destinatária dos próximos fatos, sem reescrever o snapshot já auditado.
 */
export async function resolveCanonicalVacancyRequestManagers(
  tx: OperationalEventTx,
  scope: VacancyRequestRecipientScope,
): Promise<readonly CanonicalVacancyRequestManager[]> {
  assertPositiveId(scope.institutionId, "institutionId");
  assertPositiveId(scope.hospitalId, "hospitalId");
  assertPositiveId(scope.sectorId, "sectorId");

  const medicalManagers = await tx
    .select({
      userId: professionalInstitutions.userId,
      professionalId: professionalInstitutions.professionalId,
    })
    .from(managerScope)
    .innerJoin(
      hospitals,
      and(
        eq(hospitals.id, managerScope.hospitalId),
        eq(hospitals.institutionId, managerScope.institutionId),
      ),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(
          professionalInstitutions.professionalId,
          managerScope.managerProfessionalId,
        ),
        eq(professionalInstitutions.institutionId, managerScope.institutionId),
        eq(professionalInstitutions.roleInInstitution, "GESTOR_MEDICO"),
        eq(professionalInstitutions.active, true),
      ),
    )
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
    .where(
      and(
        eq(managerScope.institutionId, scope.institutionId),
        eq(managerScope.hospitalId, scope.hospitalId),
        or(
          isNull(managerScope.sectorId),
          eq(managerScope.sectorId, scope.sectorId),
        ),
        eq(managerScope.active, true),
      ),
    )
    .for("update");

  const institutionManagers = await tx
    .select({
      userId: professionalInstitutions.userId,
      professionalId: professionalInstitutions.professionalId,
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
    .where(
      and(
        eq(professionalInstitutions.institutionId, scope.institutionId),
        eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
        eq(professionalInstitutions.active, true),
      ),
    )
    .for("update");

  // `users.role = admin` prova a autoridade global, mas o fato preserva o
  // `roleInInstitution` do vínculo; esta consulta não inventa uma elevação.
  const globalAdmins = await tx
    .select({
      userId: professionalInstitutions.userId,
      professionalId: professionalInstitutions.professionalId,
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
        eq(users.role, "admin"),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.institutionId, scope.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .for("update");

  return canonicalManagers([
    ...medicalManagers,
    ...institutionManagers,
    ...globalAdmins,
  ]);
}

export async function resolveCanonicalVacancyRequestManagerUserIds(
  tx: OperationalEventTx,
  scope: VacancyRequestRecipientScope,
): Promise<readonly number[]> {
  return canonicalVacancyRequestManagerUserIds(
    await resolveCanonicalVacancyRequestManagers(tx, scope),
  );
}

/**
 * Entregabilidade é avaliada no momento do fato e não define a identidade da
 * solicitação. Uma decisão legítima não pode ser desfeita porque o médico foi
 * desativado, teve a conta revogada ou deixou de ser aprovado entre o pedido e
 * a resposta gerencial.
 */
export async function isCanonicalVacancyRequestRequesterDeliverable(
  tx: OperationalEventTx,
  requester: CanonicalVacancyRequestRequester,
): Promise<boolean> {
  assertPositiveId(requester.institutionId, "institutionId");
  assertPositiveId(requester.professionalId, "professionalId");
  assertPositiveId(requester.userId, "userId");

  const [membership] = await tx
    .select({ id: professionalInstitutions.id })
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
    .where(
      and(
        eq(professionalInstitutions.institutionId, requester.institutionId),
        eq(professionalInstitutions.professionalId, requester.professionalId),
        eq(professionalInstitutions.userId, requester.userId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1)
    .for("update");
  return Boolean(membership);
}
