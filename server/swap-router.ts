import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import {
  swapRequests,
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  hospitals,
  sectors,
  monthlyRosters,
} from "../drizzle/schema";
import { assertNoTimeConflict } from "./shift-validations-v2";
import { recordAudit } from "./audit-trail";
import { yearMonthFromDate } from "../lib/date-utils";

// ─── helpers ────────────────────────────────────────────────────────────────

async function getProfessionalForUser(db: any, userId: number) {
  const [row] = await db
    .select({ id: professionals.id, name: professionals.name, userRole: professionals.userRole })
    .from(professionals)
    .where(eq(professionals.userId, userId));
  return row ?? null;
}

function isManager(role: string) {
  return role === "admin" || role === "manager";
}

async function assertNotLocked(db: any, institutionId: number, hospitalId: number, date: Date) {
  const ym = yearMonthFromDate(date);
  const [roster] = await db
    .select({ status: monthlyRosters.status })
    .from(monthlyRosters)
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, ym),
      ),
    );
  if (roster?.status === "LOCKED") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Escala trancada — não é possível alterar" });
  }
}

// ─── router ─────────────────────────────────────────────────────────────────

export const swapRouter = router({
  // ── offer ─────────────────────────────────────────────────────────────────
  offer: protectedProcedure
    .input(
      z.object({
        type: z.enum(["SWAP", "TRANSFER"]),
        fromShiftInstanceId: z.number(),
        fromAssignmentId: z.number(),
        toShiftInstanceId: z.number().optional(),
        reason: z.string().max(500).optional(),
        expiresInHours: z.number().min(1).max(720).default(48),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const userId = ctx.user!.id;
      const pro = await getProfessionalForUser(db, userId);
      if (!pro) throw new TRPCError({ code: "FORBIDDEN", message: "Profissional não encontrado" });

      // 1. Verify fromAssignment belongs to user
      const [fromAssign] = await db
        .select()
        .from(shiftAssignmentsV2)
        .where(
          and(
            eq(shiftAssignmentsV2.id, input.fromAssignmentId),
            eq(shiftAssignmentsV2.professionalId, pro.id),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        );
      if (!fromAssign) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Alocação não encontrada ou não pertence a você" });
      }
      if (fromAssign.shiftInstanceId !== input.fromShiftInstanceId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Assignment não corresponde ao turno informado" });
      }

      // 2. Verify shift hasn't passed
      const [fromShift] = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.id, input.fromShiftInstanceId));
      if (!fromShift) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Turno não encontrado" });
      }
      if (fromShift.startAt <= new Date()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Turno já iniciou ou passou" });
      }

      // 3. Check month not locked
      await assertNotLocked(db, fromShift.institutionId, fromShift.hospitalId, fromShift.startAt);

      // 4. SWAP-specific: verify toShiftInstance exists and is occupied by another
      if (input.type === "SWAP") {
        if (!input.toShiftInstanceId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "SWAP requer toShiftInstanceId" });
        }
        const [toShift] = await db
          .select()
          .from(shiftInstances)
          .where(eq(shiftInstances.id, input.toShiftInstanceId));
        if (!toShift) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Turno de troca não encontrado" });
        }
        if (toShift.status !== "OCUPADO") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Turno de troca não está ocupado" });
        }
      }

      // 5. Create swap request
      const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);

      const [result] = await db.insert(swapRequests).values({
        type: input.type,
        status: "PENDING",
        fromProfessionalId: pro.id,
        fromUserId: userId,
        fromShiftInstanceId: input.fromShiftInstanceId,
        fromAssignmentId: input.fromAssignmentId,
        toShiftInstanceId: input.toShiftInstanceId ?? null,
        institutionId: fromShift.institutionId,
        hospitalId: fromShift.hospitalId,
        sectorId: fromShift.sectorId,
        reason: input.reason ?? null,
        expiresAt,
      });

      const newId = (result as any).insertId as number;

      recordAudit({
        action: input.type === "SWAP" ? "SWAP_REQUESTED" : "TRANSFER_OFFERED",
        entityType: input.type === "SWAP" ? "SWAP_REQUEST" : "TRANSFER_REQUEST",
        entityId: newId,
        actorUserId: userId,
        actorRole: ctx.user!.role,
        actorName: pro.name ?? undefined,
        description: input.type === "SWAP"
          ? `Troca oferecida: turno #${input.fromShiftInstanceId} ↔ turno #${input.toShiftInstanceId}`
          : `Repasse oferecido: turno #${input.fromShiftInstanceId}`,
        fromProfessionalId: pro.id,
        fromUserId: userId,
        shiftInstanceId: input.fromShiftInstanceId,
        hospitalId: fromShift.hospitalId,
        sectorId: fromShift.sectorId ?? undefined,
        institutionId: fromShift.institutionId,
        metadata: { type: input.type, reason: input.reason },
      });

      const [created] = await db
        .select()
        .from(swapRequests)
        .where(eq(swapRequests.id, newId));

      return created;
    }),

  // ── accept ────────────────────────────────────────────────────────────────
  accept: protectedProcedure
    .input(z.object({ swapRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const userId = ctx.user!.id;
      const pro = await getProfessionalForUser(db, userId);
      if (!pro) throw new TRPCError({ code: "FORBIDDEN", message: "Profissional não encontrado" });

      const [swap] = await db
        .select()
        .from(swapRequests)
        .where(eq(swapRequests.id, input.swapRequestId));
      if (!swap) throw new TRPCError({ code: "NOT_FOUND", message: "Solicitação não encontrada" });

      if (swap.status !== "PENDING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Status atual é ${swap.status}, esperava PENDING` });
      }
      if (swap.fromUserId === userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Você não pode aceitar sua própria oferta" });
      }

      // Fetch from-shift for conflict check
      const [fromShift] = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.id, swap.fromShiftInstanceId));
      if (!fromShift) throw new TRPCError({ code: "NOT_FOUND", message: "Turno de origem não encontrado" });

      if (swap.type === "TRANSFER") {
        // Receptor wants to take the from-shift: check conflict
        await assertNoTimeConflict(userId, fromShift.startAt, fromShift.endAt);
      } else {
        // SWAP: check both sides
        // Receptor takes from-shift
        await assertNoTimeConflict(userId, fromShift.startAt, fromShift.endAt, swap.toShiftInstanceId ?? undefined);

        // Offerer takes to-shift
        if (swap.toShiftInstanceId) {
          const [toShift] = await db
            .select()
            .from(shiftInstances)
            .where(eq(shiftInstances.id, swap.toShiftInstanceId));
          if (toShift) {
            await assertNoTimeConflict(swap.fromUserId, toShift.startAt, toShift.endAt, swap.fromShiftInstanceId);
          }
        }
      }

      // For SWAP: find receptor's assignment on the to-shift
      let toAssignmentId: number | null = null;
      if (swap.type === "SWAP" && swap.toShiftInstanceId) {
        const [toAssign] = await db
          .select()
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.shiftInstanceId, swap.toShiftInstanceId),
              eq(shiftAssignmentsV2.professionalId, pro.id),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          );
        if (!toAssign) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Você não possui alocação ativa no turno de troca",
          });
        }
        toAssignmentId = toAssign.id;
      }

      await db
        .update(swapRequests)
        .set({
          status: "ACCEPTED",
          toProfessionalId: pro.id,
          toUserId: userId,
          toAssignmentId,
        })
        .where(eq(swapRequests.id, swap.id));

      recordAudit({
        action: swap.type === "SWAP" ? "SWAP_ACCEPTED" : "TRANSFER_ACCEPTED",
        entityType: swap.type === "SWAP" ? "SWAP_REQUEST" : "TRANSFER_REQUEST",
        entityId: swap.id,
        actorUserId: userId,
        actorRole: ctx.user!.role,
        actorName: pro.name ?? undefined,
        description: swap.type === "SWAP"
          ? `Troca aceita pelo profissional #${pro.id}`
          : `Repasse aceito pelo profissional #${pro.id}`,
        fromProfessionalId: swap.fromProfessionalId,
        toProfessionalId: pro.id,
        fromUserId: swap.fromUserId,
        toUserId: userId,
        shiftInstanceId: swap.fromShiftInstanceId,
        hospitalId: swap.hospitalId,
        sectorId: swap.sectorId ?? undefined,
        institutionId: swap.institutionId,
      });

      return { ok: true };
    }),

  // ── reject (by peer) ─────────────────────────────────────────────────────
  reject: protectedProcedure
    .input(z.object({ swapRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const userId = ctx.user!.id;

      const [swap] = await db
        .select()
        .from(swapRequests)
        .where(eq(swapRequests.id, input.swapRequestId));
      if (!swap) throw new TRPCError({ code: "NOT_FOUND", message: "Solicitação não encontrada" });

      if (swap.status !== "PENDING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Status atual é ${swap.status}, esperava PENDING` });
      }
      if (swap.fromUserId === userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Use 'cancelar' para cancelar sua oferta" });
      }

      await db
        .update(swapRequests)
        .set({ status: "REJECTED_BY_PEER" })
        .where(eq(swapRequests.id, swap.id));

      recordAudit({
        action: swap.type === "SWAP" ? "SWAP_REJECTED" : "TRANSFER_REJECTED",
        entityType: swap.type === "SWAP" ? "SWAP_REQUEST" : "TRANSFER_REQUEST",
        entityId: swap.id,
        actorUserId: userId,
        actorRole: ctx.user!.role,
        description: `Solicitação #${swap.id} rejeitada pelo profissional`,
        fromProfessionalId: swap.fromProfessionalId,
        fromUserId: swap.fromUserId,
        shiftInstanceId: swap.fromShiftInstanceId,
        hospitalId: swap.hospitalId,
        sectorId: swap.sectorId ?? undefined,
        institutionId: swap.institutionId,
      });

      return { ok: true };
    }),

  // ── approve (by manager) ─────────────────────────────────────────────────
  approve: protectedProcedure
    .input(
      z.object({
        swapRequestId: z.number(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const userId = ctx.user!.id;
      if (!isManager(ctx.user!.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas gestores podem aprovar" });
      }

      const [swap] = await db
        .select()
        .from(swapRequests)
        .where(eq(swapRequests.id, input.swapRequestId));
      if (!swap) throw new TRPCError({ code: "NOT_FOUND", message: "Solicitação não encontrada" });

      if (swap.status !== "ACCEPTED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Status atual é ${swap.status}, esperava ACCEPTED` });
      }
      if (!swap.toProfessionalId || !swap.toUserId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Nenhum profissional aceitou ainda" });
      }

      // Re-verify conflict (may have changed since acceptance)
      const [fromShift] = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.id, swap.fromShiftInstanceId));
      if (!fromShift) throw new TRPCError({ code: "NOT_FOUND", message: "Turno de origem não encontrado" });

      if (swap.type === "TRANSFER") {
        await assertNoTimeConflict(swap.toUserId, fromShift.startAt, fromShift.endAt);
      } else {
        // SWAP: both sides
        await assertNoTimeConflict(swap.toUserId, fromShift.startAt, fromShift.endAt, swap.toShiftInstanceId ?? undefined);
        if (swap.toShiftInstanceId) {
          const [toShift] = await db
            .select()
            .from(shiftInstances)
            .where(eq(shiftInstances.id, swap.toShiftInstanceId));
          if (toShift) {
            await assertNoTimeConflict(swap.fromUserId, toShift.startAt, toShift.endAt, swap.fromShiftInstanceId);
          }
        }
      }

      // ─── EFFECTUATE ─────────────────────────────────────────────
      if (swap.type === "TRANSFER") {
        // Deactivate old from-assignment
        await db
          .update(shiftAssignmentsV2)
          .set({ isActive: false })
          .where(eq(shiftAssignmentsV2.id, swap.fromAssignmentId));

        // Create new assignment for the recipient on from-shift
        await db.insert(shiftAssignmentsV2).values({
          shiftInstanceId: swap.fromShiftInstanceId,
          institutionId: fromShift.institutionId,
          hospitalId: fromShift.hospitalId,
          sectorId: fromShift.sectorId,
          professionalId: swap.toProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: true,
          createdBy: userId,
        });
      } else {
        // SWAP: deactivate both old, create both new
        // Deactivate from-assignment (offerer on from-shift)
        await db
          .update(shiftAssignmentsV2)
          .set({ isActive: false })
          .where(eq(shiftAssignmentsV2.id, swap.fromAssignmentId));

        // Deactivate to-assignment (receptor on to-shift)
        if (swap.toAssignmentId) {
          await db
            .update(shiftAssignmentsV2)
            .set({ isActive: false })
            .where(eq(shiftAssignmentsV2.id, swap.toAssignmentId));
        }

        // Offerer → to-shift
        if (swap.toShiftInstanceId) {
          const [toShift] = await db
            .select()
            .from(shiftInstances)
            .where(eq(shiftInstances.id, swap.toShiftInstanceId));
          if (toShift) {
            await db.insert(shiftAssignmentsV2).values({
              shiftInstanceId: swap.toShiftInstanceId,
              institutionId: toShift.institutionId,
              hospitalId: toShift.hospitalId,
              sectorId: toShift.sectorId,
              professionalId: swap.fromProfessionalId,
              assignmentType: "ON_DUTY",
              status: "OCUPADO",
              isActive: true,
              createdBy: userId,
            });
          }
        }

        // Receptor → from-shift
        await db.insert(shiftAssignmentsV2).values({
          shiftInstanceId: swap.fromShiftInstanceId,
          institutionId: fromShift.institutionId,
          hospitalId: fromShift.hospitalId,
          sectorId: fromShift.sectorId,
          professionalId: swap.toProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: true,
          createdBy: userId,
        });
      }

      // Update swap request
      await db
        .update(swapRequests)
        .set({
          status: "APPROVED",
          reviewedByUserId: userId,
          reviewedAt: new Date(),
          reviewNote: input.note ?? null,
        })
        .where(eq(swapRequests.id, swap.id));

      recordAudit({
        action: swap.type === "SWAP" ? "SWAP_APPROVED_BY_MANAGER" : "TRANSFER_APPROVED_BY_MANAGER",
        entityType: swap.type === "SWAP" ? "SWAP_REQUEST" : "TRANSFER_REQUEST",
        entityId: swap.id,
        actorUserId: userId,
        actorRole: ctx.user!.role,
        description: swap.type === "SWAP"
          ? `Troca #${swap.id} aprovada por gestor`
          : `Repasse #${swap.id} aprovado por gestor`,
        fromProfessionalId: swap.fromProfessionalId,
        toProfessionalId: swap.toProfessionalId,
        fromUserId: swap.fromUserId,
        toUserId: swap.toUserId,
        shiftInstanceId: swap.fromShiftInstanceId,
        hospitalId: swap.hospitalId,
        sectorId: swap.sectorId ?? undefined,
        institutionId: swap.institutionId,
        metadata: { note: input.note },
      });

      return { ok: true };
    }),

  // ── rejectByManager ──────────────────────────────────────────────────────
  rejectByManager: protectedProcedure
    .input(
      z.object({
        swapRequestId: z.number(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const userId = ctx.user!.id;
      if (!isManager(ctx.user!.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas gestores podem rejeitar" });
      }

      const [swap] = await db
        .select()
        .from(swapRequests)
        .where(eq(swapRequests.id, input.swapRequestId));
      if (!swap) throw new TRPCError({ code: "NOT_FOUND", message: "Solicitação não encontrada" });

      if (swap.status !== "ACCEPTED" && swap.status !== "PENDING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Não é possível rejeitar com status ${swap.status}` });
      }

      await db
        .update(swapRequests)
        .set({
          status: "REJECTED_BY_MANAGER",
          reviewedByUserId: userId,
          reviewedAt: new Date(),
          reviewNote: input.note ?? null,
        })
        .where(eq(swapRequests.id, swap.id));

      recordAudit({
        action: swap.type === "SWAP" ? "SWAP_REJECTED" : "TRANSFER_REJECTED",
        entityType: swap.type === "SWAP" ? "SWAP_REQUEST" : "TRANSFER_REQUEST",
        entityId: swap.id,
        actorUserId: userId,
        actorRole: ctx.user!.role,
        description: `Solicitação #${swap.id} rejeitada pelo gestor`,
        fromProfessionalId: swap.fromProfessionalId,
        toProfessionalId: swap.toProfessionalId ?? undefined,
        fromUserId: swap.fromUserId,
        toUserId: swap.toUserId ?? undefined,
        shiftInstanceId: swap.fromShiftInstanceId,
        hospitalId: swap.hospitalId,
        sectorId: swap.sectorId ?? undefined,
        institutionId: swap.institutionId,
        metadata: { note: input.note },
      });

      return { ok: true };
    }),

  // ── cancel ────────────────────────────────────────────────────────────────
  cancel: protectedProcedure
    .input(z.object({ swapRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const userId = ctx.user!.id;

      const [swap] = await db
        .select()
        .from(swapRequests)
        .where(eq(swapRequests.id, input.swapRequestId));
      if (!swap) throw new TRPCError({ code: "NOT_FOUND", message: "Solicitação não encontrada" });

      if (swap.fromUserId !== userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas quem ofereceu pode cancelar" });
      }
      if (swap.status !== "PENDING" && swap.status !== "ACCEPTED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Não é possível cancelar com status ${swap.status}` });
      }

      await db
        .update(swapRequests)
        .set({ status: "CANCELLED" })
        .where(eq(swapRequests.id, swap.id));

      recordAudit({
        action: "SWAP_CANCELLED",
        entityType: swap.type === "SWAP" ? "SWAP_REQUEST" : "TRANSFER_REQUEST",
        entityId: swap.id,
        actorUserId: userId,
        actorRole: ctx.user!.role,
        description: `Solicitação #${swap.id} cancelada pelo ofertante`,
        fromProfessionalId: swap.fromProfessionalId,
        fromUserId: swap.fromUserId,
        shiftInstanceId: swap.fromShiftInstanceId,
        hospitalId: swap.hospitalId,
        sectorId: swap.sectorId ?? undefined,
        institutionId: swap.institutionId,
      });

      return { ok: true };
    }),

  // ── list ──────────────────────────────────────────────────────────────────
  list: protectedProcedure
    .input(
      z.object({
        status: z.string().optional(),
        type: z.enum(["SWAP", "TRANSFER"]).optional(),
        limit: z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const userId = ctx.user!.id;
      const userRole = ctx.user!.role;

      const pro = await getProfessionalForUser(db, userId);

      // Build WHERE conditions
      const conditions: any[] = [];

      if (input.status) conditions.push(eq(swapRequests.status, input.status as any));
      if (input.type) conditions.push(eq(swapRequests.type, input.type));

      // Non-managers see only their own swaps
      if (!isManager(userRole) && pro) {
        conditions.push(
          sql`(${swapRequests.fromProfessionalId} = ${pro.id} OR ${swapRequests.toProfessionalId} = ${pro.id})`,
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // Aliases for from/to shift + professionals
      const fromShift = shiftInstances;
      const fromPro = professionals;

      const rows = await db.execute(sql`
        SELECT
          sr.id,
          sr.type,
          sr.status,
          sr.reason,
          sr.review_note        AS reviewNote,
          sr.expires_at         AS expiresAt,
          sr.created_at         AS createdAt,
          sr.reviewed_at        AS reviewedAt,
          sr.from_professional_id AS fromProfessionalId,
          sr.to_professional_id   AS toProfessionalId,
          sr.from_shift_instance_id AS fromShiftInstanceId,
          sr.to_shift_instance_id   AS toShiftInstanceId,
          -- from professional
          fp.name               AS fromProfessionalName,
          fp.role               AS fromProfessionalRole,
          -- to professional
          tp.name               AS toProfessionalName,
          tp.role               AS toProfessionalRole,
          -- from shift
          fsi.label             AS fromShiftLabel,
          fsi.start_at          AS fromShiftStartAt,
          fsi.end_at            AS fromShiftEndAt,
          fh.name               AS fromHospitalName,
          fs.name               AS fromSectorName,
          -- to shift (SWAP only)
          tsi.label             AS toShiftLabel,
          tsi.start_at          AS toShiftStartAt,
          tsi.end_at            AS toShiftEndAt,
          th.name               AS toHospitalName,
          ts.name               AS toSectorName,
          -- reviewer
          ru.name               AS reviewerName
        FROM swap_requests sr
        JOIN professionals fp       ON fp.id  = sr.from_professional_id
        LEFT JOIN professionals tp  ON tp.id  = sr.to_professional_id
        JOIN shift_instances fsi    ON fsi.id = sr.from_shift_instance_id
        JOIN hospitals fh           ON fh.id  = fsi.hospital_id
        JOIN sectors fs             ON fs.id  = fsi.sector_id
        LEFT JOIN shift_instances tsi ON tsi.id = sr.to_shift_instance_id
        LEFT JOIN hospitals th      ON th.id  = tsi.hospital_id
        LEFT JOIN sectors ts        ON ts.id  = tsi.sector_id
        LEFT JOIN users ru          ON ru.id  = sr.reviewed_by_user_id
        WHERE 1=1
          ${input.status ? sql`AND sr.status = ${input.status}` : sql``}
          ${input.type ? sql`AND sr.type = ${input.type}` : sql``}
          ${!isManager(userRole) && pro
            ? sql`AND (sr.from_professional_id = ${pro.id} OR sr.to_professional_id = ${pro.id})`
            : sql``}
        ORDER BY sr.created_at DESC
        LIMIT ${input.limit}
        OFFSET ${input.offset}
      `);

      const data = ((rows as any).rows ?? (rows as any[])) as any[];

      return data.map((r: any) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        reason: r.reason,
        reviewNote: r.reviewNote,
        expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
        createdAt: new Date(r.createdAt),
        reviewedAt: r.reviewedAt ? new Date(r.reviewedAt) : null,
        fromProfessional: { id: r.fromProfessionalId, name: r.fromProfessionalName, role: r.fromProfessionalRole },
        toProfessional: r.toProfessionalId
          ? { id: r.toProfessionalId, name: r.toProfessionalName, role: r.toProfessionalRole }
          : null,
        fromShift: {
          id: r.fromShiftInstanceId,
          label: r.fromShiftLabel,
          startAt: new Date(r.fromShiftStartAt),
          endAt: new Date(r.fromShiftEndAt),
          hospitalName: r.fromHospitalName,
          sectorName: r.fromSectorName,
        },
        toShift: r.toShiftInstanceId
          ? {
              id: r.toShiftInstanceId,
              label: r.toShiftLabel,
              startAt: new Date(r.toShiftStartAt),
              endAt: new Date(r.toShiftEndAt),
              hospitalName: r.toHospitalName,
              sectorName: r.toSectorName,
            }
          : null,
        reviewerName: r.reviewerName ?? null,
      }));
    }),

  // ── getById ───────────────────────────────────────────────────────────────
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const rows = await db.execute(sql`
        SELECT
          sr.*,
          fp.name  AS from_professional_name,
          fp.role  AS from_professional_role,
          tp.name  AS to_professional_name,
          tp.role  AS to_professional_role,
          fsi.label AS from_shift_label,
          fsi.start_at AS from_shift_start_at,
          fsi.end_at   AS from_shift_end_at,
          fh.name  AS from_hospital_name,
          fs.name  AS from_sector_name,
          tsi.label AS to_shift_label,
          tsi.start_at AS to_shift_start_at,
          tsi.end_at   AS to_shift_end_at,
          th.name  AS to_hospital_name,
          ts2.name AS to_sector_name,
          ru.name  AS reviewer_name
        FROM swap_requests sr
        JOIN professionals fp       ON fp.id  = sr.from_professional_id
        LEFT JOIN professionals tp  ON tp.id  = sr.to_professional_id
        JOIN shift_instances fsi    ON fsi.id = sr.from_shift_instance_id
        JOIN hospitals fh           ON fh.id  = fsi.hospital_id
        JOIN sectors fs             ON fs.id  = fsi.sector_id
        LEFT JOIN shift_instances tsi ON tsi.id = sr.to_shift_instance_id
        LEFT JOIN hospitals th      ON th.id  = tsi.hospital_id
        LEFT JOIN sectors ts2       ON ts2.id = tsi.sector_id
        LEFT JOIN users ru          ON ru.id  = sr.reviewed_by_user_id
        WHERE sr.id = ${input.id}
        LIMIT 1
      `);

      const data = ((rows as any).rows ?? (rows as any[])) as any[];
      if (!data[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Solicitação não encontrada" });

      const r = data[0];
      return {
        id: r.id,
        type: r.type,
        status: r.status,
        reason: r.reason,
        reviewNote: r.review_note,
        expiresAt: r.expires_at ? new Date(r.expires_at) : null,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
        reviewedAt: r.reviewed_at ? new Date(r.reviewed_at) : null,
        version: r.version,
        fromProfessional: { id: r.from_professional_id, name: r.from_professional_name, role: r.from_professional_role },
        toProfessional: r.to_professional_id
          ? { id: r.to_professional_id, name: r.to_professional_name, role: r.to_professional_role }
          : null,
        fromShift: {
          id: r.from_shift_instance_id,
          label: r.from_shift_label,
          startAt: new Date(r.from_shift_start_at),
          endAt: new Date(r.from_shift_end_at),
          hospitalName: r.from_hospital_name,
          sectorName: r.from_sector_name,
        },
        toShift: r.to_shift_instance_id
          ? {
              id: r.to_shift_instance_id,
              label: r.to_shift_label,
              startAt: new Date(r.to_shift_start_at),
              endAt: new Date(r.to_shift_end_at),
              hospitalName: r.to_hospital_name,
              sectorName: r.to_sector_name,
            }
          : null,
        fromAssignmentId: r.from_assignment_id,
        toAssignmentId: r.to_assignment_id,
        reviewerName: r.reviewer_name ?? null,
        institutionId: r.institution_id,
        hospitalId: r.hospital_id,
        sectorId: r.sector_id,
      };
    }),

  // ── listAvailable ─────────────────────────────────────────────────────────
  listAvailable: protectedProcedure
    .input(
      z.object({
        type: z.enum(["SWAP", "TRANSFER"]).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const userId = ctx.user!.id;
      const pro = await getProfessionalForUser(db, userId);
      if (!pro) return [];

      const rows = await db.execute(sql`
        SELECT
          sr.id,
          sr.type,
          sr.reason,
          sr.expires_at       AS expiresAt,
          sr.created_at       AS createdAt,
          fp.name             AS fromProfessionalName,
          fp.role             AS fromProfessionalRole,
          fsi.id              AS fromShiftInstanceId,
          fsi.label           AS fromShiftLabel,
          fsi.start_at        AS fromShiftStartAt,
          fsi.end_at          AS fromShiftEndAt,
          fh.name             AS fromHospitalName,
          fs.name             AS fromSectorName,
          tsi.id              AS toShiftInstanceId,
          tsi.label           AS toShiftLabel,
          tsi.start_at        AS toShiftStartAt,
          tsi.end_at          AS toShiftEndAt,
          th.name             AS toHospitalName,
          ts.name             AS toSectorName
        FROM swap_requests sr
        JOIN professionals fp       ON fp.id  = sr.from_professional_id
        JOIN shift_instances fsi    ON fsi.id = sr.from_shift_instance_id
        JOIN hospitals fh           ON fh.id  = fsi.hospital_id
        JOIN sectors fs             ON fs.id  = fsi.sector_id
        LEFT JOIN shift_instances tsi ON tsi.id = sr.to_shift_instance_id
        LEFT JOIN hospitals th      ON th.id  = tsi.hospital_id
        LEFT JOIN sectors ts        ON ts.id  = tsi.sector_id
        WHERE sr.status = 'PENDING'
          AND sr.from_user_id != ${userId}
          AND fsi.start_at > NOW()
          AND (sr.expires_at IS NULL OR sr.expires_at > NOW())
          ${input.type ? sql`AND sr.type = ${input.type}` : sql``}
        ORDER BY fsi.start_at ASC
      `);

      const data = ((rows as any).rows ?? (rows as any[])) as any[];

      // Filter out swaps the user has a time conflict with
      const available = [];
      for (const r of data) {
        const shiftStart = new Date(r.fromShiftStartAt);
        const shiftEnd = new Date(r.fromShiftEndAt);

        // Quick conflict check for the from-shift
        const conflictResult = await db.execute(sql`
          SELECT COUNT(*) as cnt
          FROM shift_assignments_v2 sa
          JOIN professionals p ON p.id = sa.professional_id
          JOIN shift_instances si ON si.id = sa.shift_instance_id
          WHERE p.user_id = ${userId}
            AND sa.is_active = 1
            AND si.start_at < ${shiftEnd.toISOString().slice(0, 19).replace("T", " ")}
            AND si.end_at   > ${shiftStart.toISOString().slice(0, 19).replace("T", " ")}
        `);
        const conflictRows = ((conflictResult as any).rows ?? (conflictResult as any[])) as any[];
        if (conflictRows[0]?.cnt > 0) continue;

        available.push({
          id: r.id,
          type: r.type,
          reason: r.reason,
          expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
          createdAt: new Date(r.createdAt),
          fromProfessional: { name: r.fromProfessionalName, role: r.fromProfessionalRole },
          fromShift: {
            id: r.fromShiftInstanceId,
            label: r.fromShiftLabel,
            startAt: shiftStart,
            endAt: shiftEnd,
            hospitalName: r.fromHospitalName,
            sectorName: r.fromSectorName,
          },
          toShift: r.toShiftInstanceId
            ? {
                id: r.toShiftInstanceId,
                label: r.toShiftLabel,
                startAt: new Date(r.toShiftStartAt),
                endAt: new Date(r.toShiftEndAt),
                hospitalName: r.toHospitalName,
                sectorName: r.toSectorName,
              }
            : null,
        });
      }

      return available;
    }),
});
