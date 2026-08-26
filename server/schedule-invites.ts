import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  hospitals,
  professionalAccess,
  professionalInstitutions,
  scheduleInvites,
  sectors,
  users,
} from "../drizzle/schema";
import {
  formatScheduleInviteCode,
  generateScheduleInviteCode,
  hashScheduleInviteCode,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";
import { recordAudit } from "./audit-trail";
import { getDb } from "./db";
import {
  getTenantActorFromContext,
  type TenantActor,
} from "./_core/policy";
import {
  listAuthorizedScheduleContexts,
  qualificationMatches,
  selectActiveScheduleContexts,
  type ProfessionalQualification,
} from "./schedule-contexts";
import { protectedProcedure, router } from "./_core/trpc";

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REDEMPTIONS = 40;

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
      redeemedCount: scheduleInvites.redeemedCount,
      maxRedemptions: scheduleInvites.maxRedemptions,
    })
    .from(scheduleInvites)
    .where(eq(scheduleInvites.codeHash, codeHash))
    .limit(1);
  if (
    !invite ||
    invite.revokedAt ||
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
    qualification: ProfessionalQualification;
    now?: Date;
  },
): Promise<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  hospitalName: string;
  sectorName: string;
}> {
  const now = input.now ?? new Date();
  const codeHash = hashScheduleInviteCode(input.code);
  const [invite] = await tx
    .select()
    .from(scheduleInvites)
    .where(eq(scheduleInvites.codeHash, codeHash))
    .limit(1)
    .for("update");
  if (
    !invite ||
    invite.revokedAt ||
    invite.expiresAt.getTime() <= now.getTime() ||
    invite.redeemedCount >= invite.maxRedemptions
  ) {
    throw new ScheduleInviteError(400, "Convite inválido ou expirado");
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

  const [membership] = await tx
    .select({
      id: professionalInstitutions.id,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, input.userId),
        eq(professionalInstitutions.institutionId, invite.institutionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!membership) {
    await tx.insert(professionalInstitutions).values({
      professionalId: input.professionalId,
      userId: input.userId,
      institutionId: invite.institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
  } else if (!membership.active) {
    await tx
      .update(professionalInstitutions)
      .set({ active: true })
      .where(eq(professionalInstitutions.id, membership.id));
  }

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
        sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
      ),
    );
  const affected =
    increment && typeof increment === "object" && "affectedRows" in increment
      ? Number((increment as { affectedRows?: number }).affectedRows)
      : Array.isArray(increment)
        ? Number(
            (increment[0] as { affectedRows?: number } | undefined)
              ?.affectedRows,
          )
        : 0;
  if (affected !== 1) {
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
      .where(
        and(
          eq(scheduleInvites.institutionId, actor.institutionId),
          isNull(scheduleInvites.revokedAt),
        ),
      );
    return rows.filter((row) =>
      manageable.has(`${row.hospitalId}:${row.sectorId}`),
    );
  }),

  create: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int().positive(),
        sectorId: z.number().int().positive(),
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

      const plaintext = generateScheduleInviteCode();
      const normalized = normalizeScheduleInviteCode(plaintext);
      const codeHash = hashScheduleInviteCode(normalized);
      const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS);

      const [inserted] = await db.insert(scheduleInvites).values({
        institutionId: actor.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        codeHash,
        createdByUserId: actor.userId,
        maxRedemptions: DEFAULT_MAX_REDEMPTIONS,
        expiresAt,
      }).$returningId();

      await recordAudit(
        {
          institutionId: actor.institutionId,
          action: "USER_UPDATED",
          entityType: "USER",
          entityId: actor.userId,
          actorUserId: actor.userId,
          actorRole: actor.roleInInstitution,
          description: `Convite gerado para ${contexts[0].hospitalName} / ${contexts[0].sectorName}`,
          metadata: {
            scheduleInviteId: inserted.id,
            hospitalId: input.hospitalId,
            sectorId: input.sectorId,
          },
          hospitalId: input.hospitalId,
          sectorId: input.sectorId,
        },
        { strict: true },
      );

      return {
        id: inserted.id,
        code: formatScheduleInviteCode(normalized),
        expiresAt,
        maxRedemptions: DEFAULT_MAX_REDEMPTIONS,
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
      await db
        .update(scheduleInvites)
        .set({ revokedAt: new Date() })
        .where(eq(scheduleInvites.id, invite.id));
      return { ok: true as const };
    }),
});
