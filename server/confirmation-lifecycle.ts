import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { dutyConfirmations } from "../drizzle/schema";
import type { getDb } from "./db";
import { requireValidDutyConfirmation } from "./confirmation-integrity";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ConfirmationLifecycleTx = Pick<Db, "select" | "update">;

/**
 * Rearma confirmações ligadas às alocações que continuam ativas depois de
 * uma mudança no intervalo do plantão. O chamador já mantém os locks de mês,
 * turno e alocação; a validação canônica conserva essa mesma ordem antes de
 * bloquear a confirmação e a identidade.
 *
 * `recheckAt = null` é o marcador durável de ciclo ainda não materializado.
 * O dispatcher só gera a nova solicitação quando o horário alterado voltar a
 * ficar due. Girar o token revoga deep links e outboxes do intervalo anterior.
 */
export async function rearmDutyConfirmationsAfterShiftChange(
  tx: ConfirmationLifecycleTx,
  input: {
    institutionId: number;
    shiftInstanceId: number;
    activeAssignments: readonly {
      id: number;
      professionalId: number;
    }[];
  },
): Promise<number> {
  const activeAssignmentIds = new Set(
    input.activeAssignments.map((assignment) => assignment.id),
  );
  const activeProfessionalIds = new Set(
    input.activeAssignments.map((assignment) => assignment.professionalId),
  );
  if (activeAssignmentIds.size === 0) return 0;

  const shiftSnapshots = await tx
    .select({
      id: dutyConfirmations.id,
      assignmentId: dutyConfirmations.assignmentId,
      status: dutyConfirmations.status,
      confirmationToken: dutyConfirmations.confirmationToken,
      replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
      replacementUserId: dutyConfirmations.replacementUserId,
    })
    .from(dutyConfirmations)
    .where(
      and(
        eq(dutyConfirmations.institutionId, input.institutionId),
        eq(dutyConfirmations.shiftInstanceId, input.shiftInstanceId),
      ),
    )
    .orderBy(dutyConfirmations.id);

  const snapshots = shiftSnapshots.filter(
    (snapshot) =>
      activeAssignmentIds.has(snapshot.assignmentId) ||
      (snapshot.status === "REPLACEMENT_CONFIRMED" &&
        snapshot.replacementProfessionalId !== null &&
        activeProfessionalIds.has(snapshot.replacementProfessionalId)),
  );

  for (const snapshot of snapshots) {
    const replacementCycle =
      snapshot.status === "REPLACEMENT_CONFIRMED" &&
      snapshot.replacementProfessionalId !== null &&
      activeProfessionalIds.has(snapshot.replacementProfessionalId);
    const current = await requireValidDutyConfirmation(tx, snapshot.id, {
      allowedStatuses: [snapshot.status],
      expectedInstitutionId: input.institutionId,
      requireOriginalAssignmentActive: !replacementCycle,
      requireEffectiveAssignment: replacementCycle,
      lockForUpdate: true,
    });
    const effective = current.effective;
    if (effective.assignmentId === null) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A alocação efetiva da confirmação não foi encontrada.",
      });
    }
    const [updated] = await tx
      .update(dutyConfirmations)
      .set({
        // A linha é o ciclo vivo da alocação, não o registro histórico da
        // transferência. Ao aceitar um substituto, a auditoria já preserva
        // titular e substituto; no rearme, a identidade canônica passa a ser
        // exatamente a assignment ativa que deverá reconfirmar o novo turno.
        assignmentId: effective.assignmentId,
        professionalId: effective.professionalId,
        userId: effective.userId,
        status: "PENDING",
        replacementProfessionalId: null,
        replacementUserId: null,
        notifiedAt: null,
        respondedAt: null,
        recheckAt: null,
        autoConfirmedAt: null,
        ssoTriggeredAt: null,
        confirmationToken: randomUUID(),
        declineReason: null,
        managerNotified: false,
        startPushSentAt: null,
      })
      .where(
        and(
          eq(dutyConfirmations.id, snapshot.id),
          eq(dutyConfirmations.institutionId, input.institutionId),
          eq(dutyConfirmations.shiftInstanceId, input.shiftInstanceId),
          eq(dutyConfirmations.assignmentId, snapshot.assignmentId),
          eq(dutyConfirmations.status, snapshot.status),
          eq(dutyConfirmations.confirmationToken, snapshot.confirmationToken),
          snapshot.replacementProfessionalId === null
            ? isNull(dutyConfirmations.replacementProfessionalId)
            : eq(
                dutyConfirmations.replacementProfessionalId,
                snapshot.replacementProfessionalId,
              ),
          snapshot.replacementUserId === null
            ? isNull(dutyConfirmations.replacementUserId)
            : eq(
                dutyConfirmations.replacementUserId,
                snapshot.replacementUserId,
              ),
        ),
      );
    if (updated.affectedRows !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A confirmação mudou enquanto o novo horário era processado.",
      });
    }
  }

  return snapshots.length;
}
