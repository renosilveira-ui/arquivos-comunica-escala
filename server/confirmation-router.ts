// server/confirmation-router.ts — Endpoints de confirmação de presença pré-plantão
import { z } from "zod";
import { router, protectedProcedure, sessionProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { assertMonthNotLockedForUpdate } from "./month-guards";
import { recomputeShiftStatus } from "./shift-status";
import { eq, and, asc, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  dutyConfirmations,
  professionals,
  professionalInstitutions,
  shiftAssignmentsV2,
  users,
} from "../drizzle/schema";
import { assertSpecialtyCompatible, specialtiesConflict } from "./specialty";
import { recordAudit } from "./audit-trail";
import { enqueueAutoSsoPush, triggerAutoSso } from "./sso/auto-sso";
import {
  canonicalizeDutySyncExternalSubject,
  DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON,
  enqueueDutySync,
  type DutySyncExternalSubjectBinding,
} from "./sso/duty-sync";
import {
  dutyShiftSnapshot,
  requireValidDutyConfirmation,
} from "./confirmation-integrity";
import {
  dutyConfirmationCasIdentity,
  transitionDutyConfirmation,
} from "./confirmation-state";
import {
  enqueueTrackedPushNotification,
  sendTrackedPushNotification,
  type TrackedPushInput,
} from "./push-delivery";
import {
  ASSIGNMENT_WRITE_TRANSACTION_CONFIG,
  assertAssignmentWritesAllowedForUpdate,
  assertShiftAssignmentCapacityForUpdate,
} from "./shift-validations-v2";

type ConfirmationDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const expoPushTokenInput = z
  .string()
  .min(1)
  .max(512)
  .refine((token) => token.trim() === token && !/\s/.test(token), {
    message: "Push token contém whitespace inválido",
  });

async function resolveApprovedExternalSubject(
  db: Pick<ConfirmationDb, "select">,
  userId: number,
): Promise<DutySyncExternalSubjectBinding> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  const externalSubject = canonicalizeDutySyncExternalSubject(user?.email);
  return externalSubject
    ? { externalSubject }
    : {
        externalSubjectUnavailableReason:
          DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON,
      };
}

export const confirmationRouter = router({
  /**
   * Registra push token do dispositivo para o usuário logado.
   */
  registerPushToken: sessionProcedure
    .input(z.object({
      token: expoPushTokenInput,
      platform: z.enum(["ios", "android", "web"]),
      expectedUserId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.expectedUserId !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Usuário do registro push não corresponde à sessão",
        });
      }
      const { registerPushToken: register } = await import("./notifications-service");
      return register(
        ctx.user.id,
        input.token,
        input.platform,
        // O contexto pode estar sem tenant durante a hidratação. Quando
        // presente, este ID é apenas proveniência auditável da associação.
        ctx.institutionId,
        ctx.user.sessionVersion,
      );
    }),

  /** Logout / troca de conta: o aparelho deixa de receber push deste usuário. */
  unregisterPushToken: sessionProcedure
    .input(z.object({
      token: expoPushTokenInput,
      expectedUserId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.expectedUserId !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Usuário do desregistro push não corresponde à sessão",
        });
      }
      const { unregisterPushToken: unregister } = await import("./notifications-service");
      return unregister(ctx.user.id, input.token, ctx.user.sessionVersion);
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
      .innerJoin(
        users,
        and(
          eq(users.id, professionalInstitutions.userId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
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
  getPending: protectedProcedure
    .input(z.object({ confirmationToken: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
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
            input?.confirmationToken
              ? eq(dutyConfirmations.confirmationToken, input.confirmationToken)
              : undefined,
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
        } catch (error) {
          if (!(error instanceof TRPCError)) throw error;
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
      await db.transaction(async (tx) => {
        const current = await requireValidDutyConfirmation(tx, conf.id, {
          allowedStatuses: ["PENDING"],
          expectedActor: {
            kind: "ORIGINAL",
            userId: ctx.user.id,
            sessionVersion: ctx.user.sessionVersion,
          },
          expectedInstitutionId: ctx.institutionId,
          lockForUpdate: true,
        });
        await transitionDutyConfirmation(tx, {
          kind: "CONFIRM",
          ...dutyConfirmationCasIdentity(current.confirmation),
          expectedStatus: "PENDING",
          respondedAt: new Date(),
        });
        await recordAudit({
          action: "ASSIGNMENT_APPROVED",
          entityType: "SHIFT_ASSIGNMENT",
          entityId: current.confirmation.assignmentId,
          actorUserId: ctx.user.id,
          actorRole: ctx.user.role,
          actorName: ctx.user.name ?? undefined,
          institutionId: current.confirmation.institutionId,
          shiftInstanceId: current.confirmation.shiftInstanceId,
          description: "Médico confirmou presença no plantão",
        }, { db: tx, strict: true });
        const externalSubjectBinding = await resolveApprovedExternalSubject(
          tx,
          current.original.userId,
        );
        await enqueueDutySync({
          confirmationId: current.confirmation.id,
          institutionId: current.shift.institutionId,
          shiftInstanceId: current.shift.id,
          targetUserId: current.original.userId,
          ...externalSubjectBinding,
          shiftSnapshot: dutyShiftSnapshot(current.shift),
          action: "CONFIRM",
          confirmationStatus: "CONFIRMED",
          expectedStatuses: ["CONFIRMED"],
          dutyType: current.shift.modality === "SOBREAVISO" ? "SOBREAVISO" : "PLANTAO",
          serviceName: current.shift.specialty,
          dedupKey: `duty-confirmation:${current.confirmation.id}:duty-sync:confirmed:${current.original.userId}`,
        }, new Date(), tx);
        await enqueueAutoSsoPush(current.confirmation.id, new Date(), tx);
      });

      // Auto-SSO → Comunica+ (fire-and-forget)
      triggerAutoSso(conf.id).catch(() =>
        console.error(`[Confirmation] AUTO_SSO_FAILED confirmation=${conf.id}`),
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
      // Reset recheck timer: +30min from now for replacement flow
      const newRecheckAt = new Date(Date.now() + 30 * 60 * 1000);

      await db.transaction(async (tx) => {
        const current = await requireValidDutyConfirmation(tx, conf.id, {
          allowedStatuses: ["PENDING"],
          expectedActor: {
            kind: "ORIGINAL",
            userId: ctx.user.id,
            sessionVersion: ctx.user.sessionVersion,
          },
          expectedInstitutionId: ctx.institutionId,
          lockForUpdate: true,
        });
        await transitionDutyConfirmation(tx, {
          kind: "DECLINE",
          ...dutyConfirmationCasIdentity(current.confirmation),
          expectedStatus: "PENDING",
          respondedAt: new Date(),
          declineReason: input.reason ?? null,
          recheckAt: newRecheckAt,
        });
        await recordAudit({
          action: "ASSIGNMENT_REJECTED",
          entityType: "SHIFT_ASSIGNMENT",
          entityId: current.confirmation.assignmentId,
          actorUserId: ctx.user.id,
          actorRole: ctx.user.role,
          actorName: ctx.user.name ?? undefined,
          institutionId: current.confirmation.institutionId,
          shiftInstanceId: current.confirmation.shiftInstanceId,
          description: `Médico recusou plantão${input.reason ? `: ${input.reason}` : ""}`,
        }, { db: tx, strict: true });
        const externalSubjectBinding = await resolveApprovedExternalSubject(
          tx,
          current.original.userId,
        );
        await enqueueDutySync({
          confirmationId: current.confirmation.id,
          institutionId: current.shift.institutionId,
          shiftInstanceId: current.shift.id,
          targetUserId: current.original.userId,
          ...externalSubjectBinding,
          shiftSnapshot: dutyShiftSnapshot(current.shift),
          action: "WITHDRAW",
          confirmationStatus: "DECLINED",
          expectedStatuses: [
            "DECLINED",
            "NOMINATED",
            "REPLACEMENT_DECLINED",
            "REPLACEMENT_CONFIRMED",
          ],
          dutyType: current.shift.modality === "SOBREAVISO" ? "SOBREAVISO" : "PLANTAO",
          serviceName: current.shift.specialty,
          dedupKey: `duty-confirmation:${current.confirmation.id}:duty-sync:withdraw:${current.original.userId}`,
        }, new Date(), tx);
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
      const [candidateSnapshot] = await db
        .select({ id: professionals.id, userId: professionals.userId })
        .from(professionals)
        .where(eq(professionals.id, input.replacementProfessionalId))
        .limit(1);
      if (!candidateSnapshot) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profissional substituto não encontrado nesta instituição",
        });
      }
      // Reset recheck timer: +30min for replacement to respond
      const newRecheckAt = new Date(Date.now() + 30 * 60 * 1000);

      const { replacement, pushIntent } = await db.transaction(async (tx) => {
        const current = await requireValidDutyConfirmation(tx, conf.id, {
          allowedStatuses: ["DECLINED"],
          expectedActor: {
            kind: "ORIGINAL",
            userId: ctx.user.id,
            sessionVersion: ctx.user.sessionVersion,
          },
          expectedInstitutionId: ctx.institutionId,
          additionalAuthorityTargets: [{
            professionalId: candidateSnapshot.id,
            userId: candidateSnapshot.userId,
            requireAccess: true,
          }],
          lockForUpdate: true,
        });
        // O vínculo e o acesso do indicado são reavaliados na mesma
        // transação do CAS. Quem perde uma indicação concorrente não pode
        // chegar aos efeitos externos abaixo.
        // A autoridade do candidato já foi travada por
        // additionalAuthorityTargets. Esta releitura simples e corrente evita
        // reutilizar nome/especialidade de um snapshot RR anterior ao mutex.
        const candidateQuery = tx
          .select({
            id: professionals.id,
            userId: professionals.userId,
            name: professionals.name,
            specialty: professionals.specialty,
          })
          .from(professionals)
          .where(
            and(
              eq(professionals.id, candidateSnapshot.id),
              eq(professionals.userId, candidateSnapshot.userId),
            ),
          )
          .limit(1)
          .for("update");
        const [candidate] = await candidateQuery;

        if (!candidate) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Profissional substituto não encontrado nesta instituição",
          });
        }
        if (
          candidate.id === current.original.professionalId ||
          candidate.userId === current.original.userId
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "O titular não pode indicar a si próprio como substituto",
          });
        }

        assertSpecialtyCompatible(current.shift.specialty, candidate.specialty);
        await transitionDutyConfirmation(tx, {
          kind: "NOMINATE",
          ...dutyConfirmationCasIdentity(current.confirmation),
          expectedStatus: "DECLINED",
          replacementProfessionalId: candidate.id,
          replacementUserId: candidate.userId,
          recheckAt: newRecheckAt,
        });

        const TZ = "America/Sao_Paulo";
        const startTime = new Date(current.shift.startAt).toLocaleTimeString("pt-BR", {
          hour: "2-digit", minute: "2-digit", timeZone: TZ,
        });
        const endTime = new Date(current.shift.endAt).toLocaleTimeString("pt-BR", {
          hour: "2-digit", minute: "2-digit", timeZone: TZ,
        });
        const intent: TrackedPushInput = {
          institutionId: current.shift.institutionId,
          userId: candidate.userId,
          shiftInstanceId: current.shift.id,
          dedupKey: `duty-confirmation:${current.confirmation.id}:nomination:${candidate.userId}`,
          payload: {
            title: "Plantão disponível para você",
            body: `${ctx.user.name ?? "Um colega"} indicou você para o plantão ${current.shift.label} (${startTime}–${endTime}). Aceita?`,
            data: {
              type: "duty_nomination",
              confirmationId: current.confirmation.id,
              confirmationToken: current.confirmation.confirmationToken,
              institutionId: current.shift.institutionId,
              shiftInstanceId: current.shift.id,
            },
          },
          authority: {
            kind: "DUTY_CONFIRMATION",
            purpose: "NOMINATION_REQUEST",
            confirmationId: current.confirmation.id,
            allowedStatuses: ["NOMINATED"],
            recipientKind: "REPLACEMENT",
            expectedUserId: candidate.userId,
            shiftSnapshot: dutyShiftSnapshot(current.shift),
          },
        };
        await enqueueTrackedPushNotification(intent, new Date(), tx);
        await recordAudit({
          action: "TRANSFER_OFFERED",
          entityType: "SHIFT_ASSIGNMENT",
          entityId: current.confirmation.assignmentId,
          actorUserId: ctx.user.id,
          actorRole: ctx.user.role,
          actorName: ctx.user.name ?? undefined,
          institutionId: current.confirmation.institutionId,
          shiftInstanceId: current.confirmation.shiftInstanceId,
          toProfessionalId: candidate.id,
          toUserId: candidate.userId,
          description: `Indicou ${candidate.name} como substituto`,
        }, { db: tx, strict: true });
        return { replacement: candidate, pushIntent: intent };
      });

      await sendTrackedPushNotification(pushIntent).catch(() =>
        console.error(`[Confirmation] NOMINATION_PUSH_IMMEDIATE_FAILED confirmation=${pushIntent.authority?.confirmationId}`),
      );

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
      // Realocação é a mesma operação de uma cessão: transação, alocação
      // de origem ainda ativa, mês não trancado e status do turno
      // derivado (auditoria 22/08 parte 2).
      const pushIntent = await db.transaction(async (tx) => {
        await assertMonthNotLockedForUpdate(
          tx,
          valid.shift.institutionId,
          valid.shift.hospitalId,
          valid.shift.startAt,
        );
        const current = await requireValidDutyConfirmation(tx, conf.id, {
          allowedStatuses: ["NOMINATED"],
          expectedActor: {
            kind: "REPLACEMENT",
            userId: ctx.user.id,
            sessionVersion: ctx.user.sessionVersion,
          },
          expectedInstitutionId: ctx.institutionId,
          requireOriginalAssignmentActive: false,
          requireReplacementMembership: true,
          lockForUpdate: true,
        });
        if (
          current.shift.institutionId !== valid.shift.institutionId ||
          current.shift.hospitalId !== valid.shift.hospitalId ||
          current.shift.sectorId !== valid.shift.sectorId ||
          current.shift.startAt.getTime() !== valid.shift.startAt.getTime()
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "O plantão mudou durante o aceite; atualize a tela e tente novamente.",
          });
        }
        if (!current.original.isActive) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A alocação original já foi alterada — esta indicação não vale mais.",
          });
        }
        const replacementPro = current.replacement!;
        await assertAssignmentWritesAllowedForUpdate(tx, [{
          professionalId: replacementPro.professionalId,
          expectedUserId: replacementPro.userId,
          institutionId: current.shift.institutionId,
          hospitalId: current.shift.hospitalId,
          sectorId: current.shift.sectorId,
          startAt: current.shift.startAt,
          endAt: current.shift.endAt,
          requiredSpecialty: current.shift.specialty,
        }]);
        await assertShiftAssignmentCapacityForUpdate(tx, {
          shiftInstanceId: current.shift.id,
          institutionId: current.shift.institutionId,
          hospitalId: current.shift.hospitalId,
          sectorId: current.shift.sectorId,
          activeDelta: 0,
        });
        // O CAS conquista a indicação antes de tocar nas alocações. Se
        // qualquer escrita posterior falhar, a própria transação também
        // reverte a transição e não há efeito externo.
        await transitionDutyConfirmation(tx, {
          kind: "ACCEPT_NOMINATION",
          ...dutyConfirmationCasIdentity(current.confirmation),
          expectedStatus: "NOMINATED",
          expectedReplacementProfessionalId: replacementPro.professionalId,
          expectedReplacementUserId: replacementPro.userId,
          respondedAt: new Date(),
        });

        const [deactivated] = await tx
          .update(shiftAssignmentsV2)
          .set({ isActive: false })
          .where(and(eq(shiftAssignmentsV2.id, current.original.assignmentId!), eq(shiftAssignmentsV2.isActive, true)));
        if (!deactivated.affectedRows) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A alocação original já foi alterada — esta indicação não vale mais.",
          });
        }
        await tx.insert(shiftAssignmentsV2).values({
          shiftInstanceId: current.shift.id,
          institutionId: current.shift.institutionId,
          hospitalId: current.shift.hospitalId,
          sectorId: current.shift.sectorId,
          professionalId: replacementPro.professionalId,
          assignmentType: current.original.assignmentType,
          status: "OCUPADO",
          isActive: true,
          createdBy: ctx.user.id,
        });
        await recomputeShiftStatus(tx, current.shift.id);

        const intent: TrackedPushInput = {
          institutionId: current.shift.institutionId,
          userId: current.original.userId,
          shiftInstanceId: current.shift.id,
          dedupKey: `duty-confirmation:${current.confirmation.id}:replacement-accepted:${current.original.userId}`,
          payload: {
            title: "Substituto confirmado",
            body: `${ctx.user.name ?? "O substituto"} aceitou seu plantão.`,
            data: {
              type: "replacement_accepted",
              confirmationId: current.confirmation.id,
              institutionId: current.shift.institutionId,
              shiftInstanceId: current.shift.id,
            },
          },
          authority: {
            kind: "DUTY_CONFIRMATION",
            purpose: "REPLACEMENT_ACCEPTED_NOTICE",
            confirmationId: current.confirmation.id,
            allowedStatuses: ["REPLACEMENT_CONFIRMED"],
            recipientKind: "ORIGINAL",
            expectedUserId: current.original.userId,
            shiftSnapshot: dutyShiftSnapshot(current.shift),
          },
        };
        await enqueueTrackedPushNotification(intent, new Date(), tx);
        await recordAudit({
          action: "TRANSFER_ACCEPTED",
          entityType: "SHIFT_ASSIGNMENT",
          entityId: current.confirmation.assignmentId,
          actorUserId: ctx.user.id,
          actorRole: ctx.user.role,
          actorName: ctx.user.name ?? undefined,
          institutionId: current.confirmation.institutionId,
          shiftInstanceId: current.confirmation.shiftInstanceId,
          fromProfessionalId: current.confirmation.professionalId,
          fromUserId: current.confirmation.userId,
          toProfessionalId: replacementPro.professionalId,
          toUserId: replacementPro.userId,
          description: "Substituto aceitou o plantão",
        }, { db: tx, strict: true });
        const externalSubjectBinding = await resolveApprovedExternalSubject(
          tx,
          replacementPro.userId,
        );
        await enqueueDutySync({
          confirmationId: current.confirmation.id,
          institutionId: current.shift.institutionId,
          shiftInstanceId: current.shift.id,
          targetUserId: replacementPro.userId,
          ...externalSubjectBinding,
          shiftSnapshot: dutyShiftSnapshot(current.shift),
          action: "CONFIRM",
          confirmationStatus: "REPLACEMENT_CONFIRMED",
          expectedStatuses: ["REPLACEMENT_CONFIRMED"],
          dutyType: current.shift.modality === "SOBREAVISO" ? "SOBREAVISO" : "PLANTAO",
          serviceName: current.shift.specialty,
          dedupKey: `duty-confirmation:${current.confirmation.id}:duty-sync:replacement-confirmed:${replacementPro.userId}`,
        }, new Date(), tx);
        await enqueueAutoSsoPush(current.confirmation.id, new Date(), tx);
        return intent;
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

      // Auto-SSO for replacement → Comunica+ (fire-and-forget)
      triggerAutoSso(conf.id).catch(() =>
        console.error(`[Confirmation] REPLACEMENT_AUTO_SSO_FAILED confirmation=${conf.id}`),
      );
      await sendTrackedPushNotification(pushIntent).catch(() =>
        console.error(`[Confirmation] ACCEPTANCE_PUSH_IMMEDIATE_FAILED confirmation=${pushIntent.authority?.confirmationId}`),
      );

      return { ok: true, status: "REPLACEMENT_CONFIRMED" as const };
    }),

  /**
   * Substituto recusa a indicação.
   * Encerra esta indicação e agenda escalação imediata ao gestor. Silêncio
   * ou recusa nunca confirmam presença nem alteram a escala.
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
      // A recusa encerra esta oferta. O cron usa o prazo já vencido apenas
      // para disparar a verificação humana, sem promover presença.
      const escalateAt = new Date();
      const pushIntent = await db.transaction(async (tx) => {
        const current = await requireValidDutyConfirmation(tx, conf.id, {
          allowedStatuses: ["NOMINATED"],
          expectedActor: {
            kind: "REPLACEMENT",
            userId: ctx.user.id,
            sessionVersion: ctx.user.sessionVersion,
          },
          expectedInstitutionId: ctx.institutionId,
          requireReplacementMembership: true,
          lockForUpdate: true,
        });
        await transitionDutyConfirmation(tx, {
          kind: "DECLINE_NOMINATION",
          ...dutyConfirmationCasIdentity(current.confirmation),
          expectedStatus: "NOMINATED",
          expectedReplacementProfessionalId: current.replacement!.professionalId,
          expectedReplacementUserId: current.replacement!.userId,
          respondedAt: escalateAt,
          recheckAt: escalateAt,
        });

        const intent: TrackedPushInput = {
          institutionId: current.shift.institutionId,
          userId: current.original.userId,
          shiftInstanceId: current.shift.id,
          dedupKey: `duty-confirmation:${current.confirmation.id}:replacement-declined:${current.original.userId}`,
          payload: {
            title: "Substituto recusou",
            body: "O substituto indicado não aceitou o plantão. A presença não foi confirmada; o gestor deve verificar a cobertura.",
            data: {
              type: "replacement_declined",
              confirmationId: current.confirmation.id,
              institutionId: current.shift.institutionId,
              shiftInstanceId: current.shift.id,
            },
          },
          authority: {
            kind: "DUTY_CONFIRMATION",
            purpose: "REPLACEMENT_DECLINED_NOTICE",
            confirmationId: current.confirmation.id,
            allowedStatuses: ["REPLACEMENT_DECLINED"],
            recipientKind: "ORIGINAL",
            expectedUserId: current.original.userId,
            shiftSnapshot: dutyShiftSnapshot(current.shift),
          },
        };
        await enqueueTrackedPushNotification(intent, escalateAt, tx);
        await recordAudit({
          action: "TRANSFER_REJECTED",
          entityType: "SHIFT_ASSIGNMENT",
          entityId: current.confirmation.assignmentId,
          actorUserId: ctx.user.id,
          actorRole: ctx.user.role,
          actorName: ctx.user.name ?? undefined,
          institutionId: current.confirmation.institutionId,
          shiftInstanceId: current.confirmation.shiftInstanceId,
          fromProfessionalId: current.confirmation.professionalId,
          fromUserId: current.confirmation.userId,
          toProfessionalId: current.replacement!.professionalId,
          toUserId: current.replacement!.userId,
          description: "Substituto recusou o plantão indicado",
        }, { db: tx, strict: true });
        return intent;
      });

      await sendTrackedPushNotification(pushIntent).catch(() =>
        console.error(`[Confirmation] DECLINE_PUSH_IMMEDIATE_FAILED confirmation=${pushIntent.authority?.confirmationId}`),
      );

      return { ok: true };
    }),
});
