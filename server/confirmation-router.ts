// server/confirmation-router.ts — Endpoints de confirmação de presença pré-plantão
import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  dutyConfirmations,
  professionals,
  professionalInstitutions,
  shiftInstances,
  shiftAssignmentsV2,
  sectors,
} from "../drizzle/schema";
import { sendPushNotification } from "./notifications-service";
import { assertSpecialtyCompatible, specialtiesConflict } from "./specialty";
import { recordAudit } from "./audit-trail";
import { randomUUID } from "crypto";
import { triggerAutoSso } from "./sso/auto-sso";
import { syncDutyToComunica } from "./sso/duty-sync";

export const confirmationRouter = router({
  /**
   * Registra push token do dispositivo para o usuário logado.
   */
  registerPushToken: protectedProcedure
    .input(z.object({
      token: z.string().min(1),
      platform: z.enum(["ios", "android", "web"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const { registerPushToken: register } = await import("./notifications-service");
      return register(ctx.user.id, input.token, input.platform, ctx.institutionId);
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

    const pending = await db
      .select({
        id: dutyConfirmations.id,
        status: dutyConfirmations.status,
        confirmationToken: dutyConfirmations.confirmationToken,
        shiftInstanceId: dutyConfirmations.shiftInstanceId,
        notifiedAt: dutyConfirmations.notifiedAt,
        shiftLabel: shiftInstances.label,
        shiftStartAt: shiftInstances.startAt,
        shiftEndAt: shiftInstances.endAt,
        sectorName: sectors.name,
      })
      .from(dutyConfirmations)
      .innerJoin(shiftInstances, eq(dutyConfirmations.shiftInstanceId, shiftInstances.id))
      .innerJoin(sectors, eq(shiftInstances.sectorId, sectors.id))
      .where(
        and(
          eq(dutyConfirmations.userId, ctx.user.id),
          eq(dutyConfirmations.status, "PENDING"),
        ),
      )
      .limit(1);

    return pending[0] ?? null;
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
          ),
        )
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada" });
      }

      if (conf.status !== "PENDING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Confirmação já processada (${conf.status})` });
      }

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
          ),
        )
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada" });
      }

      if (conf.status !== "PENDING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Confirmação já processada (${conf.status})` });
      }

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
          ),
        )
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada" });
      }

      if (conf.status !== "DECLINED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Só é possível indicar substituto após recusar o plantão" });
      }

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
            eq(professionalInstitutions.institutionId, conf.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        )
        .where(eq(professionals.id, input.replacementProfessionalId))
        .limit(1);

      if (!replacement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profissional substituto não encontrado nesta instituição" });
      }

      // Substituto deve ser do mesmo serviço do plantão.
      const [shiftSpec] = await db
        .select({ specialty: shiftInstances.specialty })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, conf.shiftInstanceId))
        .limit(1);
      assertSpecialtyCompatible(shiftSpec?.specialty ?? null, replacement.specialty);

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
      const [shift] = await db
        .select({ label: shiftInstances.label, startAt: shiftInstances.startAt, endAt: shiftInstances.endAt })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, conf.shiftInstanceId))
        .limit(1);

      // timeZone explícito: startAt é instante UTC e o servidor roda em UTC.
      const TZ = "America/Sao_Paulo";
      const startTime = shift ? new Date(shift.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "";
      const endTime = shift ? new Date(shift.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "";

      // Push to replacement
      await sendPushNotification(replacement.userId, {
        title: "Plantão disponível para você",
        body: `${ctx.user.name ?? "Um colega"} indicou você para o plantão ${shift?.label ?? ""} (${startTime}–${endTime}). Aceita?`,
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
        .where(eq(dutyConfirmations.confirmationToken, input.confirmationToken))
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada" });
      }

      if (conf.status !== "NOMINATED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Esta indicação já foi processada" });
      }

      if (conf.replacementUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Você não é o profissional indicado" });
      }

      // Find replacement professional record
      const [replacementPro] = await db
        .select({ id: professionals.id })
        .from(professionals)
        .where(eq(professionals.userId, ctx.user.id))
        .limit(1);

      if (!replacementPro) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profissional não encontrado" });
      }

      // Deactivate old assignment
      await db
        .update(shiftAssignmentsV2)
        .set({ isActive: false })
        .where(eq(shiftAssignmentsV2.id, conf.assignmentId));

      // Create new assignment for replacement
      const [oldAssignment] = await db
        .select()
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, conf.assignmentId))
        .limit(1);

      if (oldAssignment) {
        await db.insert(shiftAssignmentsV2).values({
          shiftInstanceId: oldAssignment.shiftInstanceId,
          institutionId: oldAssignment.institutionId,
          hospitalId: oldAssignment.hospitalId,
          sectorId: oldAssignment.sectorId,
          professionalId: replacementPro.id,
          assignmentType: oldAssignment.assignmentType,
          status: "OCUPADO",
          isActive: true,
          createdBy: ctx.user.id,
        });
      }

      // Update confirmation
      await db
        .update(dutyConfirmations)
        .set({
          status: "REPLACEMENT_CONFIRMED",
          respondedAt: new Date(),
        })
        .where(eq(dutyConfirmations.id, conf.id));

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
        .where(eq(dutyConfirmations.confirmationToken, input.confirmationToken))
        .limit(1);

      if (!conf) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (conf.status !== "NOMINATED" || conf.replacementUserId !== ctx.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST" });
      }

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
