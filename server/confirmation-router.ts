// server/confirmation-router.ts — Endpoints de confirmação de presença pré-plantão
import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { assertMonthNotLockedForUpdate } from "./month-guards";
import { recomputeShiftStatus } from "./shift-status";
import { eq, and, asc, isNull, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  dutyConfirmations,
  professionalAccess,
  professionals,
  professionalInstitutions,
  shiftAssignmentsV2,
} from "../drizzle/schema";
import { sendPushNotification } from "./notifications-service";
import { assertSpecialtyCompatible, specialtiesConflict } from "./specialty";
import { recordAudit } from "./audit-trail";
import { triggerAutoSso } from "./sso/auto-sso";
import { syncDutyToComunica } from "./sso/duty-sync";
import { requireValidDutyConfirmation } from "./confirmation-integrity";

export const confirmationRouter = router({
  /**
   * Registra push token do dispositivo para o usuário logado.
   */
  registerPushToken: protectedProcedure
    .input(z.object({
      token: z.string().min(1).max(512),
      platform: z.enum(["ios", "android", "web"]),
      institutionId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (
        input.institutionId !== undefined &&
        input.institutionId !== ctx.institutionId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Tenant do registro de push não corresponde ao tenant ativo",
        });
      }
      const { registerPushToken: register } = await import("./notifications-service");
      return register(
        ctx.user.id,
        input.token,
        input.platform,
        ctx.institutionId,
        ctx.user.sessionVersion,
      );
    }),

  /** Logout / troca de conta: o aparelho deixa de receber push deste usuário. */
  unregisterPushToken: protectedProcedure
    .input(z.object({ token: z.string().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      const { unregisterPushToken: unregister } = await import("./notifications-service");
      return unregister(ctx.user.id, input.token);
    }),

  /**
   * Indicação dirigida a MIM (substituto): dados do plantão + quem indicou,
   * para a tela de aceite. Só responde se a indicação ainda está aberta.
   */
  getNomination: protectedProcedure
    .input(z.object({ confirmationToken: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [candidate] = await db
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(
          and(
            eq(dutyConfirmations.confirmationToken, input.confirmationToken),
            eq(dutyConfirmations.replacementUserId, ctx.user.id),
            eq(dutyConfirmations.institutionId, ctx.institutionId),
            eq(dutyConfirmations.status, "NOMINATED"),
          ),
        )
        .limit(1);
      if (!candidate) return null;
      const valid = await requireValidDutyConfirmation(db, candidate.id, {
        allowedStatuses: ["NOMINATED"],
        expectedActor: { kind: "REPLACEMENT", userId: ctx.user.id },
        expectedInstitutionId: ctx.institutionId,
        requireReplacementMembership: true,
      });
      return {
        id: valid.confirmation.id,
        status: valid.confirmation.status,
        confirmationToken: valid.confirmation.confirmationToken,
        shiftInstanceId: valid.shift.id,
        shiftLabel: valid.shift.label,
        shiftStartAt: valid.shift.startAt,
        shiftEndAt: valid.shift.endAt,
        sectorName: valid.shift.sectorName,
        nominatedByName: valid.original.name,
      };
    }),

  /**
   * Lista profissionais da instituição ativa (para indicar substituto).
   * Exclui o próprio usuário logado.
   */
  listReplacementCandidates: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const rows = await db
      .select({
        id: professionals.id,
        name: professionals.name,
        role: professionals.role,
        userId: professionals.userId,
        specialty: professionals.specialty,
      })
      .from(professionals)
      .innerJoin(
        professionalInstitutions,
        and(
          eq(professionalInstitutions.professionalId, professionals.id),
          eq(professionalInstitutions.institutionId, ctx.institutionId),
          eq(professionalInstitutions.active, true),
        ),
      )
      .where(
        // Exclude the logged-in user
        eq(professionalInstitutions.userId, professionals.userId),
      );

    // Só colegas do MESMO serviço podem substituir (NULL = sem restrição).
    const [me] = await db
      .select({ specialty: professionals.specialty })
      .from(professionals)
      .where(eq(professionals.userId, ctx.user.id))
      .limit(1);

    return rows
      .filter((r) => r.userId !== ctx.user.id)
      .filter((r) => !specialtiesConflict(me?.specialty ?? null, r.specialty))
      .map((r) => ({ id: r.id, name: r.name, role: r.role }));
  }),

  /**
   * Retorna confirmação pendente para o usuário logado (se houver).
   * Usado pelo frontend para exibir tela de confirmação.
   */
  getPending: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const candidates = await db
      .select({ id: dutyConfirmations.id })
      .from(dutyConfirmations)
      .where(
        and(
          eq(dutyConfirmations.userId, ctx.user.id),
          eq(dutyConfirmations.institutionId, ctx.institutionId),
          eq(dutyConfirmations.status, "PENDING"),
        ),
      )
      .orderBy(asc(dutyConfirmations.id));
    for (const candidate of candidates) {
      try {
        const valid = await requireValidDutyConfirmation(db, candidate.id, {
          allowedStatuses: ["PENDING"],
          expectedActor: { kind: "ORIGINAL", userId: ctx.user.id },
          expectedInstitutionId: ctx.institutionId,
        });
        return {
          id: valid.confirmation.id,
          status: valid.confirmation.status,
          confirmationToken: valid.confirmation.confirmationToken,
          shiftInstanceId: valid.shift.id,
          notifiedAt: valid.confirmation.notifiedAt,
          shiftLabel: valid.shift.label,
          shiftStartAt: valid.shift.startAt,
          shiftEndAt: valid.shift.endAt,
          sectorName: valid.shift.sectorName,
        };
      } catch {
        // Linhas legadas inválidas não podem expor dados nem mascarar uma
        // confirmação válida posterior para o mesmo usuário/tenant.
      }
    }
    return null;
  }),

  /**
   * Médico confirma presença no plantão.
   * Dispara auto-SSO no Comunica+ (Fase 3).
   */
  confirm: protectedProcedure
    .input(z.object({ confirmationToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [conf] = await db
        .select()
        .from(dutyConfirmations)
        .where(
          and(
            eq(dutyConfirmations.confirmationToken, input.confirmationToken),
            eq(dutyConfirmations.userId, ctx.user.id),
            eq(dutyConfirmations.institutionId, ctx.institutionId),
          ),
        )
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada" });
      }
      await requireValidDutyConfirmation(db, conf.id, {
        allowedStatuses: ["PENDING"],
        expectedActor: { kind: "ORIGINAL", userId: ctx.user.id },
        expectedInstitutionId: ctx.institutionId,
      });

      await db
        .update(dutyConfirmations)
        .set({
          status: "CONFIRMED",
          respondedAt: new Date(),
        })
        .where(eq(dutyConfirmations.id, conf.id));

      recordAudit({
        action: "ASSIGNMENT_APPROVED",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: conf.assignmentId,
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        institutionId: conf.institutionId,
        shiftInstanceId: conf.shiftInstanceId,
        description: `Médico confirmou presença no plantão`,
      });

      // Auto-SSO → Comunica+ (fire-and-forget)
      triggerAutoSso(conf.id).catch((err) =>
        console.error("[Confirmation] Auto-SSO failed:", err),
      );
      // Fase 1 duty-sync: declara o plantonista no roster do Comunica+
      syncDutyToComunica(conf.id, "CONFIRM").catch((err) =>
        console.error("[Confirmation] Duty-sync failed:", err),
      );

      return { ok: true, status: "CONFIRMED" as const };
    }),

  /**
   * Médico recusa o plantão. Pode indicar substituto depois.
   */
  decline: protectedProcedure
    .input(z.object({
      confirmationToken: z.string().uuid(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [conf] = await db
        .select()
        .from(dutyConfirmations)
        .where(
          and(
            eq(dutyConfirmations.confirmationToken, input.confirmationToken),
            eq(dutyConfirmations.userId, ctx.user.id),
            eq(dutyConfirmations.institutionId, ctx.institutionId),
          ),
        )
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada" });
      }
      await requireValidDutyConfirmation(db, conf.id, {
        allowedStatuses: ["PENDING"],
        expectedActor: { kind: "ORIGINAL", userId: ctx.user.id },
        expectedInstitutionId: ctx.institutionId,
      });

      // Reset recheck timer: +30min from now for replacement flow
      const newRecheckAt = new Date(Date.now() + 30 * 60 * 1000);

      await db
        .update(dutyConfirmations)
        .set({
          status: "DECLINED",
          respondedAt: new Date(),
          declineReason: input.reason ?? null,
          recheckAt: newRecheckAt,
        })
        .where(eq(dutyConfirmations.id, conf.id));

      // Duty-sync: retira a declaração no Comunica+ (o médico recusou;
      // se um substituto aceitar depois, o CONFIRM dele reativa).
      syncDutyToComunica(conf.id, "WITHDRAW").catch((err) =>
        console.error("[Confirmation] Duty-sync withdraw failed:", err),
      );

      recordAudit({
        action: "ASSIGNMENT_REJECTED",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: conf.assignmentId,
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        institutionId: conf.institutionId,
        shiftInstanceId: conf.shiftInstanceId,
        description: `Médico recusou plantão${input.reason ? `: ${input.reason}` : ""}`,
      });

      return { ok: true, status: "DECLINED" as const };
    }),

  /**
   * Médico que recusou indica um substituto.
   * Envia push ao substituto pedindo aceite.
   */
  nominateReplacement: protectedProcedure
    .input(z.object({
      confirmationToken: z.string().uuid(),
      replacementProfessionalId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [conf] = await db
        .select()
        .from(dutyConfirmations)
        .where(
          and(
            eq(dutyConfirmations.confirmationToken, input.confirmationToken),
            eq(dutyConfirmations.userId, ctx.user.id),
            eq(dutyConfirmations.institutionId, ctx.institutionId),
          ),
        )
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada" });
      }
      const valid = await requireValidDutyConfirmation(db, conf.id, {
        allowedStatuses: ["DECLINED"],
        expectedActor: { kind: "ORIGINAL", userId: ctx.user.id },
        expectedInstitutionId: ctx.institutionId,
      });

      // Find replacement professional — OBRIGATORIAMENTE com vínculo
      // ativo na instituição do plantão. Sem esse filtro, qualquer
      // professionalId do banco podia ser indicado, criando alocação
      // (e vazando dados do plantão via push) para profissional de
      // outra instituição. Mesmo critério do listReplacementCandidates.
      const [replacement] = await db
        .select({ id: professionals.id, userId: professionals.userId, name: professionals.name, specialty: professionals.specialty })
        .from(professionals)
        .innerJoin(
          professionalInstitutions,
          and(
            eq(professionalInstitutions.professionalId, professionals.id),
            eq(professionalInstitutions.userId, professionals.userId),
            eq(professionalInstitutions.institutionId, conf.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        )
        .innerJoin(
          professionalAccess,
          and(
            eq(professionalAccess.professionalId, professionals.id),
            eq(professionalAccess.institutionId, valid.shift.institutionId),
            eq(professionalAccess.hospitalId, valid.shift.hospitalId),
            or(
              isNull(professionalAccess.sectorId),
              eq(professionalAccess.sectorId, valid.shift.sectorId),
            ),
            eq(professionalAccess.canAccess, true),
          ),
        )
        .where(eq(professionals.id, input.replacementProfessionalId))
        .limit(1);

      if (!replacement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profissional substituto não encontrado nesta instituição" });
      }

      // Substituto deve ser do mesmo serviço do plantão.
      assertSpecialtyCompatible(valid.shift.specialty, replacement.specialty);

      // Reset recheck timer: +30min for replacement to respond
      const newRecheckAt = new Date(Date.now() + 30 * 60 * 1000);

      await db
        .update(dutyConfirmations)
        .set({
          status: "NOMINATED",
          replacementProfessionalId: replacement.id,
          replacementUserId: replacement.userId,
          recheckAt: newRecheckAt,
        })
        .where(eq(dutyConfirmations.id, conf.id));

      // Get shift details for notification
      // timeZone explícito: startAt é instante UTC e o servidor roda em UTC.
      const TZ = "America/Sao_Paulo";
      const startTime = new Date(valid.shift.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
      const endTime = new Date(valid.shift.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

      // Push to replacement
      await sendPushNotification(replacement.userId, {
        title: "Plantão disponível para você",
        body: `${ctx.user.name ?? "Um colega"} indicou você para o plantão ${valid.shift.label} (${startTime}–${endTime}). Aceita?`,
        data: {
          type: "duty_nomination",
          confirmationToken: conf.confirmationToken,
          shiftInstanceId: conf.shiftInstanceId,
        },
      });

      recordAudit({
        action: "TRANSFER_OFFERED",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: conf.assignmentId,
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        institutionId: conf.institutionId,
        shiftInstanceId: conf.shiftInstanceId,
        toProfessionalId: replacement.id,
        toUserId: replacement.userId,
        description: `Indicou ${replacement.name} como substituto`,
      });

      return { ok: true, status: "NOMINATED" as const, replacementName: replacement.name };
    }),

  /**
   * Substituto aceita a indicação.
   * Reatribui o plantão e dispara auto-SSO.
   */
  acceptNomination: protectedProcedure
    .input(z.object({ confirmationToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [conf] = await db
        .select()
        .from(dutyConfirmations)
        .where(
          and(
            eq(dutyConfirmations.confirmationToken, input.confirmationToken),
            eq(dutyConfirmations.institutionId, ctx.institutionId),
          ),
        )
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada" });
      }

      if (conf.status !== "NOMINATED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Esta indicação já foi processada" });
      }
      const valid = await requireValidDutyConfirmation(db, conf.id, {
        allowedStatuses: ["NOMINATED"],
        expectedActor: { kind: "REPLACEMENT", userId: ctx.user.id },
        expectedInstitutionId: ctx.institutionId,
        requireOriginalAssignmentActive: false,
        requireReplacementMembership: true,
      });
      if (!valid.original.isActive) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A alocação original já foi alterada — esta indicação não vale mais.",
        });
      }
      const replacementPro = valid.replacement!;

      // Realocação é a mesma operação de uma cessão: transação, alocação
      // de origem ainda ativa, mês não trancado e status do turno
      // derivado (auditoria 22/08 parte 2).
      await db.transaction(async (tx) => {
        await assertMonthNotLockedForUpdate(
          tx,
          valid.shift.institutionId,
          valid.shift.hospitalId,
          valid.shift.startAt,
        );
        const [deactivated] = await tx
          .update(shiftAssignmentsV2)
          .set({ isActive: false })
          .where(and(eq(shiftAssignmentsV2.id, valid.original.assignmentId!), eq(shiftAssignmentsV2.isActive, true)));
        if (!deactivated.affectedRows) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A alocação original já foi alterada — esta indicação não vale mais.",
          });
        }
        await tx.insert(shiftAssignmentsV2).values({
          shiftInstanceId: valid.shift.id,
          institutionId: valid.shift.institutionId,
          hospitalId: valid.shift.hospitalId,
          sectorId: valid.shift.sectorId,
          professionalId: replacementPro.professionalId,
          assignmentType: valid.original.assignmentType,
          status: "OCUPADO",
          isActive: true,
          createdBy: ctx.user.id,
        });
        await recomputeShiftStatus(tx, valid.shift.id);
        const [done] = await tx
          .update(dutyConfirmations)
          .set({ status: "REPLACEMENT_CONFIRMED", respondedAt: new Date() })
          .where(and(eq(dutyConfirmations.id, conf.id), eq(dutyConfirmations.status, "NOMINATED")));
        if (!done.affectedRows) {
          throw new TRPCError({ code: "CONFLICT", message: "Esta indicação já foi processada." });
        }
      });

      // Auto-SSO for replacement → Comunica+ (fire-and-forget)
      triggerAutoSso(conf.id).catch((err) =>
        console.error("[Confirmation] Auto-SSO for replacement failed:", err),
      );
      // Duty-sync: o SUBSTITUTO vira o plantonista declarado no Comunica+
      syncDutyToComunica(conf.id, "CONFIRM").catch((err) =>
        console.error("[Confirmation] Duty-sync for replacement failed:", err),
      );

      // Notify original doctor
      await sendPushNotification(conf.userId, {
        title: "Substituto confirmado",
        body: `${ctx.user.name ?? "O substituto"} aceitou seu plantão.`,
        data: { type: "replacement_accepted", shiftInstanceId: conf.shiftInstanceId },
      });

      recordAudit({
        action: "TRANSFER_ACCEPTED",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: conf.assignmentId,
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        institutionId: conf.institutionId,
        shiftInstanceId: conf.shiftInstanceId,
        fromProfessionalId: conf.professionalId,
        fromUserId: conf.userId,
        description: `Substituto aceitou o plantão`,
      });

      return { ok: true, status: "REPLACEMENT_CONFIRMED" as const };
    }),

  /**
   * Substituto recusa a indicação.
   * Volta para DECLINED — médico original pode indicar outro ou
   * o cron faz auto-confirm na rechecagem.
   */
  declineNomination: protectedProcedure
    .input(z.object({ confirmationToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [conf] = await db
        .select()
        .from(dutyConfirmations)
        .where(
          and(
            eq(dutyConfirmations.confirmationToken, input.confirmationToken),
            eq(dutyConfirmations.institutionId, ctx.institutionId),
          ),
        )
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await requireValidDutyConfirmation(db, conf.id, {
        allowedStatuses: ["NOMINATED"],
        expectedActor: { kind: "REPLACEMENT", userId: ctx.user.id },
        expectedInstitutionId: ctx.institutionId,
        requireReplacementMembership: true,
      });

      // Reset to DECLINED so original doctor can nominate someone else
      // Recheck timer: +30min
      await db
        .update(dutyConfirmations)
        .set({
          status: "REPLACEMENT_DECLINED",
          replacementProfessionalId: null,
          replacementUserId: null,
          recheckAt: new Date(Date.now() + 30 * 60 * 1000),
        })
        .where(eq(dutyConfirmations.id, conf.id));

      // Notify original doctor
      await sendPushNotification(conf.userId, {
        title: "Substituto recusou",
        body: `O substituto indicado não aceitou o plantão. Indique outro ou o sistema confirmará automaticamente.`,
        data: { type: "replacement_declined", shiftInstanceId: conf.shiftInstanceId },
      });

      return { ok: true };
    }),
});
