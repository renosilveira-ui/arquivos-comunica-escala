import { and, eq, gt, inArray, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  hospitals,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleInvites,
  sectors,
  type ScheduleInvite,
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
  recordScheduleInviteAcceptedInTransaction,
  recordScheduleInviteCreatedInTransaction,
  recordScheduleInviteRevokedInTransaction,
  type ScheduleInviteOperationalActor,
  type ScheduleInviteOperationalSnapshot,
} from "./schedule-invite-operational-events";
import type { OperationalEventTx } from "./operational-events";
import {
  listAuthorizedScheduleContexts,
  qualificationMatches,
  selectActiveScheduleContexts,
  type ProfessionalQualification,
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
type InviteTx = OperationalEventTx;

function operationalActorFromTenant(
  actor: TenantActor,
): ScheduleInviteOperationalActor {
  return {
    kind: "USER",
    userId: actor.userId,
    professionalId: actor.professionalId,
    role: actor.roleInInstitution,
  };
}

function inviteOperationalSnapshot(input: {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  operationalRevision: number;
  createdByUserId: number;
  invitedUserId: number | null;
}): ScheduleInviteOperationalSnapshot {
  return {
    id: input.id,
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    sectorId: input.sectorId,
    operationalRevision: input.operationalRevision,
    createdByUserId: input.createdByUserId,
    invitedUserId: input.invitedUserId,
  };
}

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
  tx: InviteTx,
  input: {
    code: string;
    userId: number;
    professionalId: number;
    qualification: ProfessionalQualification;
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
  // Aceite e criação concorrente podem tocar o mesmo convidado. Primeiro
  // identificamos o convite sem lock, depois travamos os vínculos do médico e
  // só então a linha do convite; a revalidação abaixo impede que a primeira
  // leitura autorize uma transição que tenha mudado entre os dois pontos.
  const [invitePreview] = await tx
    .select({
      id: scheduleInvites.id,
      invitedUserId: scheduleInvites.invitedUserId,
    })
    .from(scheduleInvites)
    .where(eq(scheduleInvites.codeHash, codeHash))
    .limit(1);
  if (!invitePreview) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }
  if (
    !invitePreview.invitedUserId ||
    invitePreview.invitedUserId !== input.userId
  ) {
    throw new ScheduleInviteError(
      403,
      "Este convite não foi emitido para a sua conta",
    );
  }

  const memberships = await tx
    .select({
      id: professionalInstitutions.id,
      institutionId: professionalInstitutions.institutionId,
      active: professionalInstitutions.active,
      roleInInstitution: professionalInstitutions.roleInInstitution,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, input.userId))
    .for("update");
  const [invite] = await tx
    .select()
    .from(scheduleInvites)
    .where(
      and(
        eq(scheduleInvites.id, invitePreview.id),
        eq(scheduleInvites.codeHash, codeHash),
      ),
    )
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
  const compatible = contexts.filter((context) =>
    qualificationMatches(input.qualification, context),
  );
  if (compatible.length === 0) {
    throw new ScheduleInviteError(
      409,
      "Sua especialidade não é aceita nesta escala",
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
    .set({
      redeemedCount: sql`${scheduleInvites.redeemedCount} + 1`,
      operationalRevision: sql`${scheduleInvites.operationalRevision} + 1`,
    })
    .where(
      and(
        eq(scheduleInvites.id, invite.id),
        isNull(scheduleInvites.revokedAt),
        isNull(scheduleInvites.declinedAt),
        sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
        gt(scheduleInvites.expiresAt, now),
        eq(scheduleInvites.operationalRevision, invite.operationalRevision),
      ),
    );
  if (updateAffectedRows(increment) !== 1) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
  }

  await recordScheduleInviteAcceptedInTransaction(tx, {
    snapshot: inviteOperationalSnapshot({
      ...invite,
      operationalRevision: invite.operationalRevision + 1,
    }),
    actor: {
      kind: "USER",
      userId: input.userId,
      professionalId: input.professionalId,
      role: membership?.roleInInstitution ?? "USER",
    },
    occurredAt: now,
  });

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
  tx: InviteTx,
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
      operationalRevision: sql`${scheduleInvites.operationalRevision} + 1`,
    })
    .where(
      and(
        eq(scheduleInvites.id, invite.id),
        isNull(scheduleInvites.revokedAt),
        isNull(scheduleInvites.declinedAt),
        sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
        sql`${scheduleInvites.expiresAt} > ${now}`,
        eq(scheduleInvites.operationalRevision, invite.operationalRevision),
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

function isPendingScheduleInvite(
  invite: Pick<
    ScheduleInvite,
    | "revokedAt"
    | "declinedAt"
    | "expiresAt"
    | "redeemedCount"
    | "maxRedemptions"
  >,
  now: Date,
): boolean {
  return (
    !invite.revokedAt &&
    !invite.declinedAt &&
    invite.expiresAt.getTime() > now.getTime() &&
    invite.redeemedCount < invite.maxRedemptions
  );
}

async function revokeLockedPendingScheduleInviteInTransaction(
  tx: InviteTx,
  input: {
    invite: ScheduleInvite;
    actor: ScheduleInviteOperationalActor;
    now: Date;
  },
): Promise<boolean> {
  if (!isPendingScheduleInvite(input.invite, input.now)) return false;

  const revoked = await tx
    .update(scheduleInvites)
    .set({
      revokedAt: input.now,
      operationalRevision: sql`${scheduleInvites.operationalRevision} + 1`,
    })
    .where(
      and(
        eq(scheduleInvites.id, input.invite.id),
        eq(scheduleInvites.institutionId, input.invite.institutionId),
        isNull(scheduleInvites.revokedAt),
        isNull(scheduleInvites.declinedAt),
        gt(scheduleInvites.expiresAt, input.now),
        sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
        eq(
          scheduleInvites.operationalRevision,
          input.invite.operationalRevision,
        ),
      ),
    );
  if (updateAffectedRows(revoked) !== 1) {
    throw new ScheduleInviteError(
      409,
      "O convite foi alterado por outra operação. Atualize e tente novamente.",
    );
  }

  await recordScheduleInviteRevokedInTransaction(tx, {
    snapshot: inviteOperationalSnapshot({
      ...input.invite,
      operationalRevision: input.invite.operationalRevision + 1,
    }),
    actor: input.actor,
    occurredAt: input.now,
  });
  return true;
}

export async function revokeScheduleInviteInTransaction(
  tx: InviteTx,
  input: {
    inviteId: number;
    actor: TenantActor;
    expectedActorSessionVersion: number;
    now?: Date;
  },
): Promise<{ didRevoke: boolean }> {
  const now = input.now ?? new Date();
  const [invite] = await tx
    .select()
    .from(scheduleInvites)
    .where(
      and(
        eq(scheduleInvites.id, input.inviteId),
        eq(scheduleInvites.institutionId, input.actor.institutionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!invite) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Convite não encontrado",
    });
  }

  await assertManagerScopeAccessForUpdate(
    tx,
    input.actor,
    input.expectedActorSessionVersion,
    invite.hospitalId,
    invite.sectorId,
  );
  return {
    didRevoke: await revokeLockedPendingScheduleInviteInTransaction(tx, {
      invite,
      actor: operationalActorFromTenant(input.actor),
      now,
    }),
  };
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
      const contexts = await selectActiveScheduleContexts(db, actor.institutionId, {
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
      });
      if (contexts.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Esta escala ainda não está aberta",
        });
      }

      const candidateColumns = {
        userId: users.id,
        name: users.name,
        email: users.email,
        medicalSpecialtyId: professionals.medicalSpecialtyId,
        operationalProfileCode: professionals.operationalProfileCode,
        specialtyLabel: professionals.specialty,
      };

      // Casa: já vinculados a ESTE hospital. Sala de espera: conta
      // aprovada sem vínculo ativo em lugar nenhum (conta primeiro,
      // escala depois). Não entra plantel ativo de outro hospital.
      const houseMembers = await db
        .select(candidateColumns)
        .from(users)
        .innerJoin(professionals, eq(professionals.userId, users.id))
        .innerJoin(
          professionalInstitutions,
          and(
            eq(professionalInstitutions.userId, users.id),
            eq(professionalInstitutions.institutionId, actor.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        )
        .where(and(eq(users.approvalStatus, "APPROVED"), isNull(users.deletedAt)));

      const waitingRoom = await db
        .select(candidateColumns)
        .from(users)
        .innerJoin(professionals, eq(professionals.userId, users.id))
        .where(
          and(
            eq(users.approvalStatus, "APPROVED"),
            isNull(users.deletedAt),
            notExists(
              db
                .select({ id: professionalInstitutions.id })
                .from(professionalInstitutions)
                .where(
                  and(
                    eq(professionalInstitutions.userId, users.id),
                    eq(professionalInstitutions.active, true),
                  ),
                ),
            ),
          ),
        );

      const byId = new Map<number, (typeof houseMembers)[number]>();
      for (const row of [...houseMembers, ...waitingRoom]) {
        byId.set(row.userId, row);
      }

      const candidates = [...byId.values()];
      if (candidates.length === 0) return [];

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
            eq(professionalAccess.institutionId, actor.institutionId),
            eq(professionalAccess.hospitalId, input.hospitalId),
            eq(professionalAccess.sectorId, input.sectorId),
            inArray(
              professionals.userId,
              candidates.map((row) => row.userId),
            ),
          ),
        );
      const alreadyInScale = new Set(
        access
          .filter((row) => row.canAccess)
          .map((row) => row.professionalUserId),
      );

      const memberships = await db
        .select({
          userId: professionalInstitutions.userId,
          institutionId: professionalInstitutions.institutionId,
        })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.active, true),
            inArray(
              professionalInstitutions.userId,
              candidates.map((row) => row.userId),
            ),
          ),
        );
      const inThisHouse = new Set(
        memberships
          .filter((row) => row.institutionId === actor.institutionId)
          .map((row) => row.userId),
      );
      const lockedToOtherHouse = new Set(
        memberships
          .filter(
            (row) =>
              row.institutionId !== actor.institutionId &&
              !inThisHouse.has(row.userId),
          )
          .map((row) => row.userId),
      );

      const nameNeedle = foldCandidateSearch(input.name ?? "");
      const emailNeedle = input.email?.toLowerCase().trim() ?? "";

      return candidates
        .filter((row) => {
          if (alreadyInScale.has(row.userId)) return false;
          if (lockedToOtherHouse.has(row.userId)) return false;
          if (
            nameNeedle &&
            !foldCandidateSearch(row.name ?? "").includes(nameNeedle)
          ) {
            return false;
          }
          if (emailNeedle && (row.email ?? "").toLowerCase() !== emailNeedle) {
            return false;
          }
          return contexts.some((context) =>
            qualificationMatches(
              {
                medicalSpecialtyId: row.medicalSpecialtyId,
                operationalProfileCode: row.operationalProfileCode,
              },
              context,
            ),
          );
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

      const contexts = await selectActiveScheduleContexts(db, actor.institutionId, {
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
      });
      if (contexts.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Esta escala ainda não está aberta",
        });
      }

      const uniqueUserIds = [...new Set(input.userIds)];
      const sent: { userId: number; name: string | null }[] = [];
      const failed: { userId: number; error: string }[] = [];

      for (const userId of uniqueUserIds) {
        const [invitee] = await db
          .select({
            userId: users.id,
            name: users.name,
            email: users.email,
            deletedAt: users.deletedAt,
            approvalStatus: users.approvalStatus,
            medicalSpecialtyId: professionals.medicalSpecialtyId,
            operationalProfileCode: professionals.operationalProfileCode,
          })
          .from(users)
          .innerJoin(professionals, eq(professionals.userId, users.id))
          .where(eq(users.id, userId))
          .limit(1);
        if (
          !invitee ||
          invitee.deletedAt ||
          invitee.approvalStatus !== "APPROVED" ||
          !invitee.email
        ) {
          failed.push({ userId, error: "Médico não encontrado" });
          continue;
        }
        const compatible = contexts.some((context) =>
          qualificationMatches(
            {
              medicalSpecialtyId: invitee.medicalSpecialtyId,
              operationalProfileCode: invitee.operationalProfileCode,
            },
            context,
          ),
        );
        if (!compatible) {
          failed.push({
            userId,
            error: "A especialidade não é aceita nesta escala",
          });
          continue;
        }

        const houses = await db
          .select({
            institutionId: professionalInstitutions.institutionId,
            active: professionalInstitutions.active,
          })
          .from(professionalInstitutions)
          .where(eq(professionalInstitutions.userId, userId));
        const inThisHouse = houses.some(
          (row) => row.active && row.institutionId === actor.institutionId,
        );
        const inOtherHouse = houses.some(
          (row) => row.active && row.institutionId !== actor.institutionId,
        );
        if (inOtherHouse && !inThisHouse) {
          failed.push({ userId, error: "Médico não encontrado" });
          continue;
        }

        const plaintext = generateScheduleInviteCode();
        const normalized = normalizeScheduleInviteCode(plaintext);
        const codeHash = hashScheduleInviteCode(normalized);
        const formatted = formatScheduleInviteCode(normalized);

        let created:
          | {
              inviteId: number;
              inviteeName: string | null;
              inviteeEmail: string;
              expiresAt: Date;
            }
          | undefined;
        try {
          created = await db.transaction(async (tx) => {
            const [lockedInvitee] = await tx
              .select({
                userId: users.id,
                name: users.name,
                email: users.email,
                deletedAt: users.deletedAt,
                approvalStatus: users.approvalStatus,
                medicalSpecialtyId: professionals.medicalSpecialtyId,
                operationalProfileCode: professionals.operationalProfileCode,
              })
              .from(users)
              .innerJoin(professionals, eq(professionals.userId, users.id))
              .where(eq(users.id, userId))
              .limit(1)
              .for("update");
            if (
              !lockedInvitee ||
              lockedInvitee.deletedAt ||
              lockedInvitee.approvalStatus !== "APPROVED" ||
              !lockedInvitee.email
            ) {
              throw new ScheduleInviteError(409, "Médico não encontrado");
            }

            const lockedHouses = await tx
              .select({
                institutionId: professionalInstitutions.institutionId,
                active: professionalInstitutions.active,
              })
              .from(professionalInstitutions)
              .where(eq(professionalInstitutions.userId, lockedInvitee.userId))
              .for("update");
            const stillInThisHouse = lockedHouses.some(
              (row) => row.active && row.institutionId === actor.institutionId,
            );
            const stillInOtherHouse = lockedHouses.some(
              (row) => row.active && row.institutionId !== actor.institutionId,
            );
            if (stillInOtherHouse && !stillInThisHouse) {
              throw new ScheduleInviteError(409, "Médico não encontrado");
            }

            // O precheck de escopo já ocorreu antes da transaction. Dentro
            // dela, travamos primeiro o convidado porque o aceite nominal
            // também o trava antes de validar o emissor; manter esta ordem
            // evita um ciclo emissor↔convidado entre criar e aceitar.
            await assertManagerScopeAccessForUpdate(
              tx,
              actor,
              ctx.user.sessionVersion,
              input.hospitalId,
              input.sectorId,
            );

            const now = new Date();
            const expiresAt = new Date(now.getTime() + NAMED_TTL_MS);
            // Aceite trava primeiro o convite e depois os contextos. Seguir a
            // mesma ordem aqui evita ciclo se uma nova emissão substituir um
            // convite que está sendo aceito simultaneamente.
            const previousInvites = await tx
              .select()
              .from(scheduleInvites)
              .where(
                and(
                  eq(scheduleInvites.institutionId, actor.institutionId),
                  eq(scheduleInvites.hospitalId, input.hospitalId),
                  eq(scheduleInvites.sectorId, input.sectorId),
                  eq(scheduleInvites.invitedUserId, lockedInvitee.userId),
                  isNull(scheduleInvites.revokedAt),
                  isNull(scheduleInvites.declinedAt),
                  gt(scheduleInvites.expiresAt, now),
                  sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
                ),
              )
              .for("update");

            const lockedContexts = await selectActiveScheduleContexts(
              tx,
              actor.institutionId,
              {
                hospitalId: input.hospitalId,
                sectorId: input.sectorId,
              },
              true,
            );
            if (lockedContexts.length === 0) {
              throw new ScheduleInviteError(
                409,
                "Esta escala ainda não está aberta",
              );
            }

            const [inserted] = await tx
              .insert(scheduleInvites)
              .values({
                institutionId: actor.institutionId,
                hospitalId: input.hospitalId,
                sectorId: input.sectorId,
                codeHash,
                createdByUserId: actor.userId,
                invitedUserId: lockedInvitee.userId,
                invitedEmail: lockedInvitee.email,
                maxRedemptions: NAMED_MAX_REDEMPTIONS,
                operationalRevision: 1,
                expiresAt,
              })
              .$returningId();
            if (!inserted?.id) {
              throw new Error("Convite nominal não foi persistido");
            }

            for (const previousInvite of previousInvites) {
              await revokeLockedPendingScheduleInviteInTransaction(tx, {
                invite: previousInvite,
                actor: operationalActorFromTenant(actor),
                now,
              });
            }

            await recordScheduleInviteCreatedInTransaction(tx, {
              snapshot: inviteOperationalSnapshot({
                id: inserted.id,
                institutionId: actor.institutionId,
                hospitalId: input.hospitalId,
                sectorId: input.sectorId,
                operationalRevision: 1,
                createdByUserId: actor.userId,
                invitedUserId: lockedInvitee.userId,
              }),
              actor: operationalActorFromTenant(actor),
              occurredAt: now,
            });

            return {
              inviteId: inserted.id,
              inviteeName: lockedInvitee.name,
              inviteeEmail: lockedInvitee.email,
              expiresAt,
            };
          });
        } catch (error) {
          if (error instanceof ScheduleInviteError) {
            failed.push({ userId, error: error.message });
            continue;
          }
          throw error;
        }

        const mail = buildScheduleInviteMail({
          to: created.inviteeEmail,
          hospitalName: contexts[0].hospitalName,
          sectorName: contexts[0].sectorName,
          code: formatted,
          expiresAt: created.expiresAt,
        });
        if (!mail) {
          await db.transaction(async (tx) => {
            const [lockedInvite] = await tx
              .select()
              .from(scheduleInvites)
              .where(
                and(
                  eq(scheduleInvites.id, created.inviteId),
                  eq(scheduleInvites.institutionId, actor.institutionId),
                ),
              )
              .limit(1)
              .for("update");
            if (!lockedInvite) return;
            await revokeLockedPendingScheduleInviteInTransaction(tx, {
              invite: lockedInvite,
              actor: operationalActorFromTenant(actor),
              now: new Date(),
            });
          });
          failed.push({
            userId,
            error: "Não foi possível montar o e-mail de convite",
          });
          continue;
        }

        const delivery = await mailer.sendMail(mail);
        // Console (sem RESEND_API_KEY) também vem delivered:false.
        // Não confirmar envio se o correio não entregou — o gestor via
        // "saíram por e-mail" e o médico não recebia nada.
        if (!delivery.delivered) {
          await db.transaction(async (tx) => {
            const [lockedInvite] = await tx
              .select()
              .from(scheduleInvites)
              .where(
                and(
                  eq(scheduleInvites.id, created.inviteId),
                  eq(scheduleInvites.institutionId, actor.institutionId),
                ),
              )
              .limit(1)
              .for("update");
            if (!lockedInvite) return;
            await revokeLockedPendingScheduleInviteInTransaction(tx, {
              invite: lockedInvite,
              actor: operationalActorFromTenant(actor),
              now: new Date(),
            });
          });
          failed.push({
            userId,
            error: "O e-mail de convite não saiu. Tente novamente.",
          });
          continue;
        }

        await recordAudit(
          {
            institutionId: actor.institutionId,
            action: "USER_UPDATED",
            entityType: "USER",
            entityId: userId,
            actorUserId: actor.userId,
            actorRole: actor.roleInInstitution,
            description: `Convite nominal enviado para a escala ${contexts[0].hospitalName} / ${contexts[0].sectorName}`,
            metadata: {
              scheduleInviteId: created.inviteId,
              invitedUserId: userId,
              hospitalId: input.hospitalId,
              sectorId: input.sectorId,
            },
            hospitalId: input.hospitalId,
            sectorId: input.sectorId,
          },
          { strict: true },
        );

        sent.push({ userId, name: created.inviteeName });
      }

      if (sent.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            failed[0]?.error ??
            "Nenhum convite foi enviado. Verifique os médicos selecionados.",
        });
      }

      return {
        sent,
        failed,
        hospitalName: contexts[0].hospitalName,
        sectorName: contexts[0].sectorName,
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
      await db.transaction((tx) =>
        revokeScheduleInviteInTransaction(tx, {
          inviteId: invite.id,
          actor,
          expectedActorSessionVersion: ctx.user.sessionVersion,
        }),
      );
      return { ok: true as const };
    }),
});
