import { and, eq } from "drizzle-orm";
import { professionalInstitutions } from "../drizzle/schema";
import {
  createOperationalEventInTransaction,
  type CreateOperationalEventInput,
  type OperationalEventActor,
  type OperationalEventRecipient,
  type OperationalEventTx,
  type OperationalRecipientResolution,
} from "./operational-events";

export const SCHEDULE_INVITE_SHADOW_EVENT_TYPES = [
  "SCHEDULE_INVITE_CREATED",
  "SCHEDULE_INVITE_ACCEPTED",
  "SCHEDULE_INVITE_REVOKED",
] as const;

export type ScheduleInviteShadowEventType =
  (typeof SCHEDULE_INVITE_SHADOW_EVENT_TYPES)[number];

export type ScheduleInviteOperationalActor = Extract<
  OperationalEventActor,
  { kind: "USER" }
>;

/** Snapshot obtido sob lock pelo writer imediatamente após a transição. */
export type ScheduleInviteOperationalSnapshot = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  operationalRevision: number;
  createdByUserId: number;
  invitedUserId: number | null;
};

type EventDefinition = {
  deliveryPolicy: CreateOperationalEventInput["deliveryPolicy"];
  transition: NonNullable<CreateOperationalEventInput["transition"]>;
};

const EVENT_DEFINITIONS: Record<
  ScheduleInviteShadowEventType,
  EventDefinition
> = {
  SCHEDULE_INVITE_CREATED: {
    deliveryPolicy: "NOTIFY",
    transition: { from: null, to: "PENDING" },
  },
  SCHEDULE_INVITE_ACCEPTED: {
    deliveryPolicy: "NOTIFY",
    transition: { from: "PENDING", to: "ACCEPTED" },
  },
  SCHEDULE_INVITE_REVOKED: {
    deliveryPolicy: "SILENT_AUDITED",
    transition: { from: "PENDING", to: "REVOKED" },
  },
};

function assertSnapshot(
  snapshot: ScheduleInviteOperationalSnapshot,
  options?: { requiresInvitedUser?: boolean },
): void {
  for (const [label, value] of Object.entries({
    "invite.id": snapshot.id,
    "invite.institutionId": snapshot.institutionId,
    "invite.hospitalId": snapshot.hospitalId,
    "invite.sectorId": snapshot.sectorId,
    "invite.createdByUserId": snapshot.createdByUserId,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} inválido para evento operacional de convite`);
    }
  }
  if (
    !Number.isSafeInteger(snapshot.operationalRevision) ||
    snapshot.operationalRevision <= 0
  ) {
    throw new Error(
      "invite.operationalRevision deve ser uma revisão positiva para emitir evento",
    );
  }
  if (
    options?.requiresInvitedUser &&
    (!Number.isSafeInteger(snapshot.invitedUserId) ||
      (snapshot.invitedUserId as number) <= 0)
  ) {
    throw new Error(
      "invite.invitedUserId é obrigatório para o evento operacional nominal",
    );
  }
}

function eventInput(input: {
  eventType: ScheduleInviteShadowEventType;
  snapshot: ScheduleInviteOperationalSnapshot;
  actor: ScheduleInviteOperationalActor;
  recipients: CreateOperationalEventInput["recipients"];
  recipientResolution?: OperationalRecipientResolution;
  occurredAt: Date;
}): CreateOperationalEventInput {
  assertSnapshot(input.snapshot, {
    requiresInvitedUser: input.eventType !== "SCHEDULE_INVITE_REVOKED",
  });
  const definition = EVENT_DEFINITIONS[input.eventType];
  return {
    idempotencyKey: `schedule-invite:${input.snapshot.id}:revision:${input.snapshot.operationalRevision}:${input.eventType}`,
    eventType: input.eventType,
    deliveryPolicy: definition.deliveryPolicy,
    aggregate: {
      type: "SCHEDULE_INVITE",
      id: input.snapshot.id,
      version: input.snapshot.operationalRevision,
    },
    transition: definition.transition,
    context: {
      institutionId: input.snapshot.institutionId,
      hospitalId: input.snapshot.hospitalId,
      scopeKind: "SECTOR",
      sectorId: input.snapshot.sectorId,
    },
    actor: input.actor,
    recipients: input.recipients,
    ...(input.recipientResolution === undefined
      ? {}
      : { recipientResolution: input.recipientResolution }),
    occurredAt: input.occurredAt,
  };
}

async function hasActiveInstitutionMembership(
  tx: OperationalEventTx,
  institutionId: number,
  userId: number,
): Promise<boolean> {
  const [membership] = await tx
    .select({ id: professionalInstitutions.id })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1)
    .for("update");
  return Boolean(membership);
}

/**
 * O convite é o alvo canônico do e-mail. Push só aparece como destinatário
 * USER quando o convidado já tem vínculo institucional ativo; assim o fato
 * não cria acesso nem presume dispositivo a partir do endereço de e-mail.
 */
export async function recordScheduleInviteCreatedInTransaction(
  tx: OperationalEventTx,
  input: {
    snapshot: ScheduleInviteOperationalSnapshot;
    actor: ScheduleInviteOperationalActor;
    occurredAt: Date;
  },
) {
  if (!input.snapshot.invitedUserId) {
    throw new Error("Criação canônica exige convite nominal");
  }
  const recipients: OperationalEventRecipient[] = [
    {
      kind: "SCHEDULE_INVITE",
      scheduleInviteId: input.snapshot.id,
      channels: ["EMAIL"],
    },
  ];
  if (
    await hasActiveInstitutionMembership(
      tx,
      input.snapshot.institutionId,
      input.snapshot.invitedUserId,
    )
  ) {
    recipients.push({
      kind: "USER",
      userId: input.snapshot.invitedUserId,
      channels: ["PUSH"],
    });
  }
  return createOperationalEventInTransaction(
    tx,
    eventInput({
      eventType: "SCHEDULE_INVITE_CREATED",
      snapshot: input.snapshot,
      actor: input.actor,
      recipients,
      occurredAt: input.occurredAt,
    }),
  );
}

/**
 * Após o aceite, o emissor só permanece destinatário se seu vínculo ainda
 * estiver ativo e ele não for o próprio ator. A ausência não bloqueia a
 * entrada do médico: o fato fica auditado com causa explícita, sem criar uma
 * entrega para um escopo revogado ou para o único envolvido.
 */
export async function recordScheduleInviteAcceptedInTransaction(
  tx: OperationalEventTx,
  input: {
    snapshot: ScheduleInviteOperationalSnapshot;
    actor: ScheduleInviteOperationalActor;
    occurredAt: Date;
  },
) {
  if (!input.snapshot.invitedUserId) {
    throw new Error("Aceite canônico exige convite nominal");
  }
  const creatorIsActor = input.snapshot.createdByUserId === input.actor.userId;
  const canNotifyCreator =
    !creatorIsActor &&
    (await hasActiveInstitutionMembership(
      tx,
      input.snapshot.institutionId,
      input.snapshot.createdByUserId,
    ));
  const emptyRecipientResolution: OperationalRecipientResolution = creatorIsActor
    ? "NO_ELIGIBLE_RECIPIENTS"
    : "NO_DELIVERABLE_RECIPIENTS";
  return createOperationalEventInTransaction(
    tx,
    eventInput({
      eventType: "SCHEDULE_INVITE_ACCEPTED",
      snapshot: input.snapshot,
      actor: input.actor,
      recipients: canNotifyCreator
        ? [
            {
              kind: "USER",
              userId: input.snapshot.createdByUserId,
              channels: ["PUSH", "EMAIL"],
            },
          ]
        : [],
      ...(canNotifyCreator
        ? {}
        : {
            recipientResolution: emptyRecipientResolution,
          }),
      occurredAt: input.occurredAt,
    }),
  );
}

/** Revogação é fato auditado sem destinatário nesta etapa. */
export async function recordScheduleInviteRevokedInTransaction(
  tx: OperationalEventTx,
  input: {
    snapshot: ScheduleInviteOperationalSnapshot;
    actor: ScheduleInviteOperationalActor;
    occurredAt: Date;
  },
) {
  return createOperationalEventInTransaction(
    tx,
    eventInput({
      eventType: "SCHEDULE_INVITE_REVOKED",
      snapshot: input.snapshot,
      actor: input.actor,
      recipients: [],
      recipientResolution: "NOT_APPLICABLE",
      occurredAt: input.occurredAt,
    }),
  );
}
