import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
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
export async function rearmDutyConfirmationsAfterShiftWindowChange(
  tx: ConfirmationLifecycleTx,
  input: {
    institutionId: number;
    shiftInstanceId: number;
    assignmentIds: readonly number[];
  },
): Promise<number> {
  const assignmentIds = [...new Set(input.assignmentIds)].sort(
    (left, right) => left - right,
  );
  if (assignmentIds.length === 0) return 0;

  const snapshots = await tx
    .select({
      id: dutyConfirmations.id,
      assignmentId: dutyConfirmations.assignmentId,
      status: dutyConfirmations.status,
      confirmationToken: dutyConfirmations.confirmationToken,
    })
    .from(dutyConfirmations)
    .where(
      and(
        eq(dutyConfirmations.institutionId, input.institutionId),
        eq(dutyConfirmations.shiftInstanceId, input.shiftInstanceId),
        inArray(dutyConfirmations.assignmentId, assignmentIds),
      ),
    )
    .orderBy(dutyConfirmations.id);

  for (const snapshot of snapshots) {
    await requireValidDutyConfirmation(tx, snapshot.id, {
      allowedStatuses: [snapshot.status],
      expectedInstitutionId: input.institutionId,
      requireOriginalAssignmentActive: true,
      lockForUpdate: true,
    });
    const [updated] = await tx
      .update(dutyConfirmations)
      .set({
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
