import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  hospitals,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleInvites,
  scheduleInviteIssuanceFences,
  scheduleContexts,
  sectors,
  users,
} from "../drizzle/schema";
import { mailer } from "./mailer";
import { buildScheduleInviteMail } from "./schedule-invite-mail";
import {
  formatScheduleInviteCode,
  generateScheduleInviteCode,
  hashScheduleInviteCode,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";
import { recordAudit } from "./audit-trail";
import { getDb } from "./db";
import {
  assertManagerScopeAccessForUpdate,
  getTenantActorFromContext,
  type TenantActor,
} from "./_core/policy";
import {
  listAuthorizedScheduleContexts,
  selectActiveScheduleContexts,
} from "./schedule-contexts";
import { protectedProcedure, router } from "./_core/trpc";

const NAMED_TTL_MS = 24 * 60 * 60 * 1000;
const NAMED_MAX_REDEMPTIONS = 1;

/** Busca por nome: sem acento e sem maiúscula, para o gestor achar "José" com "jose". */
export function foldCandidateSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export class ScheduleInviteError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

type InviteDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select" | "insert" | "update"
>;
type ScheduleInviteDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ScheduleInviteWriteDb = Parameters<
  typeof assertManagerScopeAccessForUpdate
>[0];

const SCHEDULE_INVITE_ISSUANCE_LEASE_MS = 60_000;

type InviteIssuanceScope = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  userId: number;
};

/**
 * Gancho exclusivamente adversarial. Permite provar que uma alteração feita
 * depois do lock da fence, mas ainda dentro da transação de ativação, é lida
 * pelas locking reads correntes. O runtime de produção nunca o executa.
 */
export const __scheduleInviteTestHooks: {
  afterActivationFenceLocked?: () => Promise<void>;
} = {};

function updateAffectedRows(result: unknown): number {
  if (result && typeof result === "object" && "affectedRows" in result) {
    return Number((result as { affectedRows?: number }).affectedRows);
  }
  if (Array.isArray(result)) {
    return Number(
      (result[0] as { affectedRows?: number } | undefined)?.affectedRows,
    );
  }
  return 0;
}

export async function peekScheduleInviteInstitution(
  db: InviteDb,
  code: string,
  now = new Date(),
): Promise<{ institutionId: number }> {
  const codeHash = hashScheduleInviteCode(code);
  const [invite] = await db
    .select({
      institutionId: scheduleInvites.institutionId,
      expiresAt: scheduleInvites.expiresAt,
      revokedAt: scheduleInvites.revokedAt,
      declinedAt: scheduleInvites.declinedAt,
      redeemedCount: scheduleInvites.redeemedCount,
      maxRedemptions: scheduleInvites.maxRedemptions,
    })
    .from(scheduleInvites)
    .where(eq(scheduleInvites.codeHash, codeHash))
    .limit(1);
  if (
    !invite ||
    invite.revokedAt ||
    invite.declinedAt ||
    invite.expiresAt.getTime() <= now.getTime() ||
    invite.redeemedCount >= invite.maxRedemptions
  ) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }
  return { institutionId: invite.institutionId };
}

export function parseInviteCode(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ScheduleInviteError(400, "Informe o código do convite");
  }
  const normalized = normalizeScheduleInviteCode(raw);
  if (normalized.length !== 8) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }
  return normalized;
}

async function assertCanManageSector(
  actor: TenantActor,
  hospitalId: number,
  sectorId: number,
): Promise<void> {
  const authorized = await listAuthorizedScheduleContexts(actor);
  const canManage = authorized.some(
    (context) =>
      context.canManage &&
      context.hospitalId === hospitalId &&
      context.sectorId === sectorId,
  );
  if (!canManage) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Você não gerencia esta escala",
    });
  }
}

export async function redeemScheduleInviteInTransaction(
  tx: InviteDb,
  input: {
    code: string;
    userId: number;
    professionalId: number;
    now?: Date;
  },
): Promise<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  hospitalName: string;
  sectorName: string;
  scheduleInviteId: number;
  createdByUserId: number;
  invitedUserId: number;
}> {
  const now = input.now ?? new Date();
  const codeHash = hashScheduleInviteCode(input.code);
  // Ordem global de locks dos fluxos de convite: users → identidade → invite.
  // A emissão também começa pelo usuário, evitando ciclo entre um resgate que
  // segura o convite e uma nova emissão que precisa revalidar o destinatário.
  const [lockedUser] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .for("update");
  if (!lockedUser) {
    throw new ScheduleInviteError(409, "Profissional não encontrado");
  }
  const [invite] = await tx
    .select()
    .from(scheduleInvites)
    .where(eq(scheduleInvites.codeHash, codeHash))
    .limit(1)
    .for("update");
  if (
    !invite ||
    invite.revokedAt ||
    invite.declinedAt ||
    invite.expiresAt.getTime() <= now.getTime() ||
    invite.redeemedCount >= invite.maxRedemptions
  ) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }
  if (!invite.invitedUserId || invite.invitedUserId !== input.userId) {
    throw new ScheduleInviteError(
      403,
      "Este convite não foi emitido para a sua conta",
    );
  }

  const [sector] = await tx
    .select({
      id: sectors.id,
      name: sectors.name,
      institutionId: sectors.institutionId,
      hospitalId: sectors.hospitalId,
    })
    .from(sectors)
    .where(
      and(
        eq(sectors.id, invite.sectorId),
        eq(sectors.institutionId, invite.institutionId),
        eq(sectors.hospitalId, invite.hospitalId),
      ),
    )
    .limit(1)
    .for("share");
  const [hospital] = await tx
    .select({ id: hospitals.id, name: hospitals.name })
    .from(hospitals)
    .where(
      and(
        eq(hospitals.id, invite.hospitalId),
        eq(hospitals.institutionId, invite.institutionId),
      ),
    )
    .limit(1)
    .for("share");
  if (!sector || !hospital) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }

  const contexts = await selectActiveScheduleContexts(
    tx,
    invite.institutionId,
    { hospitalId: invite.hospitalId, sectorId: invite.sectorId },
    true,
  );
  if (contexts.length !== 1) {
    throw new ScheduleInviteError(
      409,
      contexts.length === 0
        ? "A escala deste convite não está mais ativa"
        : "O setor deste convite possui mais de uma escala ativa; regularize a topologia.",
    );
  }

  const professionalRows = await tx
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, input.userId))
    .limit(2)
    .for("update");
  if (
    professionalRows.length !== 1 ||
    professionalRows[0]!.id !== input.professionalId
  ) {
    throw new ScheduleInviteError(
      409,
      "Identidade profissional inconsistente. Procure o suporte.",
    );
  }

  const memberships = await tx
    .select({
      id: professionalInstitutions.id,
      professionalId: professionalInstitutions.professionalId,
      institutionId: professionalInstitutions.institutionId,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, input.userId))
    .for("update");
  if (
    memberships.some(
      (row) => row.professionalId !== input.professionalId,
    )
  ) {
    throw new ScheduleInviteError(
      409,
      "Identidade profissional inconsistente. Procure o suporte.",
    );
  }
  const membership = memberships.find(
    (row) => row.institutionId === invite.institutionId,
  );
  const hasOtherActiveHouse = memberships.some(
    (row) => row.active && row.institutionId !== invite.institutionId,
  );
  if (!membership) {
    await tx.insert(professionalInstitutions).values({
      professionalId: input.professionalId,
      userId: input.userId,
      institutionId: invite.institutionId,
      roleInInstitution: "USER",
      isPrimary: !hasOtherActiveHouse,
      active: true,
    });
  } else if (!membership.active) {
    await tx
      .update(professionalInstitutions)
      .set({ active: true })
      .where(eq(professionalInstitutions.id, membership.id));
  }

  // QUALIFICATION_ALLOWLIST (Sala de Recuperação) exige acesso setorial
  // exato em listAssignableForShift. Vínculo institucional sozinho não
  // coloca o médico na lista de plantonistas — gravamos o setor do convite.
  const [existingAccess] = await tx
    .select({
      id: professionalAccess.id,
      canAccess: professionalAccess.canAccess,
    })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.institutionId, invite.institutionId),
        eq(professionalAccess.professionalId, input.professionalId),
        eq(professionalAccess.hospitalId, invite.hospitalId),
        eq(professionalAccess.sectorId, invite.sectorId),
      ),
    )
    .limit(1)
    .for("update");
  if (existingAccess?.canAccess) {
    throw new ScheduleInviteError(409, "Você já está nesta escala");
  }
  if (!existingAccess) {
    await tx.insert(professionalAccess).values({
      institutionId: invite.institutionId,
      professionalId: input.professionalId,
      hospitalId: invite.hospitalId,
      sectorId: invite.sectorId,
      canAccess: true,
    });
  } else {
    await tx
      .update(professionalAccess)
      .set({ canAccess: true })
      .where(eq(professionalAccess.id, existingAccess.id));
  }

  await tx
    .update(users)
    .set({ approvalStatus: "APPROVED" })
    .where(eq(users.id, input.userId));

  const increment = await tx
    .update(scheduleInvites)
    .set({ redeemedCount: sql`${scheduleInvites.redeemedCount} + 1` })
    .where(
      and(
        eq(scheduleInvites.id, invite.id),
        isNull(scheduleInvites.revokedAt),
        isNull(scheduleInvites.declinedAt),
        sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
      ),
    );
  if (updateAffectedRows(increment) !== 1) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }

  await recordAudit(
    {
      institutionId: invite.institutionId,
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: input.userId,
      actorUserId: input.userId,
      actorRole: "doctor",
      description: `Convite da escala ${hospital.name} / ${sector.name} resgatado`,
      metadata: {
        scheduleInviteId: invite.id,
        hospitalId: invite.hospitalId,
        sectorId: invite.sectorId,
      },
      hospitalId: invite.hospitalId,
      sectorId: invite.sectorId,
    },
    { db: tx, strict: true },
  );

  return {
    institutionId: invite.institutionId,
    hospitalId: invite.hospitalId,
    sectorId: invite.sectorId,
    hospitalName: hospital.name,
    sectorName: sector.name,
    scheduleInviteId: invite.id,
    createdByUserId: invite.createdByUserId,
    invitedUserId: invite.invitedUserId!,
  };
}

export async function declineScheduleInviteInTransaction(
  tx: InviteDb,
  input: {
    code: string;
    userId: number;
    now?: Date;
  },
): Promise<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  hospitalName: string;
  sectorName: string;
  scheduleInviteId: number;
  createdByUserId: number;
  invitedUserId: number;
}> {
  const now = input.now ?? new Date();
  const codeHash = hashScheduleInviteCode(input.code);
  const [invite] = await tx
    .select()
    .from(scheduleInvites)
    .where(eq(scheduleInvites.codeHash, codeHash))
    .limit(1)
    .for("update");
  if (!invite) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }
  if (invite.declinedAt) {
    throw new ScheduleInviteError(400, "Este convite já foi recusado");
  }
  if (
    invite.revokedAt ||
    invite.expiresAt.getTime() <= now.getTime() ||
    invite.redeemedCount >= invite.maxRedemptions
  ) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }
  if (!invite.invitedUserId || invite.invitedUserId !== input.userId) {
    throw new ScheduleInviteError(
      403,
      "Este convite não foi emitido para a sua conta",
    );
  }

  const [sector] = await tx
    .select({
      id: sectors.id,
      name: sectors.name,
      institutionId: sectors.institutionId,
      hospitalId: sectors.hospitalId,
    })
    .from(sectors)
    .where(
      and(
        eq(sectors.id, invite.sectorId),
        eq(sectors.institutionId, invite.institutionId),
        eq(sectors.hospitalId, invite.hospitalId),
      ),
    )
    .limit(1)
    .for("share");
  const [hospital] = await tx
    .select({ id: hospitals.id, name: hospitals.name })
    .from(hospitals)
    .where(
      and(
        eq(hospitals.id, invite.hospitalId),
        eq(hospitals.institutionId, invite.institutionId),
      ),
    )
    .limit(1)
    .for("share");
  if (!sector || !hospital) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }

  const declined = await tx
    .update(scheduleInvites)
    .set({
      declinedAt: now,
      declinedByUserId: input.userId,
    })
    .where(
      and(
        eq(scheduleInvites.id, invite.id),
        isNull(scheduleInvites.revokedAt),
        isNull(scheduleInvites.declinedAt),
        sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
        sql`${scheduleInvites.expiresAt} > ${now}`,
      ),
    );
  if (updateAffectedRows(declined) !== 1) {
    const [current] = await tx
      .select({
        declinedAt: scheduleInvites.declinedAt,
        redeemedCount: scheduleInvites.redeemedCount,
        maxRedemptions: scheduleInvites.maxRedemptions,
      })
      .from(scheduleInvites)
      .where(eq(scheduleInvites.id, invite.id))
      .limit(1);
    if (current?.declinedAt) {
      throw new ScheduleInviteError(400, "Este convite já foi recusado");
    }
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }

  await recordAudit(
    {
      institutionId: invite.institutionId,
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: input.userId,
      actorUserId: input.userId,
      actorRole: "doctor",
      description: "Convite nominal recusado",
      metadata: {
        scheduleInviteId: invite.id,
        institutionId: invite.institutionId,
        hospitalId: invite.hospitalId,
        sectorId: invite.sectorId,
      },
      hospitalId: invite.hospitalId,
      sectorId: invite.sectorId,
    },
    { db: tx, strict: true },
  );

  return {
    institutionId: invite.institutionId,
    hospitalId: invite.hospitalId,
    sectorId: invite.sectorId,
    hospitalName: hospital.name,
    sectorName: sector.name,
    scheduleInviteId: invite.id,
    createdByUserId: invite.createdByUserId,
    invitedUserId: invite.invitedUserId,
  };
}

type CandidateDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

type InvitableCandidate = {
  userId: number;
  professionalId: number;
  name: string | null;
  email: string | null;
  specialtyLabel: string | null;
};

/**
 * Fonte ÚNICA de elegibilidade para convites nominais — usada tanto pela busca
 * (`listCandidates`) quanto pela criação (`create`), para que não divirjam. Um
 * `userId` que a busca esconde NÃO pode ser convidado direto por id.
 *
 * Elegíveis: membros da casa (vínculo ativo nesta instituição) e sala de espera
 * (APPROVED sem vínculo ativo em lugar nenhum). Excluídos, fail-closed:
 *  - já com ACL operacional no hospital+setor pedido (já na escala);
 *  - com ACL apenas em outro hospital da MESMA instituição (hospital irmão) e
 *    sem ACL no hospital pedido — não pertence implicitamente a este plantel;
 *  - travado com vínculo ativo em OUTRA instituição.
 * Especialidade não é ACL e não filtra aqui.
 */
async function selectInvitableCandidates(
  db: CandidateDb,
  institutionId: number,
  hospitalId: number,
  sectorId: number,
  onlyUserIds?: number[],
): Promise<InvitableCandidate[]> {
  const identityRows = await db
    .select({
      userId: users.id,
      professionalId: professionals.id,
      name: users.name,
      email: users.email,
      specialtyLabel: professionals.specialty,
    })
    .from(users)
    .innerJoin(professionals, eq(professionals.userId, users.id))
    .where(
      and(
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
        onlyUserIds?.length ? inArray(users.id, onlyUserIds) : undefined,
      ),
    );

  const professionalIdsByUser = new Map<number, Set<number>>();
  for (const row of identityRows) {
    const ids = professionalIdsByUser.get(row.userId) ?? new Set<number>();
    ids.add(row.professionalId);
    professionalIdsByUser.set(row.userId, ids);
  }

  const byId = new Map<number, InvitableCandidate>();
  for (const row of identityRows) {
    // Cadastro profissional 1:1 ainda não é uma constraint física. Não
    // escolha uma linha arbitrária: convite emitido para identidade ambígua
    // seria recusado pelo redeem e criaria um fluxo impossível.
    if (professionalIdsByUser.get(row.userId)?.size !== 1) continue;
    byId.set(row.userId, row);
  }
  const candidates = [...byId.values()];
  if (candidates.length === 0) return [];
  const candidateIds = candidates.map((row) => row.userId);

  const hospitalAccess = await db
    .select({
      professionalUserId: professionals.userId,
      hospitalId: professionalAccess.hospitalId,
    })
    .from(professionalAccess)
    .innerJoin(
      professionals,
      eq(professionals.id, professionalAccess.professionalId),
    )
    .where(
      and(
        eq(professionalAccess.institutionId, institutionId),
        eq(professionalAccess.canAccess, true),
        inArray(professionals.userId, candidateIds),
      ),
    );
  const linkedToRequestedHospital = new Set(
    hospitalAccess
      .filter((row) => row.hospitalId === hospitalId)
      .map((row) => row.professionalUserId),
  );
  const linkedOnlyElsewhere = new Set(
    hospitalAccess
      .filter((row) => row.hospitalId !== hospitalId)
      .map((row) => row.professionalUserId),
  );

  const access = await db
    .select({
      professionalUserId: professionals.userId,
      canAccess: professionalAccess.canAccess,
    })
    .from(professionalAccess)
    .innerJoin(
      professionals,
      eq(professionals.id, professionalAccess.professionalId),
    )
    .where(
      and(
        eq(professionalAccess.institutionId, institutionId),
        eq(professionalAccess.hospitalId, hospitalId),
        eq(professionalAccess.sectorId, sectorId),
        inArray(professionals.userId, candidateIds),
      ),
    );
  const alreadyInScale = new Set(
    access.filter((row) => row.canAccess).map((row) => row.professionalUserId),
  );

  const memberships = await db
    .select({
      userId: professionalInstitutions.userId,
      professionalId: professionalInstitutions.professionalId,
      institutionId: professionalInstitutions.institutionId,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .where(
      inArray(professionalInstitutions.userId, candidateIds),
    );
  const canonicalProfessionalByUser = new Map(
    candidates.map((row) => [row.userId, row.professionalId] as const),
  );
  const crossedIdentity = new Set(
    memberships
      .filter(
        (row) =>
          canonicalProfessionalByUser.get(row.userId) !== row.professionalId,
      )
      .map((row) => row.userId),
  );
  const inThisHouse = new Set(
    memberships
      .filter((row) => row.active && row.institutionId === institutionId)
      .map((row) => row.userId),
  );
  const lockedToOtherHouse = new Set(
    memberships
      .filter(
        (row) =>
          row.active &&
          row.institutionId !== institutionId &&
          !inThisHouse.has(row.userId),
      )
      .map((row) => row.userId),
  );

  return candidates.filter((row) => {
    if (crossedIdentity.has(row.userId)) return false;
    if (alreadyInScale.has(row.userId)) return false;
    if (
      linkedOnlyElsewhere.has(row.userId) &&
      !linkedToRequestedHospital.has(row.userId)
    ) {
      return false;
    }
    if (lockedToOtherHouse.has(row.userId)) return false;
    return true;
  });
}

type InviteContextSnapshot = {
  id: number;
  institutionId: number;
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
};

type InviteIssuanceSnapshot = {
  context: InviteContextSnapshot;
  invitee: InvitableCandidate;
};

async function selectCurrentInviteContextForShare(
  tx: ScheduleInviteWriteDb,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
  },
): Promise<InviteContextSnapshot[]> {
  // Esta consulta é deliberadamente autocontida e locking. Não chama o
  // enriquecimento de leitura comum (que faria consistent reads adicionais
  // em REPEATABLE READ) dentro da transação que ativa o convite.
  return tx
    .select({
      id: scheduleContexts.id,
      institutionId: scheduleContexts.institutionId,
      hospitalId: scheduleContexts.hospitalId,
      hospitalName: hospitals.name,
      sectorId: scheduleContexts.sectorId,
      sectorName: sectors.name,
    })
    .from(scheduleContexts)
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, scheduleContexts.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .innerJoin(
      hospitals,
      and(
        eq(hospitals.id, scheduleContexts.hospitalId),
        eq(hospitals.institutionId, scheduleContexts.institutionId),
      ),
    )
    .innerJoin(
      sectors,
      and(
        eq(sectors.id, scheduleContexts.sectorId),
        eq(sectors.institutionId, scheduleContexts.institutionId),
        eq(sectors.hospitalId, scheduleContexts.hospitalId),
      ),
    )
    .where(
      and(
        eq(scheduleContexts.institutionId, input.institutionId),
        eq(scheduleContexts.hospitalId, input.hospitalId),
        eq(scheduleContexts.sectorId, input.sectorId),
        eq(scheduleContexts.active, true),
        or(
          and(
            eq(scheduleContexts.admissionPolicy, "PINNED_QUALIFICATION"),
            isNotNull(scheduleContexts.medicalSpecialtyId),
            isNull(scheduleContexts.operationalProfileCode),
          ),
          and(
            eq(scheduleContexts.admissionPolicy, "PINNED_QUALIFICATION"),
            isNull(scheduleContexts.medicalSpecialtyId),
            isNotNull(scheduleContexts.operationalProfileCode),
          ),
          and(
            or(
              eq(scheduleContexts.admissionPolicy, "ALL_CFM_SPECIALTIES"),
              eq(
                scheduleContexts.admissionPolicy,
                "ALL_CFM_EXCEPT_GENERALIST",
              ),
              eq(scheduleContexts.admissionPolicy, "QUALIFICATION_ALLOWLIST"),
            ),
            isNull(scheduleContexts.medicalSpecialtyId),
            isNull(scheduleContexts.operationalProfileCode),
          ),
        ),
      ),
    )
    .for("share");
}

async function selectInvitableCandidateForUpdate(
  tx: ScheduleInviteWriteDb,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    userId: number;
  },
): Promise<InvitableCandidate | null> {
  const [currentUser] = await tx
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(
      and(
        eq(users.id, input.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!currentUser) return null;

  const professionalRows = await tx
    .select({ id: professionals.id, specialty: professionals.specialty })
    .from(professionals)
    .where(eq(professionals.userId, input.userId))
    .limit(2)
    .for("update");
  if (professionalRows.length !== 1) return null;
  const professional = professionalRows[0]!;

  const memberships = await tx
    .select({
      professionalId: professionalInstitutions.professionalId,
      institutionId: professionalInstitutions.institutionId,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, input.userId))
    .for("update");
  if (
    memberships.some((row) => row.professionalId !== professional.id)
  ) {
    return null;
  }
  const inThisHouse = memberships.some(
    (row) => row.active && row.institutionId === input.institutionId,
  );
  if (
    !inThisHouse &&
    memberships.some(
      (row) => row.active && row.institutionId !== input.institutionId,
    )
  ) {
    return null;
  }

  const accessRows = await tx
    .select({
      hospitalId: professionalAccess.hospitalId,
      sectorId: professionalAccess.sectorId,
      canAccess: professionalAccess.canAccess,
    })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.professionalId, professional.id),
        eq(professionalAccess.institutionId, input.institutionId),
      ),
    )
    .for("update");
  const enabledAccess = accessRows.filter((row) => row.canAccess);
  if (
    enabledAccess.some(
      (row) =>
        row.hospitalId === input.hospitalId && row.sectorId === input.sectorId,
    )
  ) {
    return null;
  }
  const linkedToRequestedHospital = enabledAccess.some(
    (row) => row.hospitalId === input.hospitalId,
  );
  const linkedOnlyElsewhere = enabledAccess.some(
    (row) => row.hospitalId !== input.hospitalId,
  );
  if (linkedOnlyElsewhere && !linkedToRequestedHospital) return null;

  return {
    userId: currentUser.id,
    professionalId: professional.id,
    name: currentUser.name,
    email: currentUser.email,
    specialtyLabel: professional.specialty,
  };
}

async function revalidateInviteIssuanceForUpdate(
  tx: ScheduleInviteWriteDb,
  input: {
    actor: TenantActor;
    expectedActorSessionVersion: number;
    hospitalId: number;
    sectorId: number;
    userId: number;
  },
): Promise<InviteIssuanceSnapshot | null> {
  await assertManagerScopeAccessForUpdate(
    tx,
    input.actor,
    input.expectedActorSessionVersion,
    input.hospitalId,
    input.sectorId,
  );
  const contexts = await selectCurrentInviteContextForShare(tx, {
    institutionId: input.actor.institutionId,
    hospitalId: input.hospitalId,
    sectorId: input.sectorId,
  });
  if (contexts.length !== 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        contexts.length === 0
          ? "Esta escala ainda não está aberta"
          : "Este setor possui mais de uma escala ativa; regularize a topologia.",
    });
  }
  const invitee = await selectInvitableCandidateForUpdate(tx, {
    institutionId: input.actor.institutionId,
    hospitalId: input.hospitalId,
    sectorId: input.sectorId,
    userId: input.userId,
  });
  return invitee ? { context: contexts[0]!, invitee } : null;
}

type InviteIssuanceDb = Pick<
  ScheduleInviteDb,
  "select" | "insert" | "update"
>;

function fenceScopeWhere(scope: InviteIssuanceScope) {
  return and(
    eq(scheduleInviteIssuanceFences.institutionId, scope.institutionId),
    eq(scheduleInviteIssuanceFences.hospitalId, scope.hospitalId),
    eq(scheduleInviteIssuanceFences.sectorId, scope.sectorId),
    eq(scheduleInviteIssuanceFences.invitedUserId, scope.userId),
  );
}

async function activeNamedInvitesForUpdate(
  tx: InviteIssuanceDb,
  scope: InviteIssuanceScope,
  now: Date,
) {
  return tx
    .select({ id: scheduleInvites.id })
    .from(scheduleInvites)
    .where(
      and(
        eq(scheduleInvites.institutionId, scope.institutionId),
        eq(scheduleInvites.hospitalId, scope.hospitalId),
        eq(scheduleInvites.sectorId, scope.sectorId),
        eq(scheduleInvites.invitedUserId, scope.userId),
        isNull(scheduleInvites.revokedAt),
        isNull(scheduleInvites.declinedAt),
        gt(scheduleInvites.expiresAt, now),
        sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
      ),
    )
    .limit(2)
    .for("update");
}

type InviteIssuanceClaim =
  | { kind: "CLAIMED"; generation: number; snapshot: InviteIssuanceSnapshot }
  | { kind: "INELIGIBLE" }
  | { kind: "ALREADY_ACTIVE" }
  | { kind: "IN_PROGRESS" };

async function lockInviteParticipantsForUpdate(
  tx: InviteIssuanceDb,
  actorUserId: number,
  invitedUserId: number,
): Promise<void> {
  // Duas emissões cruzadas (gestor A convida B; gestor B convida A) não
  // podem bloquear actor→recipient em ordens opostas. A cerca por
  // destinatário é distinta nesse caso; esta ordena os dois gates de usuário.
  await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, [...new Set([actorUserId, invitedUserId])]))
    .orderBy(asc(users.id))
    .for("update");
}

/**
 * Reserva uma geração em uma transação curta. A UNIQUE física da fence
 * faz a serialização entre processos/instâncias. O commit acontece antes de
 * montar ou enviar o e-mail; portanto nenhuma conexão do pool acompanha a
 * latência do provedor.
 */
async function claimInviteIssuance(
  db: ScheduleInviteDb,
  input: {
    scope: InviteIssuanceScope;
    actor: TenantActor;
    expectedActorSessionVersion: number;
  },
): Promise<InviteIssuanceClaim> {
  return db.transaction(async (tx) => {
    // Precisa ser o primeiro lock: o INSERT da fence valida FKs e já adquire
    // lock compartilhado no destinatário. Em emissões cruzadas A→B/B→A isso
    // deadlockaria antes mesmo do nosso lock explícito se viesse depois.
    await lockInviteParticipantsForUpdate(
      tx,
      input.actor.userId,
      input.scope.userId,
    );
    await tx
      .insert(scheduleInviteIssuanceFences)
      .values({
        institutionId: input.scope.institutionId,
        hospitalId: input.scope.hospitalId,
        sectorId: input.scope.sectorId,
        invitedUserId: input.scope.userId,
      })
      .onDuplicateKeyUpdate({
        set: {
          generation: sql`${scheduleInviteIssuanceFences.generation}`,
        },
      });
    const [fence] = await tx
      .select({
        id: scheduleInviteIssuanceFences.id,
        generation: scheduleInviteIssuanceFences.generation,
        state: scheduleInviteIssuanceFences.state,
        leaseExpiresAt: scheduleInviteIssuanceFences.leaseExpiresAt,
      })
      .from(scheduleInviteIssuanceFences)
      .where(fenceScopeWhere(input.scope))
      .limit(1)
      .for("update");
    if (!fence) throw new Error("SCHEDULE_INVITE_FENCE_NOT_CREATED");

    const now = new Date();

    // Toda autoridade e identidade é revalidada depois que esta requisição
    // possui a seção serializada. Nenhum snapshot anterior autoriza a escrita
    // nem mesmo uma resposta ALREADY_ACTIVE/IN_PROGRESS.
    const snapshot = await revalidateInviteIssuanceForUpdate(tx, {
      actor: input.actor,
      expectedActorSessionVersion: input.expectedActorSessionVersion,
      hospitalId: input.scope.hospitalId,
      sectorId: input.scope.sectorId,
      userId: input.scope.userId,
    });
    if (!snapshot?.invitee.email) return { kind: "INELIGIBLE" };

    // Todas as identidades já estão bloqueadas antes do convite, a mesma
    // ordem usada pelo redeem. Assim não há ciclo user/professional ↔ invite.
    const activeInvites = await activeNamedInvitesForUpdate(
      tx,
      input.scope,
      now,
    );

    // Cooldown forte: um convite ainda resgatável nunca é substituído por
    // um reenvio implícito. Isso mantém correspondência entre a confirmação
    // anterior e o código que continua ativo.
    if (activeInvites.length > 0) return { kind: "ALREADY_ACTIVE" };

    if (
      (fence.state === "PREPARING" ||
        fence.state === "PROVIDER_ACCEPTED") &&
      fence.leaseExpiresAt &&
      fence.leaseExpiresAt.getTime() > now.getTime()
    ) {
      return { kind: "IN_PROGRESS" };
    }

    const generation = fence.generation + 1;
    await tx
      .update(scheduleInviteIssuanceFences)
      .set({
        generation,
        state: "PREPARING",
        leaseExpiresAt: new Date(
          now.getTime() + SCHEDULE_INVITE_ISSUANCE_LEASE_MS,
        ),
        providerAcceptedAt: null,
        failureCode: null,
      })
      .where(eq(scheduleInviteIssuanceFences.id, fence.id));
    return { kind: "CLAIMED", generation, snapshot };
  });
}

async function markInviteProviderAccepted(
  db: ScheduleInviteDb,
  scope: InviteIssuanceScope,
  generation: number,
  acceptedAt: Date,
): Promise<boolean> {
  const result = await db
    .update(scheduleInviteIssuanceFences)
    .set({
      state: "PROVIDER_ACCEPTED",
      providerAcceptedAt: acceptedAt,
      failureCode: null,
    })
    .where(
      and(
        fenceScopeWhere(scope),
        eq(scheduleInviteIssuanceFences.generation, generation),
        eq(scheduleInviteIssuanceFences.state, "PREPARING"),
      ),
    );
  return updateAffectedRows(result) === 1;
}

async function markInviteIssuanceFailure(
  db: ScheduleInviteDb,
  input: {
    scope: InviteIssuanceScope;
    generation: number;
    failureCode:
      | "MAIL_BUILD_FAILED"
      | "PROVIDER_REJECTED"
      | "PROVIDER_EXCEPTION";
  },
): Promise<void> {
  await db
    .update(scheduleInviteIssuanceFences)
    .set({
      state: "PROVIDER_REJECTED",
      leaseExpiresAt: null,
      providerAcceptedAt: null,
      failureCode: input.failureCode,
    })
    .where(
      and(
        fenceScopeWhere(input.scope),
        eq(scheduleInviteIssuanceFences.generation, input.generation),
        eq(scheduleInviteIssuanceFences.state, "PREPARING"),
      ),
    );
}

async function markAcceptedActivationFailure(
  db: ScheduleInviteDb,
  input: {
    scope: InviteIssuanceScope;
    generation: number;
    acceptedAt: Date;
    failureCode: "ACTIVATION_REJECTED" | "ACTIVATION_EXCEPTION";
  },
): Promise<void> {
  await db
    .update(scheduleInviteIssuanceFences)
    .set({
      state: "PROVIDER_ACCEPTED_ACTIVATION_FAILED",
      leaseExpiresAt: null,
      providerAcceptedAt: input.acceptedAt,
      failureCode: input.failureCode,
    })
    .where(
      and(
        fenceScopeWhere(input.scope),
        eq(scheduleInviteIssuanceFences.generation, input.generation),
        or(
          eq(scheduleInviteIssuanceFences.state, "PREPARING"),
          eq(scheduleInviteIssuanceFences.state, "PROVIDER_ACCEPTED"),
        ),
      ),
    );
}

export const scheduleInvitesRouter = router({
  listManageableScales: protectedProcedure.query(async ({ ctx }) => {
    const actor = await getTenantActorFromContext(ctx);
    const authorized = await listAuthorizedScheduleContexts(actor);
    const scales = new Map<
      string,
      {
        hospitalId: number;
        hospitalName: string;
        sectorId: number;
        sectorName: string;
      }
    >();
    for (const context of authorized) {
      if (!context.canManage) continue;
      scales.set(`${context.hospitalId}:${context.sectorId}`, {
        hospitalId: context.hospitalId,
        hospitalName: context.hospitalName,
        sectorId: context.sectorId,
        sectorName: context.sectorName,
      });
    }
    return [...scales.values()].sort(
      (left, right) =>
        left.hospitalName.localeCompare(right.hospitalName, "pt-BR") ||
        left.sectorName.localeCompare(right.sectorName, "pt-BR"),
    );
  }),

  listActive: protectedProcedure.query(async ({ ctx }) => {
    const actor = await getTenantActorFromContext(ctx);
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const authorized = await listAuthorizedScheduleContexts(actor);
    const manageable = new Set(
      authorized
        .filter((context) => context.canManage)
        .map((context) => `${context.hospitalId}:${context.sectorId}`),
    );
    const rows = await db
      .select({
        id: scheduleInvites.id,
        hospitalId: scheduleInvites.hospitalId,
        sectorId: scheduleInvites.sectorId,
        hospitalName: hospitals.name,
        sectorName: sectors.name,
        invitedUserId: scheduleInvites.invitedUserId,
        invitedName: users.name,
        maxRedemptions: scheduleInvites.maxRedemptions,
        redeemedCount: scheduleInvites.redeemedCount,
        expiresAt: scheduleInvites.expiresAt,
        createdAt: scheduleInvites.createdAt,
      })
      .from(scheduleInvites)
      .innerJoin(
        hospitals,
        and(
          eq(hospitals.id, scheduleInvites.hospitalId),
          eq(hospitals.institutionId, scheduleInvites.institutionId),
        ),
      )
      .innerJoin(
        sectors,
        and(
          eq(sectors.id, scheduleInvites.sectorId),
          eq(sectors.institutionId, scheduleInvites.institutionId),
          eq(sectors.hospitalId, scheduleInvites.hospitalId),
        ),
      )
      .leftJoin(users, eq(users.id, scheduleInvites.invitedUserId))
      .where(
        and(
          eq(scheduleInvites.institutionId, actor.institutionId),
          isNull(scheduleInvites.revokedAt),
          isNull(scheduleInvites.declinedAt),
        ),
      );
    return rows.filter((row) =>
      manageable.has(`${row.hospitalId}:${row.sectorId}`),
    );
  }),

  listCandidates: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int().positive(),
        sectorId: z.number().int().positive(),
        name: z.string().trim().max(120).optional(),
        email: z.string().trim().max(320).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      await assertCanManageSector(actor, input.hospitalId, input.sectorId);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const contexts = await selectActiveScheduleContexts(
        db,
        actor.institutionId,
        {
          hospitalId: input.hospitalId,
          sectorId: input.sectorId,
        },
      );
      if (contexts.length !== 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            contexts.length === 0
              ? "Esta escala ainda não está aberta"
              : "Este setor possui mais de uma escala ativa; regularize a topologia.",
        });
      }

      // Fonte única de elegibilidade (mesma regra do create).
      const candidates = await selectInvitableCandidates(
        db,
        actor.institutionId,
        input.hospitalId,
        input.sectorId,
      );

      const nameNeedle = foldCandidateSearch(input.name ?? "");
      const emailNeedle = input.email?.toLowerCase().trim() ?? "";

      return candidates
        .filter((row) => {
          if (
            nameNeedle &&
            !foldCandidateSearch(row.name ?? "").includes(nameNeedle)
          ) {
            return false;
          }
          if (emailNeedle && (row.email ?? "").toLowerCase() !== emailNeedle) {
            return false;
          }
          return true;
        })
        .sort((left, right) =>
          (left.name ?? "").localeCompare(right.name ?? "", "pt-BR"),
        )
        .slice(0, 100)
        .map((row) => ({
          userId: row.userId,
          name: row.name,
          specialtyLabel: row.specialtyLabel,
        }));
    }),

  create: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int().positive(),
        sectorId: z.number().int().positive(),
        userIds: z.array(z.number().int().positive()).min(1).max(40),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      await assertCanManageSector(actor, input.hospitalId, input.sectorId);
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const contexts = await selectActiveScheduleContexts(
        db,
        actor.institutionId,
        {
          hospitalId: input.hospitalId,
          sectorId: input.sectorId,
        },
      );
      if (contexts.length !== 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            contexts.length === 0
              ? "Esta escala ainda não está aberta"
              : "Este setor possui mais de uma escala ativa; regularize a topologia.",
        });
      }

      // Mesma fonte de elegibilidade da busca (`listCandidates`): quem a busca
      // esconde — plantel de hospital irmão da MESMA instituição sem ACL no
      // hospital pedido, ou travado em outra instituição — NÃO pode ser
      // convidado direto por id. Fail-closed, resposta neutra por médico.
      const uniqueUserIds = [...new Set(input.userIds)];
      const eligibleById = new Map(
        (
          await selectInvitableCandidates(
            db,
            actor.institutionId,
            input.hospitalId,
            input.sectorId,
            uniqueUserIds,
          )
        ).map((row) => [row.userId, row] as const),
      );

      const accepted: { userId: number; name: string | null }[] = [];
      const failed: { userId: number; error: string }[] = [];
      const responseContext: {
        hospitalName: string;
        sectorName: string;
      } = {
        hospitalName: contexts[0]!.hospitalName,
        sectorName: contexts[0]!.sectorName,
      };
      // Ids pedidos que a busca esconde (hospital irmão, outra instituição,
      // já na escala, conta inválida): recusados por elegibilidade, não por
      // e-mail. Rastreados à parte para observar tentativa de convite-por-id.
      const ineligibleUserIds: number[] = [];
      let preparationUnavailable = false;

      for (const userId of uniqueUserIds) {
        const initialInvitee = eligibleById.get(userId);
        if (!initialInvitee || !initialInvitee.email) {
          ineligibleUserIds.push(userId);
          failed.push({ userId, error: "Médico não encontrado" });
          continue;
        }
        if (preparationUnavailable) {
          failed.push({
            userId,
            error:
              "O convite não pôde ser preparado com segurança. Tente novamente.",
          });
          continue;
        }

        const scope: InviteIssuanceScope = {
          institutionId: actor.institutionId,
          hospitalId: input.hospitalId,
          sectorId: input.sectorId,
          userId,
        };
        let claim: InviteIssuanceClaim;
        try {
          claim = await claimInviteIssuance(db, {
            scope,
            actor,
            expectedActorSessionVersion: ctx.user.sessionVersion,
          });
        } catch {
          // Um lote pode já ter ativado destinatários anteriores. Falha de
          // revalidação/DB deste item não apaga esse resultado parcial nem
          // transforma o lote inteiro em um sucesso sem granularidade.
          console.error("[schedule-invites] INVITE_CLAIM_FAILED");
          preparationUnavailable = true;
          failed.push({
            userId,
            error:
              "O convite não pôde ser preparado com segurança. Tente novamente.",
          });
          continue;
        }
        if (claim.kind === "INELIGIBLE") {
          ineligibleUserIds.push(userId);
          failed.push({ userId, error: "Médico não encontrado" });
          continue;
        }
        if (claim.kind === "ALREADY_ACTIVE") {
          failed.push({
            userId,
            error:
              "Já existe um convite ativo para este médico. Encerre-o antes de emitir outro.",
          });
          continue;
        }
        if (claim.kind === "IN_PROGRESS") {
          failed.push({
            userId,
            error: "Uma emissão deste convite já está em andamento. Aguarde.",
          });
          continue;
        }

        const plaintext = generateScheduleInviteCode();
        const normalized = normalizeScheduleInviteCode(plaintext);
        const formatted = formatScheduleInviteCode(normalized);
        const expiresAt = new Date(Date.now() + NAMED_TTL_MS);
        const mail = buildScheduleInviteMail({
          to: claim.snapshot.invitee.email!,
          hospitalName: claim.snapshot.context.hospitalName,
          sectorName: claim.snapshot.context.sectorName,
          code: formatted,
          expiresAt,
        });
        if (!mail) {
          try {
            await markInviteIssuanceFailure(db, {
              scope,
              generation: claim.generation,
              failureCode: "MAIL_BUILD_FAILED",
            });
          } catch {
            console.error(
              "[schedule-invites] INVITE_FAILURE_STATE_WRITE_FAILED",
            );
          }
          failed.push({
            userId,
            error: "Não foi possível montar o e-mail de convite",
          });
          continue;
        }

        let providerResult: Awaited<ReturnType<typeof mailer.sendMail>>;
        try {
          // Efeito externo fora de transação e sem conexão reservada.
          providerResult = await mailer.sendMail(mail);
        } catch {
          console.error(
            "[schedule-invites] INVITE_PROVIDER_TRANSPORT_EXCEPTION",
          );
          try {
            await markInviteIssuanceFailure(db, {
              scope,
              generation: claim.generation,
              failureCode: "PROVIDER_EXCEPTION",
            });
          } catch {
            console.error(
              "[schedule-invites] INVITE_FAILURE_STATE_WRITE_FAILED",
            );
          }
          failed.push({
            userId,
            error: "O provedor de e-mail não aceitou o convite. Tente novamente.",
          });
          continue;
        }
        // `delivered` é o nome legado do adapter; para HTTP 2xx ele significa
        // apenas aceite/enfileiramento pelo provedor, nunca entrega final.
        const providerAccepted = providerResult.delivered;
        if (!providerAccepted) {
          try {
            await markInviteIssuanceFailure(db, {
              scope,
              generation: claim.generation,
              failureCode: "PROVIDER_REJECTED",
            });
          } catch {
            console.error(
              "[schedule-invites] INVITE_FAILURE_STATE_WRITE_FAILED",
            );
          }
          failed.push({
            userId,
            error: "O provedor de e-mail não aceitou o convite. Tente novamente.",
          });
          continue;
        }

        const acceptedAt = new Date();
        let acceptanceRecorded = false;
        try {
          acceptanceRecorded = await markInviteProviderAccepted(
            db,
            scope,
            claim.generation,
            acceptedAt,
          );
        } catch {
          console.error(
            "[schedule-invites] PROVIDER_ACCEPTED_STATE_WRITE_FAILED",
          );
        }
        if (!acceptanceRecorded) {
          try {
            await markAcceptedActivationFailure(db, {
              scope,
              generation: claim.generation,
              acceptedAt,
              failureCode: "ACTIVATION_EXCEPTION",
            });
          } catch {
            console.error(
              "[schedule-invites] ACCEPTED_FAILURE_STATE_WRITE_FAILED",
            );
          }
          failed.push({
            userId,
            error:
              "O provedor aceitou a mensagem, mas o convite não foi ativado. Tente novamente em um minuto.",
          });
          continue;
        }

        let activated: InviteIssuanceSnapshot | null = null;
        let activationFailureCode:
          | "ACTIVATION_REJECTED"
          | "ACTIVATION_EXCEPTION" = "ACTIVATION_REJECTED";
        try {
          activated = await db.transaction(async (tx) => {
            // A claim concorrente também usa users → fence. Manter a mesma
            // ordem impede retry e ativação de formarem user ↔ fence.
            await lockInviteParticipantsForUpdate(
              tx,
              actor.userId,
              userId,
            );
            const [fence] = await tx
              .select({
                id: scheduleInviteIssuanceFences.id,
                generation: scheduleInviteIssuanceFences.generation,
                state: scheduleInviteIssuanceFences.state,
              })
              .from(scheduleInviteIssuanceFences)
              .where(fenceScopeWhere(scope))
              .limit(1)
              .for("update");
            if (
              !fence ||
              fence.generation !== claim.generation ||
              fence.state !== "PROVIDER_ACCEPTED"
            ) {
              return null;
            }
            if (
              process.env.NODE_ENV === "test" &&
              __scheduleInviteTestHooks.afterActivationFenceLocked
            ) {
              await __scheduleInviteTestHooks.afterActivationFenceLocked();
            }

            const current = await revalidateInviteIssuanceForUpdate(tx, {
              actor,
              expectedActorSessionVersion: ctx.user.sessionVersion,
              hospitalId: input.hospitalId,
              sectorId: input.sectorId,
              userId,
            });
            if (
              !current?.invitee.email ||
              current.invitee.professionalId !==
                claim.snapshot.invitee.professionalId ||
              current.invitee.email !== claim.snapshot.invitee.email
            ) {
              return null;
            }
            // O ator é um ponto comum a lotes paralelos. Revalidá-lo antes
            // do gap lock por destinatário evita que dez ativações mantenham
            // gaps distintos enquanto disputam a mesma linha do gestor.
            const activeInvites = await activeNamedInvitesForUpdate(
              tx,
              scope,
              new Date(),
            );
            if (activeInvites.length > 0) {
              return null;
            }

            const [inserted] = await tx
              .insert(scheduleInvites)
              .values({
                institutionId: actor.institutionId,
                hospitalId: input.hospitalId,
                sectorId: input.sectorId,
                codeHash: hashScheduleInviteCode(normalized),
                createdByUserId: actor.userId,
                invitedUserId: current.invitee.userId,
                invitedEmail: current.invitee.email,
                maxRedemptions: NAMED_MAX_REDEMPTIONS,
                expiresAt,
              })
              .$returningId();

            await recordAudit(
              {
                institutionId: actor.institutionId,
                action: "USER_UPDATED",
                entityType: "USER",
                entityId: current.invitee.userId,
                actorUserId: actor.userId,
                actorRole: actor.roleInInstitution,
                description: `Convite nominal aceito pelo provedor e ativado para a escala ${current.context.hospitalName} / ${current.context.sectorName}`,
                metadata: {
                  scheduleInviteId: inserted.id,
                  invitedUserId: current.invitee.userId,
                  hospitalId: input.hospitalId,
                  sectorId: input.sectorId,
                },
                hospitalId: input.hospitalId,
                sectorId: input.sectorId,
              },
              { db: tx, strict: true },
            );
            await tx
              .update(scheduleInviteIssuanceFences)
              .set({
                state: "ACTIVE",
                leaseExpiresAt: null,
                failureCode: null,
              })
              .where(eq(scheduleInviteIssuanceFences.id, fence.id));

            return current;
          });
        } catch {
          activationFailureCode = "ACTIVATION_EXCEPTION";
          console.error(
            "[schedule-invites] PROVIDER_ACCEPTED_ACTIVATION_FAILED",
          );
        }
        if (!activated) {
          try {
            await markAcceptedActivationFailure(db, {
              scope,
              generation: claim.generation,
              acceptedAt,
              failureCode: activationFailureCode,
            });
          } catch {
            console.error(
              "[schedule-invites] ACCEPTED_FAILURE_STATE_WRITE_FAILED",
            );
          }
          failed.push({
            userId,
            error:
              "O provedor aceitou a mensagem, mas o convite não foi ativado. Tente novamente em um minuto.",
          });
          continue;
        }

        accepted.push({
          userId: activated.invitee.userId,
          name: activated.invitee.name,
        });
      }

      if (ineligibleUserIds.length > 0) {
        // PII-free: apenas ids internos e o contexto do tenant. JSON.stringify
        // evita log-injection com valores vindos do input do usuário.
        console.warn(
          "[schedule-invites] convite recusou id(s) fora da elegibilidade da busca " +
            JSON.stringify({
              institutionId: actor.institutionId,
              hospitalId: input.hospitalId,
              sectorId: input.sectorId,
              ineligibleUserIds,
            }),
        );
      }

      return {
        accepted,
        failed,
        hospitalName: responseContext.hospitalName,
        sectorName: responseContext.sectorName,
      };
    }),

  revoke: protectedProcedure
    .input(z.object({ inviteId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [invite] = await db
        .select()
        .from(scheduleInvites)
        .where(
          and(
            eq(scheduleInvites.id, input.inviteId),
            eq(scheduleInvites.institutionId, actor.institutionId),
          ),
        )
        .limit(1);
      if (!invite) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Convite não encontrado",
        });
      }
      await assertCanManageSector(actor, invite.hospitalId, invite.sectorId);
      await db
        .update(scheduleInvites)
        .set({ revokedAt: new Date() })
        .where(eq(scheduleInvites.id, invite.id));
      return { ok: true as const };
    }),
});
