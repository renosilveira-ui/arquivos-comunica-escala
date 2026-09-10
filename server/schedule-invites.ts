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
  scheduleInviteIssuanceJournal,
  scheduleContexts,
  sectors,
  users,
} from "../drizzle/schema";
import {
  MAIL_HTTP_TIMEOUT_MS,
  mailer,
  parseProviderCorrelationId,
  type MailMessage,
} from "./mailer";
import { buildScheduleInviteMail } from "./schedule-invite-mail";
import {
  formatScheduleInviteCode,
  generateScheduleInviteOpaqueToken,
  isScheduleInviteOpaqueToken,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";
import {
  getScheduleInviteHashPolicy,
  type ScheduleInviteHashPolicy,
  type ScheduleInviteOutboxKey,
} from "./schedule-invite-code-policy";
import {
  isScheduleInviteAttemptLive,
  planScheduleInviteRecovery,
  type ScheduleInviteDeliveryState,
} from "./schedule-invite-delivery-state";
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
const SCHEDULE_INVITE_MAX_PROVIDER_ATTEMPTS = 3;

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
const SCHEDULE_INVITE_EGRESS_SETTLEMENT_MARGIN_MS = 5_000;

if (
  SCHEDULE_INVITE_ISSUANCE_LEASE_MS <=
  MAIL_HTTP_TIMEOUT_MS + SCHEDULE_INVITE_EGRESS_SETTLEMENT_MARGIN_MS
) {
  throw new Error("SCHEDULE_INVITE_LEASE_TOO_SHORT_FOR_MAIL_EGRESS");
}

type InviteIssuanceScope = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  userId: number;
};

function logInviteIssuanceFailure(
  event: string,
  scope: InviteIssuanceScope,
  generation?: number,
): void {
  // Allowlist deliberada: somente ids internos de escopo e geração. Nunca
  // passe destinatário, código, hashes, nonce, idempotency-key ou payload.
  console.error(
    `[schedule-invites] ${JSON.stringify({
      event,
      institutionId: scope.institutionId,
      hospitalId: scope.hospitalId,
      sectorId: scope.sectorId,
      invitedUserId: scope.userId,
      ...(generation === undefined ? {} : { generation }),
    })}`,
  );
}

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

function scheduleInviteCodeLookupWhere(
  normalized: string,
  policy: ScheduleInviteHashPolicy,
) {
  return or(
    ...policy.lookup(normalized).map((candidate) =>
      and(
        eq(scheduleInvites.codeHashVersion, candidate.version),
        eq(scheduleInvites.codeHash, candidate.hash),
      ),
    ),
  );
}

export async function peekScheduleInviteInstitution(
  db: InviteDb,
  code: string,
  now = new Date(),
): Promise<{ institutionId: number }> {
  const hashPolicy = getScheduleInviteHashPolicy();
  const inviteRows = await db
    .select({
      institutionId: scheduleInvites.institutionId,
      expiresAt: scheduleInvites.expiresAt,
      revokedAt: scheduleInvites.revokedAt,
      declinedAt: scheduleInvites.declinedAt,
      redeemedCount: scheduleInvites.redeemedCount,
      maxRedemptions: scheduleInvites.maxRedemptions,
    })
    .from(scheduleInvites)
    .where(scheduleInviteCodeLookupWhere(code, hashPolicy))
    .limit(2);
  const invite = inviteRows.length === 1 ? inviteRows[0] : null;
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
  const hashPolicy = getScheduleInviteHashPolicy();
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
  const inviteRows = await tx
    .select()
    .from(scheduleInvites)
    .where(scheduleInviteCodeLookupWhere(input.code, hashPolicy))
    .limit(2)
    .for("update");
  const invite = inviteRows.length === 1 ? inviteRows[0] : null;
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
  const hashPolicy = getScheduleInviteHashPolicy();
  const inviteRows = await tx
    .select()
    .from(scheduleInvites)
    .where(scheduleInviteCodeLookupWhere(input.code, hashPolicy))
    .limit(2)
    .for("update");
  const invite = inviteRows.length === 1 ? inviteRows[0] : null;
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

type InviteIssuanceMaterial = {
  generation: number;
  leaseToken: string;
  attemptExpiresAt: Date;
  codeNonce: string;
  codePepperKeyId: string;
  recipientBindingHash: string;
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
  providerAcceptedAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
};

type InviteIssuanceClaim =
  | {
      kind: "DELIVER";
      material: InviteIssuanceMaterial;
      snapshot: InviteIssuanceSnapshot;
      mail: MailMessage;
    }
  | {
      kind: "ACTIVATE";
      material: InviteIssuanceMaterial;
      snapshot: InviteIssuanceSnapshot;
    }
  | { kind: "INELIGIBLE" }
  | { kind: "ALREADY_ACTIVE" }
  | { kind: "IN_PROGRESS" }
  | { kind: "KEY_UNAVAILABLE" }
  | { kind: "TERMINAL_FAILURE" }
  | { kind: "DELIVERY_REQUEST_UNAVAILABLE" }
  | { kind: "DELIVERY_REQUEST_MISMATCH" };

type InviteIssuanceJournalEvent =
  | "CLAIMED"
  | "ATTEMPT_SUPERSEDED"
  | "DELIVERY_RECLAIMED"
  | "PROVIDER_ACCEPTED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNKNOWN"
  | "ACTIVATION_RESUMED"
  | "ACTIVATED"
  | "ACTIVATION_FAILED";

async function appendInviteIssuanceJournal(
  tx: InviteIssuanceDb,
  input: {
    scope: InviteIssuanceScope;
    generation: number;
    event: InviteIssuanceJournalEvent;
    reasonCode?: string;
    providerCorrelationId?: string;
    scheduleInviteId?: number;
  },
): Promise<void> {
  await tx.insert(scheduleInviteIssuanceJournal).values({
    institutionId: input.scope.institutionId,
    hospitalId: input.scope.hospitalId,
    sectorId: input.scope.sectorId,
    invitedUserId: input.scope.userId,
    generation: input.generation,
    event: input.event,
    reasonCode: input.reasonCode,
    providerCorrelationId: input.providerCorrelationId,
    scheduleInviteId: input.scheduleInviteId,
  });
}

function materialFromFence(fence: {
  generation: number;
  leaseToken: string | null;
  attemptExpiresAt: Date | null;
  codeNonce: string | null;
  codePepperKeyId: string | null;
  recipientBindingHash: string | null;
  providerIdempotencyKey: string | null;
  providerRequestFingerprint: string | null;
  providerAcceptedAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
}): InviteIssuanceMaterial | null {
  if (
    !Number.isSafeInteger(fence.generation) ||
    fence.generation <= 0 ||
    !isScheduleInviteOpaqueToken(fence.leaseToken) ||
    !fence.attemptExpiresAt ||
    !Number.isFinite(fence.attemptExpiresAt.getTime()) ||
    !isScheduleInviteOpaqueToken(fence.codeNonce) ||
    !isScheduleInviteOpaqueToken(fence.codePepperKeyId) ||
    !isScheduleInviteOpaqueToken(fence.recipientBindingHash) ||
    !isScheduleInviteOpaqueToken(fence.providerIdempotencyKey) ||
    !isScheduleInviteOpaqueToken(fence.providerRequestFingerprint) ||
    !Number.isSafeInteger(fence.attemptCount) ||
    !Number.isSafeInteger(fence.maxAttempts) ||
    fence.attemptCount < 1 ||
    fence.maxAttempts < 1 ||
    fence.maxAttempts > 5 ||
    fence.attemptCount > fence.maxAttempts
  ) {
    return null;
  }
  return {
    generation: fence.generation,
    leaseToken: fence.leaseToken,
    attemptExpiresAt: fence.attemptExpiresAt,
    codeNonce: fence.codeNonce,
    codePepperKeyId: fence.codePepperKeyId,
    recipientBindingHash: fence.recipientBindingHash,
    providerIdempotencyKey: fence.providerIdempotencyKey,
    providerRequestFingerprint: fence.providerRequestFingerprint!,
    providerAcceptedAt: fence.providerAcceptedAt,
    attemptCount: fence.attemptCount,
    maxAttempts: fence.maxAttempts,
  };
}

function isTerminalMailRejection(reason: string): boolean {
  return reason === "INVALID_IDEMPOTENCY_KEY";
}

function buildInviteProviderMail(input: {
  scope: InviteIssuanceScope;
  snapshot: InviteIssuanceSnapshot;
  generation: number;
  codeNonce: string;
  attemptExpiresAt: Date;
  outboxKey: ScheduleInviteOutboxKey;
}): MailMessage | null {
  const formatted = input.outboxKey.deriveCode({
    institutionId: input.scope.institutionId,
    hospitalId: input.scope.hospitalId,
    sectorId: input.scope.sectorId,
    invitedUserId: input.scope.userId,
    generation: input.generation,
    nonce: input.codeNonce,
  });
  return buildScheduleInviteMail({
    to: input.snapshot.invitee.email!,
    hospitalName: input.snapshot.context.hospitalName,
    sectorName: input.snapshot.context.sectorName,
    code: formatScheduleInviteCode(normalizeScheduleInviteCode(formatted)),
    expiresAt: input.attemptExpiresAt,
  });
}

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
 * faz a serialização entre processos/instâncias. O request é montado apenas
 * para persistir seu fingerprint na mesma transação; o commit sempre acontece
 * antes do egress, portanto nenhuma conexão acompanha a latência do provedor.
 */
async function claimInviteIssuance(
  db: ScheduleInviteDb,
  input: {
    scope: InviteIssuanceScope;
    actor: TenantActor;
    expectedActorSessionVersion: number;
    hashPolicy: ScheduleInviteHashPolicy;
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
        leaseToken: scheduleInviteIssuanceFences.leaseToken,
        leaseExpiresAt: scheduleInviteIssuanceFences.leaseExpiresAt,
        attemptExpiresAt: scheduleInviteIssuanceFences.attemptExpiresAt,
        codeNonce: scheduleInviteIssuanceFences.codeNonce,
        codePepperKeyId: scheduleInviteIssuanceFences.codePepperKeyId,
        recipientBindingHash:
          scheduleInviteIssuanceFences.recipientBindingHash,
        providerIdempotencyKey:
          scheduleInviteIssuanceFences.providerIdempotencyKey,
        providerRequestFingerprint:
          scheduleInviteIssuanceFences.providerRequestFingerprint,
        providerAcceptedAt: scheduleInviteIssuanceFences.providerAcceptedAt,
        attemptCount: scheduleInviteIssuanceFences.attemptCount,
        maxAttempts: scheduleInviteIssuanceFences.maxAttempts,
        terminalFailure: scheduleInviteIssuanceFences.terminalFailure,
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

    const existingKey = fence.codePepperKeyId
      ? input.hashPolicy.outbox.resolve(fence.codePepperKeyId)
      : null;
    const attemptIsLive = Boolean(
      fence.attemptExpiresAt &&
      isScheduleInviteAttemptLive(fence.attemptExpiresAt, now),
    );
    // Sem a chave da geração existente não é possível sequer decidir se o
    // destinatário permaneceu o mesmo. Falhar aqui impede que UNKNOWN seja
    // convertido acidentalmente em recipient mismatch / nova geração.
    if (fence.generation > 0 && attemptIsLive && !existingKey) {
      return { kind: "KEY_UNAVAILABLE" };
    }
    const recipientMatches = existingKey
      ? Boolean(
          fence.recipientBindingHash &&
          existingKey.bindRecipient(snapshot.invitee.email) ===
            fence.recipientBindingHash,
        )
      : null;
    const recovery = planScheduleInviteRecovery({
      state: fence.state as ScheduleInviteDeliveryState,
      now,
      leaseExpiresAt: fence.leaseExpiresAt,
      attemptExpiresAt: fence.attemptExpiresAt,
      recipientMatches,
      pepperKeyAvailable: Boolean(existingKey),
      attemptCount: fence.attemptCount,
      maxAttempts: fence.maxAttempts,
      terminalFailure: fence.terminalFailure,
    });
    if (recovery.kind === "WAIT") return { kind: "IN_PROGRESS" };
    if (recovery.kind === "FAIL_CLOSED") {
      return { kind: "KEY_UNAVAILABLE" };
    }
    if (recovery.kind === "TERMINAL_FAILURE") {
      if (!fence.terminalFailure) {
        const poisoned = await tx
          .update(scheduleInviteIssuanceFences)
          .set({
            state: "PROVIDER_REJECTED",
            leaseToken: null,
            leaseExpiresAt: null,
            providerAcceptedAt: null,
            providerCorrelationId: null,
            failureCode: "UNKNOWN_RETRY_LIMIT_REACHED",
            terminalFailure: true,
          })
          .where(
            and(
              eq(scheduleInviteIssuanceFences.id, fence.id),
              eq(scheduleInviteIssuanceFences.generation, fence.generation),
            ),
          );
        if (updateAffectedRows(poisoned) !== 1) {
          throw new Error("SCHEDULE_INVITE_TERMINAL_CAS_LOST");
        }
        await appendInviteIssuanceJournal(tx, {
          scope: input.scope,
          generation: fence.generation,
          event: "PROVIDER_REJECTED",
          reasonCode: "UNKNOWN_RETRY_LIMIT_REACHED",
        });
      }
      return { kind: "TERMINAL_FAILURE" };
    }

    if (recovery.kind === "REPLAY_DELIVERY") {
      const persistedMaterial = materialFromFence(fence);
      if (!persistedMaterial || !existingKey) {
        return { kind: "DELIVERY_REQUEST_MISMATCH" };
      }
      const mail = buildInviteProviderMail({
        scope: input.scope,
        snapshot,
        generation: persistedMaterial.generation,
        codeNonce: persistedMaterial.codeNonce,
        attemptExpiresAt: persistedMaterial.attemptExpiresAt,
        outboxKey: existingKey,
      });
      if (
        !mail ||
        existingKey.fingerprintProviderRequest(mail) !==
          persistedMaterial.providerRequestFingerprint
      ) {
        // Nome, destinatário, APP_PUBLIC_URL, MAIL_FROM ou template mudou.
        // A chave antiga não pode sair com um request reconstruído diferente.
        return { kind: "DELIVERY_REQUEST_MISMATCH" };
      }
      const leaseToken = generateScheduleInviteOpaqueToken();
      const leaseExpiresAt = new Date(
        now.getTime() + SCHEDULE_INVITE_ISSUANCE_LEASE_MS,
      );
      await tx
        .update(scheduleInviteIssuanceFences)
        .set({
          state: "PREPARING",
          leaseToken,
          leaseExpiresAt,
          failureCode: null,
          attemptCount: persistedMaterial.attemptCount + 1,
        })
        .where(
          and(
            eq(scheduleInviteIssuanceFences.id, fence.id),
            eq(scheduleInviteIssuanceFences.generation, fence.generation),
          ),
        );
      await appendInviteIssuanceJournal(tx, {
        scope: input.scope,
        generation: fence.generation,
        event: "DELIVERY_RECLAIMED",
      });
      return {
        kind: "DELIVER",
        material: {
          ...persistedMaterial,
          leaseToken,
          attemptCount: persistedMaterial.attemptCount + 1,
        },
        snapshot,
        mail,
      };
    }

    if (recovery.kind === "RESUME_ACTIVATION") {
      const leaseToken = generateScheduleInviteOpaqueToken();
      const leaseExpiresAt = new Date(
        now.getTime() + SCHEDULE_INVITE_ISSUANCE_LEASE_MS,
      );
      await tx
        .update(scheduleInviteIssuanceFences)
        .set({
          state: "PROVIDER_ACCEPTED",
          leaseToken,
          leaseExpiresAt,
          failureCode: null,
        })
        .where(
          and(
            eq(scheduleInviteIssuanceFences.id, fence.id),
            eq(scheduleInviteIssuanceFences.generation, fence.generation),
          ),
        );
      await appendInviteIssuanceJournal(tx, {
        scope: input.scope,
        generation: fence.generation,
        event: "ACTIVATION_RESUMED",
      });
      const material = materialFromFence({ ...fence, leaseToken });
      if (!material) throw new Error("SCHEDULE_INVITE_MATERIAL_INVALID");
      return { kind: "ACTIVATE", material, snapshot };
    }

    const supersededReasonCode =
      recovery.supersedesUncertainGeneration && fence.generation > 0
        ? recipientMatches === false
          ? "RECIPIENT_CHANGED"
          : fence.attemptExpiresAt &&
              !isScheduleInviteAttemptLive(fence.attemptExpiresAt, now)
            ? "ATTEMPT_EXPIRED"
            : "PROVIDER_OUTCOME_UNCERTAIN"
        : null;

    const generation = fence.generation + 1;
    const leaseToken = generateScheduleInviteOpaqueToken();
    const codeNonce = generateScheduleInviteOpaqueToken();
    const providerIdempotencyKey = generateScheduleInviteOpaqueToken();
    const currentKey = input.hashPolicy.outbox.current;
    const attemptExpiresAt = new Date(now.getTime() + NAMED_TTL_MS);
    const recipientBindingHash = currentKey.bindRecipient(
      snapshot.invitee.email,
    );
    const mail = buildInviteProviderMail({
      scope: input.scope,
      snapshot,
      generation,
      codeNonce,
      attemptExpiresAt,
      outboxKey: currentKey,
    });
    if (!mail) return { kind: "DELIVERY_REQUEST_UNAVAILABLE" };
    const providerRequestFingerprint =
      currentKey.fingerprintProviderRequest(mail);
    await tx
      .update(scheduleInviteIssuanceFences)
      .set({
        generation,
        state: "PREPARING",
        leaseToken,
        leaseExpiresAt: new Date(
          now.getTime() + SCHEDULE_INVITE_ISSUANCE_LEASE_MS,
        ),
        attemptExpiresAt,
        codeNonce,
        codePepperKeyId: currentKey.keyId,
        recipientBindingHash,
        providerIdempotencyKey,
        providerRequestFingerprint,
        providerCorrelationId: null,
        providerAcceptedAt: null,
        scheduleInviteId: null,
        failureCode: null,
        terminalFailure: false,
        attemptCount: 1,
        maxAttempts: SCHEDULE_INVITE_MAX_PROVIDER_ATTEMPTS,
      })
      .where(
        and(
          eq(scheduleInviteIssuanceFences.id, fence.id),
          eq(scheduleInviteIssuanceFences.generation, fence.generation),
        ),
      );
    if (supersededReasonCode) {
      await appendInviteIssuanceJournal(tx, {
        scope: input.scope,
        generation: fence.generation,
        event: "ATTEMPT_SUPERSEDED",
        reasonCode: supersededReasonCode,
      });
    }
    await appendInviteIssuanceJournal(tx, {
      scope: input.scope,
      generation,
      event: "CLAIMED",
    });
    return {
      kind: "DELIVER",
      material: {
        generation,
        leaseToken,
        attemptExpiresAt,
        codeNonce,
        codePepperKeyId: currentKey.keyId,
        recipientBindingHash,
        providerIdempotencyKey,
        providerRequestFingerprint,
        providerAcceptedAt: null,
        attemptCount: 1,
        maxAttempts: SCHEDULE_INVITE_MAX_PROVIDER_ATTEMPTS,
      },
      snapshot,
      mail,
    };
  });
}

async function markInviteProviderAccepted(
  db: ScheduleInviteDb,
  input: {
    scope: InviteIssuanceScope;
    material: InviteIssuanceMaterial;
    acceptedAt: Date;
    providerCorrelationId?: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx
      .update(scheduleInviteIssuanceFences)
      .set({
        state: "PROVIDER_ACCEPTED",
        providerAcceptedAt: input.acceptedAt,
        providerCorrelationId: input.providerCorrelationId,
        failureCode: null,
        terminalFailure: false,
      })
      .where(
        and(
          fenceScopeWhere(input.scope),
          eq(
            scheduleInviteIssuanceFences.generation,
            input.material.generation,
          ),
          eq(
            scheduleInviteIssuanceFences.leaseToken,
            input.material.leaseToken,
          ),
          eq(scheduleInviteIssuanceFences.state, "PREPARING"),
        ),
      );
    if (updateAffectedRows(result) !== 1) return false;
    await appendInviteIssuanceJournal(tx, {
      scope: input.scope,
      generation: input.material.generation,
      event: "PROVIDER_ACCEPTED",
      providerCorrelationId: input.providerCorrelationId,
    });
    return true;
  });
}

async function markInviteProviderOutcome(
  db: ScheduleInviteDb,
  input: {
    scope: InviteIssuanceScope;
    material: InviteIssuanceMaterial;
    outcome: "REJECTED" | "UNKNOWN";
    reasonCode: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const isUnknown = input.outcome === "UNKNOWN";
    const retryLimitReached =
      isUnknown && input.material.attemptCount >= input.material.maxAttempts;
    const terminalFailure =
      retryLimitReached ||
      (!isUnknown && isTerminalMailRejection(input.reasonCode));
    const terminalReason = retryLimitReached
      ? "UNKNOWN_RETRY_LIMIT_REACHED"
      : input.reasonCode;
    const result = await tx
      .update(scheduleInviteIssuanceFences)
      .set({
        state: isUnknown && !terminalFailure
          ? "PROVIDER_UNKNOWN"
          : "PROVIDER_REJECTED",
        leaseToken: isUnknown && !terminalFailure
          ? input.material.leaseToken
          : null,
        leaseExpiresAt: isUnknown && !terminalFailure
          ? new Date(Date.now() + SCHEDULE_INVITE_ISSUANCE_LEASE_MS)
          : null,
        providerAcceptedAt: null,
        providerCorrelationId: null,
        failureCode: terminalReason,
        terminalFailure,
      })
      .where(
        and(
          fenceScopeWhere(input.scope),
          eq(
            scheduleInviteIssuanceFences.generation,
            input.material.generation,
          ),
          eq(
            scheduleInviteIssuanceFences.leaseToken,
            input.material.leaseToken,
          ),
          eq(scheduleInviteIssuanceFences.state, "PREPARING"),
        ),
      );
    if (updateAffectedRows(result) !== 1) return false;
    if (isUnknown) {
      await appendInviteIssuanceJournal(tx, {
        scope: input.scope,
        generation: input.material.generation,
        event: "PROVIDER_UNKNOWN",
        reasonCode: input.reasonCode,
      });
    }
    if (!isUnknown || terminalFailure) {
      await appendInviteIssuanceJournal(tx, {
        scope: input.scope,
        generation: input.material.generation,
        event: "PROVIDER_REJECTED",
        reasonCode: terminalReason,
      });
    }
    return true;
  });
}

async function markAcceptedActivationFailure(
  db: ScheduleInviteDb,
  input: {
    scope: InviteIssuanceScope;
    material: InviteIssuanceMaterial;
    acceptedAt: Date;
    failureCode:
      "ACTIVATION_REJECTED" | "ACTIVATION_EXCEPTION" | "ACTIVATION_EXPIRED";
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx
      .update(scheduleInviteIssuanceFences)
      .set({
        state: "PROVIDER_ACCEPTED_ACTIVATION_FAILED",
        leaseToken: null,
        leaseExpiresAt: null,
        providerAcceptedAt: input.acceptedAt,
        failureCode: input.failureCode,
        terminalFailure: false,
      })
      .where(
        and(
          fenceScopeWhere(input.scope),
          eq(
            scheduleInviteIssuanceFences.generation,
            input.material.generation,
          ),
          eq(
            scheduleInviteIssuanceFences.leaseToken,
            input.material.leaseToken,
          ),
          eq(scheduleInviteIssuanceFences.state, "PROVIDER_ACCEPTED"),
        ),
      );
    if (updateAffectedRows(result) !== 1) return false;
    await appendInviteIssuanceJournal(tx, {
      scope: input.scope,
      generation: input.material.generation,
      event: "ACTIVATION_FAILED",
      reasonCode: input.failureCode,
    });
    return true;
  });
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
      // Carregado antes de qualquer claim ou efeito externo. Ausência,
      // reutilização ou fraqueza do pepper bloqueia só esta operação.
      const hashPolicy = getScheduleInviteHashPolicy();
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
            hashPolicy,
          });
        } catch {
          // Um lote pode já ter ativado destinatários anteriores. Falha de
          // revalidação/DB deste item não apaga esse resultado parcial nem
          // transforma o lote inteiro em um sucesso sem granularidade.
          logInviteIssuanceFailure("INVITE_CLAIM_FAILED", scope);
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
        if (claim.kind === "KEY_UNAVAILABLE") {
          failed.push({
            userId,
            error:
              "A chave desta emissão ainda não está disponível. Preserve o pepper anterior e tente novamente.",
          });
          continue;
        }
        if (claim.kind === "TERMINAL_FAILURE") {
          failed.push({
            userId,
            error:
              "Esta emissão foi encerrada após atingir o limite seguro de tentativas. Solicite revisão operacional antes de reenviar.",
          });
          continue;
        }
        if (claim.kind === "DELIVERY_REQUEST_UNAVAILABLE") {
          failed.push({
            userId,
            error: "Não foi possível montar o e-mail de convite",
          });
          continue;
        }
        if (claim.kind === "DELIVERY_REQUEST_MISMATCH") {
          failed.push({
            userId,
            error:
              "O conteúdo desta emissão mudou desde a primeira tentativa. Restaure a configuração anterior ou encerre a tentativa com segurança.",
          });
          continue;
        }

        const outboxKey = hashPolicy.outbox.resolve(
          claim.material.codePepperKeyId,
        );
        if (!outboxKey) {
          failed.push({
            userId,
            error:
              "A chave desta emissão ainda não está disponível. Preserve o pepper anterior e tente novamente.",
          });
          continue;
        }
        const formatted = outboxKey.deriveCode({
          institutionId: scope.institutionId,
          hospitalId: scope.hospitalId,
          sectorId: scope.sectorId,
          invitedUserId: scope.userId,
          generation: claim.material.generation,
          nonce: claim.material.codeNonce,
        });
        const normalized = normalizeScheduleInviteCode(formatted);
        const expiresAt = claim.material.attemptExpiresAt;
        let acceptedAt = claim.material.providerAcceptedAt;

        if (claim.kind === "DELIVER") {
          let providerResult: Awaited<ReturnType<typeof mailer.sendMail>>;
          try {
            // Última barreira local antes do efeito externo: além do TTL, o
            // request completo deve continuar igual ao fingerprint persistido
            // antes do claim. Isso inclui MAIL_FROM; URL, nomes e destinatário
            // já estão congelados no próprio objeto retornado pela transação.
            if (!isScheduleInviteAttemptLive(expiresAt, new Date())) {
              try {
                await markInviteProviderOutcome(db, {
                  scope,
                  material: claim.material,
                  outcome: "REJECTED",
                  reasonCode: "ATTEMPT_EXPIRED_BEFORE_EGRESS",
                });
              } catch {
                logInviteIssuanceFailure(
                  "INVITE_OUTCOME_WRITE_FAILED",
                  scope,
                  claim.material.generation,
                );
              }
              failed.push({
                userId,
                error: "O convite expirou antes do envio. Tente novamente.",
              });
              continue;
            }
            if (
              outboxKey.fingerprintProviderRequest(claim.mail) !==
              claim.material.providerRequestFingerprint
            ) {
              try {
                await markInviteProviderOutcome(db, {
                  scope,
                  material: claim.material,
                  outcome: "REJECTED",
                  reasonCode: "PROVIDER_REQUEST_CHANGED_BEFORE_EGRESS",
                });
              } catch {
                logInviteIssuanceFailure(
                  "INVITE_OUTCOME_WRITE_FAILED",
                  scope,
                  claim.material.generation,
                );
              }
              failed.push({
                userId,
                error:
                  "A configuração do e-mail mudou antes do envio. Tente novamente.",
              });
              continue;
            }
            if (
              !isScheduleInviteOpaqueToken(
                claim.material.providerIdempotencyKey,
              )
            ) {
              try {
                await markInviteProviderOutcome(db, {
                  scope,
                  material: claim.material,
                  outcome: "REJECTED",
                  reasonCode: "INVALID_IDEMPOTENCY_KEY",
                });
              } catch {
                logInviteIssuanceFailure(
                  "INVITE_OUTCOME_WRITE_FAILED",
                  scope,
                  claim.material.generation,
                );
              }
              failed.push({
                userId,
                error:
                  "A emissão contém material inválido e foi encerrada com segurança.",
              });
              continue;
            }
            providerResult = await mailer.sendMail(claim.mail, {
              idempotencyKey: claim.material.providerIdempotencyKey,
            });
          } catch {
            const exhaustedUnknown =
              claim.material.attemptCount >= claim.material.maxAttempts;
            logInviteIssuanceFailure(
              "INVITE_PROVIDER_TRANSPORT_UNKNOWN",
              scope,
              claim.material.generation,
            );
            try {
              await markInviteProviderOutcome(db, {
                scope,
                material: claim.material,
                outcome: "UNKNOWN",
                reasonCode: "TRANSPORT_EXCEPTION",
              });
            } catch {
              logInviteIssuanceFailure(
                "INVITE_OUTCOME_WRITE_FAILED",
                scope,
                claim.material.generation,
              );
            }
            failed.push({
              userId,
              error:
                exhaustedUnknown
                  ? "A emissão foi encerrada após atingir o limite seguro sem confirmação do provedor. Solicite revisão operacional."
                  : "O resultado do envio ainda é incerto. Aguarde um minuto antes de tentar novamente.",
            });
            continue;
          }
          if (providerResult.kind !== "ACCEPTED") {
            const exhaustedUnknown =
              providerResult.kind === "UNKNOWN" &&
              claim.material.attemptCount >= claim.material.maxAttempts;
            const terminalRejection =
              providerResult.kind === "REJECTED" &&
              isTerminalMailRejection(providerResult.reason);
            try {
              await markInviteProviderOutcome(db, {
                scope,
                material: claim.material,
                outcome: providerResult.kind,
                reasonCode: providerResult.reason,
              });
            } catch {
              logInviteIssuanceFailure(
                "INVITE_OUTCOME_WRITE_FAILED",
                scope,
                claim.material.generation,
              );
            }
            failed.push({
              userId,
              error:
                providerResult.kind === "UNKNOWN"
                  ? exhaustedUnknown
                    ? "A emissão foi encerrada após atingir o limite seguro sem confirmação do provedor. Solicite revisão operacional."
                    : "O resultado do envio ainda é incerto. Aguarde um minuto antes de tentar novamente."
                  : terminalRejection
                    ? "A emissão contém uma chave inválida e foi encerrada com segurança. Solicite revisão operacional."
                    : "O provedor de e-mail rejeitou o convite. Tente novamente.",
            });
            continue;
          }

          acceptedAt = new Date();
          let acceptanceRecorded = false;
          try {
            acceptanceRecorded = await markInviteProviderAccepted(db, {
              scope,
              material: claim.material,
              acceptedAt,
              providerCorrelationId:
                parseProviderCorrelationId(
                  providerResult.providerCorrelationId,
                ),
            });
          } catch {
            logInviteIssuanceFailure(
              "PROVIDER_ACCEPTED_STATE_WRITE_UNKNOWN",
              scope,
              claim.material.generation,
            );
          }
          if (!acceptanceRecorded) {
            failed.push({
              userId,
              error:
                "O provedor aceitou a mensagem, mas o registro local ficou incerto. Aguarde um minuto antes de tentar novamente.",
            });
            continue;
          }
        }

        if (!acceptedAt) {
          logInviteIssuanceFailure(
            "ACCEPTED_GENERATION_WITHOUT_TIMESTAMP",
            scope,
            claim.material.generation,
          );
          failed.push({
            userId,
            error: "A emissão não pôde ser retomada com segurança.",
          });
          continue;
        }

        let activated: InviteIssuanceSnapshot | null = null;
        let activationFailureCode:
          | "ACTIVATION_REJECTED"
          | "ACTIVATION_EXCEPTION"
          | "ACTIVATION_EXPIRED" = "ACTIVATION_REJECTED";
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
                leaseToken: scheduleInviteIssuanceFences.leaseToken,
              })
              .from(scheduleInviteIssuanceFences)
              .where(fenceScopeWhere(scope))
              .limit(1)
              .for("update");
            if (
              !fence ||
              fence.generation !== claim.material.generation ||
              fence.leaseToken !== claim.material.leaseToken ||
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

            // Revalidar dentro da transação, junto ao INSERT, impede que uma
            // aceitação lenta do provedor ative material que já venceu.
            if (!isScheduleInviteAttemptLive(expiresAt, new Date())) {
              activationFailureCode = "ACTIVATION_EXPIRED";
              return null;
            }

            const [inserted] = await tx
              .insert(scheduleInvites)
              .values({
                institutionId: actor.institutionId,
                hospitalId: input.hospitalId,
                sectorId: input.sectorId,
                codeHash: outboxKey.hash(normalized),
                codeHashVersion: hashPolicy.write.version,
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
            const activatedFence = await tx
              .update(scheduleInviteIssuanceFences)
              .set({
                state: "ACTIVE",
                leaseToken: null,
                leaseExpiresAt: null,
                scheduleInviteId: inserted.id,
                failureCode: null,
              })
              .where(
                and(
                  eq(scheduleInviteIssuanceFences.id, fence.id),
                  eq(
                    scheduleInviteIssuanceFences.generation,
                    claim.material.generation,
                  ),
                  eq(
                    scheduleInviteIssuanceFences.leaseToken,
                    claim.material.leaseToken,
                  ),
                  eq(scheduleInviteIssuanceFences.state, "PROVIDER_ACCEPTED"),
                ),
              );
            if (updateAffectedRows(activatedFence) !== 1) {
              throw new Error("SCHEDULE_INVITE_ACTIVATION_CAS_LOST");
            }
            await appendInviteIssuanceJournal(tx, {
              scope,
              generation: claim.material.generation,
              event: "ACTIVATED",
              scheduleInviteId: inserted.id,
            });

            return current;
          });
        } catch {
          activationFailureCode = "ACTIVATION_EXCEPTION";
          logInviteIssuanceFailure(
            "PROVIDER_ACCEPTED_ACTIVATION_FAILED",
            scope,
            claim.material.generation,
          );
        }
        if (!activated) {
          try {
            await markAcceptedActivationFailure(db, {
              scope,
              material: claim.material,
              acceptedAt,
              failureCode: activationFailureCode,
            });
          } catch {
            logInviteIssuanceFailure(
              "ACCEPTED_FAILURE_STATE_WRITE_FAILED",
              scope,
              claim.material.generation,
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
