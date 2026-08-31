import { TRPCError } from "@trpc/server";
import { and, eq, isNull, lte, type SQL } from "drizzle-orm";
import { dutyConfirmations } from "../drizzle/schema";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type DutyConfirmationTransitionTx = Pick<Db, "update">;
export type DutyConfirmationStatus = typeof dutyConfirmations.$inferSelect.status;

export type DutyConfirmationCasIdentity = Readonly<{
  confirmationId: number;
  expectedInstitutionId: number;
  expectedShiftInstanceId: number;
  expectedAssignmentId: number;
  expectedProfessionalId: number;
  expectedOriginalUserId: number;
}>;

type PendingCommandBase = DutyConfirmationCasIdentity & {
  expectedStatus: "PENDING";
  respondedAt: Date;
};

type DeclineCommandBase = DutyConfirmationCasIdentity & {
  expectedStatus: "PENDING" | "CONFIRMED";
  respondedAt: Date;
};

type NominatedCommandBase = DutyConfirmationCasIdentity & {
  expectedStatus: "NOMINATED";
  expectedReplacementProfessionalId: number;
  expectedReplacementUserId: number;
};

export type DutyConfirmationTransitionCommand =
  | (PendingCommandBase & {
      kind: "CONFIRM";
    })
  | (DeclineCommandBase & {
      kind: "DECLINE";
      declineReason: string | null;
      recheckAt: Date;
    })
  | (DutyConfirmationCasIdentity & {
      kind: "NOMINATE";
      expectedStatus: "DECLINED";
      replacementProfessionalId: number;
      replacementUserId: number;
      recheckAt: Date;
    })
  | (NominatedCommandBase & {
      kind: "ACCEPT_NOMINATION";
      respondedAt: Date;
    })
  | (NominatedCommandBase & {
      kind: "DECLINE_NOMINATION";
      respondedAt: Date;
      recheckAt: Date;
    });

export const DUTY_CONFIRMATION_TRANSITIONS = {
  PENDING: ["CONFIRMED", "DECLINED"],
  // Desistência após confirmar: reutiliza DECLINED. Sem estado novo.
  CONFIRMED: ["DECLINED"],
  DECLINED: ["NOMINATED"],
  NOMINATED: ["REPLACEMENT_CONFIRMED", "REPLACEMENT_DECLINED"],
  REPLACEMENT_CONFIRMED: [],
  REPLACEMENT_DECLINED: [],
  // Legado somente para leitura. Silêncio ou falha de push não têm mais
  // autoridade para produzir este estado.
  AUTO_CONFIRMED: [],
} as const satisfies Record<DutyConfirmationStatus, readonly DutyConfirmationStatus[]>;

export function isAllowedDutyConfirmationTransition(
  from: DutyConfirmationStatus,
  to: DutyConfirmationStatus,
): boolean {
  return (DUTY_CONFIRMATION_TRANSITIONS[from] as readonly DutyConfirmationStatus[]).includes(to);
}

export function dutyConfirmationCasIdentity(
  confirmation: Pick<
    typeof dutyConfirmations.$inferSelect,
    "id" | "institutionId" | "shiftInstanceId" | "assignmentId" | "professionalId" | "userId"
  >,
): DutyConfirmationCasIdentity {
  return {
    confirmationId: confirmation.id,
    expectedInstitutionId: confirmation.institutionId,
    expectedShiftInstanceId: confirmation.shiftInstanceId,
    expectedAssignmentId: confirmation.assignmentId,
    expectedProfessionalId: confirmation.professionalId,
    expectedOriginalUserId: confirmation.userId,
  };
}

type TransitionPlan = {
  from: DutyConfirmationStatus;
  to: DutyConfirmationStatus;
  values: Partial<typeof dutyConfirmations.$inferInsert> & { status: DutyConfirmationStatus };
  extraPredicates: SQL[];
};

function planTransition(command: DutyConfirmationTransitionCommand): TransitionPlan {
  switch (command.kind) {
    case "CONFIRM":
      return {
        from: command.expectedStatus,
        to: "CONFIRMED",
        values: {
          status: "CONFIRMED",
          respondedAt: command.respondedAt,
        },
        extraPredicates: [],
      };
    case "DECLINE":
      return {
        from: command.expectedStatus,
        to: "DECLINED",
        values: {
          status: "DECLINED",
          respondedAt: command.respondedAt,
          declineReason: command.declineReason,
          recheckAt: command.recheckAt,
          managerNotified: false,
        },
        extraPredicates: [],
      };
    case "NOMINATE":
      return {
        from: command.expectedStatus,
        to: "NOMINATED",
        values: {
          status: "NOMINATED",
          replacementProfessionalId: command.replacementProfessionalId,
          replacementUserId: command.replacementUserId,
          recheckAt: command.recheckAt,
          managerNotified: false,
        },
        // DECLINED é a primeira recusa do titular. Metadados de indicação
        // pré-existentes tornam a linha ambígua e devem falhar fechados.
        extraPredicates: [
          isNull(dutyConfirmations.replacementProfessionalId),
          isNull(dutyConfirmations.replacementUserId),
        ],
      };
    case "ACCEPT_NOMINATION":
      return {
        from: command.expectedStatus,
        to: "REPLACEMENT_CONFIRMED",
        values: {
          status: "REPLACEMENT_CONFIRMED",
          respondedAt: command.respondedAt,
        },
        extraPredicates: [
          eq(
            dutyConfirmations.replacementProfessionalId,
            command.expectedReplacementProfessionalId,
          ),
          eq(dutyConfirmations.replacementUserId, command.expectedReplacementUserId),
        ],
      };
    case "DECLINE_NOMINATION":
      return {
        from: command.expectedStatus,
        to: "REPLACEMENT_DECLINED",
        values: {
          status: "REPLACEMENT_DECLINED",
          // Preserva quem recusou. Apagar estes IDs destruía a linhagem
          // institucional e fazia respondedAt continuar apontando para a
          // recusa anterior do titular.
          respondedAt: command.respondedAt,
          recheckAt: command.recheckAt,
          managerNotified: false,
        },
        extraPredicates: [
          eq(
            dutyConfirmations.replacementProfessionalId,
            command.expectedReplacementProfessionalId,
          ),
          eq(dutyConfirmations.replacementUserId, command.expectedReplacementUserId),
        ],
      };
  }
}

function identityPredicates(identity: DutyConfirmationCasIdentity): SQL[] {
  return [
    eq(dutyConfirmations.id, identity.confirmationId),
    eq(dutyConfirmations.institutionId, identity.expectedInstitutionId),
    eq(dutyConfirmations.shiftInstanceId, identity.expectedShiftInstanceId),
    eq(dutyConfirmations.assignmentId, identity.expectedAssignmentId),
    eq(dutyConfirmations.professionalId, identity.expectedProfessionalId),
    eq(dutyConfirmations.userId, identity.expectedOriginalUserId),
  ];
}

/**
 * Único ponto autorizado a mudar o estado de duty_confirmations.
 *
 * O UPDATE compara estado, identidade canônica e invariantes específicas da
 * transição. affectedRows=0 é sempre conflito: nenhum caller pode inferir
 * sucesso a partir de um snapshot vencido.
 */
export async function transitionDutyConfirmation(
  tx: DutyConfirmationTransitionTx,
  command: DutyConfirmationTransitionCommand,
): Promise<{ from: DutyConfirmationStatus; to: DutyConfirmationStatus }> {
  const plan = planTransition(command);
  if (!isAllowedDutyConfirmationTransition(plan.from, plan.to)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Transição de confirmação não permitida: ${plan.from} → ${plan.to}`,
    });
  }

  const [result] = await tx
    .update(dutyConfirmations)
    .set(plan.values)
    .where(
      and(
        ...identityPredicates(command),
        eq(dutyConfirmations.status, plan.from),
        ...plan.extraPredicates,
      ),
    );

  if (result.affectedRows !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Esta confirmação foi alterada por outra ação. Atualize a tela e tente novamente.",
    });
  }

  return { from: plan.from, to: plan.to };
}

/**
 * Interface para o cron encerrar uma rechecagem inválida sem apagar um timer
 * que tenha sido renovado por uma ação concorrente.
 */
export async function clearDutyConfirmationRecheckIfCurrent(
  tx: DutyConfirmationTransitionTx,
  input: DutyConfirmationCasIdentity & {
    expectedStatus: "PENDING" | "DECLINED" | "NOMINATED" | "REPLACEMENT_DECLINED";
    expectedRecheckAt: Date;
    now: Date;
  },
): Promise<boolean> {
  const [result] = await tx
    .update(dutyConfirmations)
    .set({ recheckAt: null })
    .where(
      and(
        ...identityPredicates(input),
        eq(dutyConfirmations.status, input.expectedStatus),
        eq(dutyConfirmations.recheckAt, input.expectedRecheckAt),
        lte(dutyConfirmations.recheckAt, input.now),
      ),
    );

  return result.affectedRows === 1;
}
