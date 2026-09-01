import { and, eq, isNull } from "drizzle-orm";
import {
  professionalInstitutions,
  professionals,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import {
  createOperationalEventInTransaction,
  OperationalEventValidationError,
  type CreateOperationalEventInput,
  type OperationalEventActor,
  type OperationalEventRecipient,
  type OperationalEventTx,
  type OperationalRecipientResolution,
} from "./operational-events";
import { eligibleRecipientUserIdsForSwapOffer } from "./swap-offer-eligibility";

/**
 * Apenas transições globais cuja linha `swap_requests` já tem versão CAS.
 * `SWAP_OFFER_DISMISSED` continua fora: uma recusa individual de oferta
 * aberta mantém o agregado PENDING para os demais profissionais elegíveis.
 */
export const SWAP_LIFECYCLE_SHADOW_EVENT_TYPES = [
  "SWAP_OFFERED",
  "SWAP_ACCEPTED",
  "SWAP_REJECTED",
  "SWAP_CANCELLED",
] as const;

export type SwapLifecycleShadowEventType =
  (typeof SWAP_LIFECYCLE_SHADOW_EVENT_TYPES)[number];

type SwapLifecyclePreviousStatus = "PENDING" | "ACCEPTED" | null;

export type SwapLifecycleOperationalActor = Readonly<{
  userId: number;
  professionalId: number;
}>;

export type SwapLifecycleOperationalSnapshot = Readonly<{
  id: number;
  version: number;
  status: (typeof swapRequests.$inferSelect)["status"];
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  fromProfessionalId: number;
  fromUserId: number;
  fromShiftInstanceId: number;
  fromAssignmentId: number;
  toProfessionalId: number | null;
  toUserId: number | null;
  scheduleContextId: number | null;
}>;

type CanonicalSwapLifecycleTransition = Readonly<{
  from: "PENDING" | "ACCEPTED" | null;
  to: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  aggregateStatus: (typeof swapRequests.$inferSelect)["status"];
}>;

function assertPositiveId(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new OperationalEventValidationError(
      `${label} deve ser um ID positivo`,
    );
  }
}

function assertVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new OperationalEventValidationError(
      `${label} deve ser uma versão positiva`,
    );
  }
}

function transitionForSwapLifecycleEvent(
  eventType: SwapLifecycleShadowEventType,
  previousStatus: SwapLifecyclePreviousStatus,
): CanonicalSwapLifecycleTransition {
  switch (eventType) {
    case "SWAP_OFFERED":
      if (previousStatus !== null) {
        throw new OperationalEventValidationError(
          "SWAP_OFFERED só pode partir da criação sem estado anterior",
        );
      }
      return { from: null, to: "PENDING", aggregateStatus: "PENDING" };
    case "SWAP_ACCEPTED":
      if (previousStatus !== "PENDING" && previousStatus !== "ACCEPTED") {
        throw new OperationalEventValidationError(
          "SWAP_ACCEPTED exige origem PENDING ou ACCEPTED",
        );
      }
      return {
        from: previousStatus,
        to: "APPROVED",
        aggregateStatus: "APPROVED",
      };
    case "SWAP_REJECTED":
      if (previousStatus !== "PENDING") {
        throw new OperationalEventValidationError(
          "SWAP_REJECTED exige origem PENDING",
        );
      }
      return {
        from: "PENDING",
        to: "REJECTED",
        aggregateStatus: "REJECTED_BY_PEER",
      };
    case "SWAP_CANCELLED":
      if (previousStatus !== "PENDING" && previousStatus !== "ACCEPTED") {
        throw new OperationalEventValidationError(
          "SWAP_CANCELLED exige origem PENDING ou ACCEPTED",
        );
      }
      return {
        from: previousStatus,
        to: "CANCELLED",
        aggregateStatus: "CANCELLED",
      };
  }
}

function assertSnapshot(
  snapshot: SwapLifecycleOperationalSnapshot,
  transition: CanonicalSwapLifecycleTransition,
  expectedVersion: number,
): void {
  for (const [label, value] of Object.entries({
    "swap.id": snapshot.id,
    "swap.institutionId": snapshot.institutionId,
    "swap.hospitalId": snapshot.hospitalId,
    "swap.sectorId": snapshot.sectorId,
    "swap.fromProfessionalId": snapshot.fromProfessionalId,
    "swap.fromUserId": snapshot.fromUserId,
    "swap.fromShiftInstanceId": snapshot.fromShiftInstanceId,
    "swap.fromAssignmentId": snapshot.fromAssignmentId,
  })) {
    assertPositiveId(value, label);
  }
  if (snapshot.scheduleContextId !== null) {
    assertPositiveId(snapshot.scheduleContextId, "swap.scheduleContextId");
  }
  assertVersion(snapshot.version, "swap.version");
  assertVersion(expectedVersion, "expectedVersion");
  if (snapshot.version !== expectedVersion) {
    throw new OperationalEventValidationError(
      "A versão canônica da troca diverge da transição emitida",
    );
  }
  if (snapshot.status !== transition.aggregateStatus) {
    throw new OperationalEventValidationError(
      "O status canônico da troca diverge da transição emitida",
    );
  }
  const hasCounterpartProfessional = snapshot.toProfessionalId !== null;
  const hasCounterpartUser = snapshot.toUserId !== null;
  if (hasCounterpartProfessional !== hasCounterpartUser) {
    throw new OperationalEventValidationError(
      "A troca possui identidade de contraparte incompleta",
    );
  }
}

/** A chave carrega fato, agregado e versão final CAS; nunca nomes ou e-mail. */
export function swapLifecycleShadowIdempotencyKey(input: {
  eventType: SwapLifecycleShadowEventType;
  swapId: number;
  version: number;
}): string {
  assertPositiveId(input.swapId, "swapId");
  assertVersion(input.version, "version");
  if (
    !(SWAP_LIFECYCLE_SHADOW_EVENT_TYPES as readonly string[]).includes(
      input.eventType,
    )
  ) {
    throw new OperationalEventValidationError(
      "Tipo de fato SHADOW de troca inválido",
    );
  }
  return [
    "swap-lifecycle-shadow",
    `swap:${input.swapId}`,
    `version:${input.version}`,
    `event:${input.eventType}`,
  ].join(":");
}

/**
 * Relê a fonte do fato sob lock. O evento não aceita contexto de turno ou
 * escala montado pelo cliente nem por campos textuais do writer.
 */
async function captureCanonicalSwapLifecycleSnapshot(
  tx: OperationalEventTx,
  input: { swapId: number; institutionId: number },
): Promise<SwapLifecycleOperationalSnapshot> {
  assertPositiveId(input.swapId, "swapId");
  assertPositiveId(input.institutionId, "institutionId");
  const [swap] = await tx
    .select()
    .from(swapRequests)
    .where(
      and(
        eq(swapRequests.id, input.swapId),
        eq(swapRequests.institutionId, input.institutionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!swap || swap.sectorId === null) {
    throw new OperationalEventValidationError(
      "Troca sem escopo setorial canônico não pode emitir fato operacional",
    );
  }

  const [source] = await tx
    .select({
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      shiftInstanceId: shiftInstances.id,
      assignmentId: shiftAssignmentsV2.id,
    })
    .from(shiftInstances)
    .innerJoin(
      shiftAssignmentsV2,
      and(
        eq(shiftAssignmentsV2.id, swap.fromAssignmentId),
        eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id),
        eq(shiftAssignmentsV2.institutionId, shiftInstances.institutionId),
        eq(shiftAssignmentsV2.hospitalId, shiftInstances.hospitalId),
        eq(shiftAssignmentsV2.sectorId, shiftInstances.sectorId),
        eq(shiftAssignmentsV2.professionalId, swap.fromProfessionalId),
      ),
    )
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, swap.fromProfessionalId),
        eq(professionals.userId, swap.fromUserId),
      ),
    )
    .where(
      and(
        eq(shiftInstances.id, swap.fromShiftInstanceId),
        eq(shiftInstances.institutionId, swap.institutionId),
        eq(shiftInstances.hospitalId, swap.hospitalId),
        eq(shiftInstances.sectorId, swap.sectorId),
      ),
    )
    .limit(1)
    .for("update");
  if (!source) {
    throw new OperationalEventValidationError(
      "Turno ou alocação de origem não pertence à troca canônica",
    );
  }

  return Object.freeze({
    id: swap.id,
    version: swap.version,
    status: swap.status,
    institutionId: source.institutionId,
    hospitalId: source.hospitalId,
    sectorId: source.sectorId,
    fromProfessionalId: swap.fromProfessionalId,
    fromUserId: swap.fromUserId,
    fromShiftInstanceId: source.shiftInstanceId,
    fromAssignmentId: source.assignmentId,
    toProfessionalId: swap.toProfessionalId,
    toUserId: swap.toUserId,
    scheduleContextId: source.scheduleContextId,
  });
}

async function resolveCanonicalSwapActor(
  tx: OperationalEventTx,
  input: SwapLifecycleOperationalActor & { institutionId: number },
): Promise<Extract<OperationalEventActor, { kind: "USER" }>> {
  assertPositiveId(input.userId, "actor.userId");
  assertPositiveId(input.professionalId, "actor.professionalId");
  assertPositiveId(input.institutionId, "actor.institutionId");
  const [membership] = await tx
    .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
    .from(professionalInstitutions)
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
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
      and(
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.userId, input.userId),
        eq(professionalInstitutions.professionalId, input.professionalId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1)
    .for("update");
  if (!membership) {
    throw new OperationalEventValidationError(
      "Ator da troca não possui vínculo institucional ativo canônico",
    );
  }
  return {
    kind: "USER",
    userId: input.userId,
    professionalId: input.professionalId,
    role: membership.roleInInstitution,
  };
}

type SwapParty = Readonly<{ userId: number; professionalId: number }>;

/**
 * Um destinatário sem vínculo ativo pode ficar sem entrega; já uma dupla
 * usuário-profissional que nunca correspondeu entre si é falha de topologia
 * e não pode virar um fato aparentemente válido com lista vazia.
 */
async function assertCanonicalCounterpartIdentity(
  tx: OperationalEventTx,
  party: SwapParty,
): Promise<void> {
  const [professional] = await tx
    .select({ id: professionals.id })
    .from(professionals)
    .where(
      and(
        eq(professionals.id, party.professionalId),
        eq(professionals.userId, party.userId),
      ),
    )
    .limit(1)
    .for("update");
  if (!professional) {
    throw new OperationalEventValidationError(
      "A contraparte da troca não possui identidade canônica",
    );
  }
}

function directSwapParties(
  snapshot: SwapLifecycleOperationalSnapshot,
  options: { requireCounterpart: boolean },
): readonly SwapParty[] {
  const parties: SwapParty[] = [
    {
      userId: snapshot.fromUserId,
      professionalId: snapshot.fromProfessionalId,
    },
  ];
  if (snapshot.toUserId === null && snapshot.toProfessionalId === null) {
    if (options.requireCounterpart) {
      throw new OperationalEventValidationError(
        "A transição global da troca exige contraparte canônica",
      );
    }
    return parties;
  }
  if (snapshot.toUserId === null || snapshot.toProfessionalId === null) {
    throw new OperationalEventValidationError(
      "A troca possui identidade de contraparte incompleta",
    );
  }
  parties.push({
    userId: snapshot.toUserId,
    professionalId: snapshot.toProfessionalId,
  });
  return parties;
}

async function isDeliverableSwapParty(
  tx: OperationalEventTx,
  institutionId: number,
  party: SwapParty,
): Promise<boolean> {
  const [membership] = await tx
    .select({ id: professionalInstitutions.id })
    .from(professionalInstitutions)
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
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
      and(
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.userId, party.userId),
        eq(professionalInstitutions.professionalId, party.professionalId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1)
    .for("update");
  return Boolean(membership);
}

async function resolveDeliverableDirectSwapRecipients(
  tx: OperationalEventTx,
  snapshot: SwapLifecycleOperationalSnapshot,
  options: { requireCounterpart: boolean },
): Promise<OperationalEventRecipient[]> {
  const recipients: OperationalEventRecipient[] = [];
  const seenUsers = new Set<number>();
  for (const party of directSwapParties(snapshot, options)) {
    if (seenUsers.has(party.userId)) continue;
    seenUsers.add(party.userId);
    if (
      party.professionalId !== snapshot.fromProfessionalId ||
      party.userId !== snapshot.fromUserId
    ) {
      await assertCanonicalCounterpartIdentity(tx, party);
    }
    if (!(await isDeliverableSwapParty(tx, snapshot.institutionId, party))) {
      continue;
    }
    recipients.push({
      kind: "USER",
      userId: party.userId,
      channels: ["PUSH", "EMAIL"],
    });
  }
  return recipients;
}

/**
 * Revalida o resultado da elegibilidade já canônica sob lock antes de o
 * transportar ao ledger. A lista de elegíveis continua pertencendo ao módulo
 * de swaps; esta frente não altera especialidade, ACL ou conflito de horário.
 */
async function resolveDeliverableOfferRecipients(
  tx: OperationalEventTx,
  snapshot: SwapLifecycleOperationalSnapshot,
): Promise<OperationalEventRecipient[]> {
  const userIds = await eligibleRecipientUserIdsForSwapOffer(tx, {
    id: snapshot.id,
    fromUserId: snapshot.fromUserId,
    toUserId: snapshot.toUserId,
    toProfessionalId: snapshot.toProfessionalId,
    institutionId: snapshot.institutionId,
  });
  const recipients: OperationalEventRecipient[] = [];
  // O SQL de elegibilidade só prova quem pode receber; não promete ordem.
  // Normalizamos antes dos FOR UPDATE para duas ofertas concorrentes não
  // bloquearem vínculos idênticos em ordens inversas.
  const normalizedUserIds = [
    ...new Set(
      userIds.filter(
        (userId): userId is number =>
          Number.isSafeInteger(userId) &&
          userId > 0 &&
          userId !== snapshot.fromUserId,
      ),
    ),
  ].sort((left, right) => left - right);
  for (const userId of normalizedUserIds) {
    const [membership] = await tx
      .select({ id: professionalInstitutions.id })
      .from(professionalInstitutions)
      .innerJoin(
        professionals,
        and(
          eq(professionals.id, professionalInstitutions.professionalId),
          eq(professionals.userId, professionalInstitutions.userId),
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
        and(
          eq(professionalInstitutions.institutionId, snapshot.institutionId),
          eq(professionalInstitutions.userId, userId),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1)
      .for("update");
    if (!membership) continue;
    recipients.push({
      kind: "USER",
      userId,
      channels: ["PUSH", "EMAIL"],
    });
  }
  return recipients;
}

export function createSwapLifecycleShadowEventInput(input: {
  eventType: SwapLifecycleShadowEventType;
  snapshot: SwapLifecycleOperationalSnapshot;
  transition: CanonicalSwapLifecycleTransition;
  actor: Extract<OperationalEventActor, { kind: "USER" }>;
  recipients: readonly OperationalEventRecipient[];
  occurredAt?: Date;
}): CreateOperationalEventInput {
  const isOpenOffer =
    input.snapshot.toProfessionalId === null &&
    input.snapshot.toUserId === null;
  const deliveryPolicy =
    input.eventType === "SWAP_OFFERED" && isOpenOffer ? "BROADCAST" : "NOTIFY";
  const recipientResolution: OperationalRecipientResolution | undefined =
    input.recipients.length > 0
      ? undefined
      : input.eventType === "SWAP_OFFERED"
        ? "NO_ELIGIBLE_RECIPIENTS"
        : "NO_DELIVERABLE_RECIPIENTS";
  return {
    idempotencyKey: swapLifecycleShadowIdempotencyKey({
      eventType: input.eventType,
      swapId: input.snapshot.id,
      version: input.snapshot.version,
    }),
    eventType: input.eventType,
    deliveryPolicy,
    aggregate: {
      type: "SWAP_REQUEST",
      id: input.snapshot.id,
      version: input.snapshot.version,
    },
    transition: { from: input.transition.from, to: input.transition.to },
    context: {
      institutionId: input.snapshot.institutionId,
      hospitalId: input.snapshot.hospitalId,
      scopeKind: "SECTOR",
      sectorId: input.snapshot.sectorId,
      scheduleContextId: input.snapshot.scheduleContextId,
      shiftInstanceId: input.snapshot.fromShiftInstanceId,
      assignmentId: input.snapshot.fromAssignmentId,
    },
    actor: input.actor,
    recipients: input.recipients,
    ...(recipientResolution === undefined ? {} : { recipientResolution }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  };
}

/**
 * Persiste um fato SHADOW dentro da transação que já executou o CAS da troca.
 * Nenhum caller fornece modo de emissão, lista textual ou endereço de e-mail.
 */
export async function recordSwapLifecycleShadowEventInTransaction(
  tx: OperationalEventTx,
  input: {
    eventType: SwapLifecycleShadowEventType;
    previousStatus: SwapLifecyclePreviousStatus;
    swapId: number;
    institutionId: number;
    expectedVersion: number;
    actor: SwapLifecycleOperationalActor;
    occurredAt?: Date;
  },
) {
  const transition = transitionForSwapLifecycleEvent(
    input.eventType,
    input.previousStatus,
  );
  const snapshot = await captureCanonicalSwapLifecycleSnapshot(tx, {
    swapId: input.swapId,
    institutionId: input.institutionId,
  });
  assertSnapshot(snapshot, transition, input.expectedVersion);
  const actor = await resolveCanonicalSwapActor(tx, {
    ...input.actor,
    institutionId: snapshot.institutionId,
  });
  const recipients =
    input.eventType === "SWAP_OFFERED"
      ? await resolveDeliverableOfferRecipients(tx, snapshot)
      : await resolveDeliverableDirectSwapRecipients(tx, snapshot, {
          requireCounterpart:
            input.eventType === "SWAP_ACCEPTED" ||
            input.eventType === "SWAP_REJECTED" ||
            snapshot.toUserId !== null ||
            snapshot.toProfessionalId !== null,
        });
  return createOperationalEventInTransaction(
    tx,
    createSwapLifecycleShadowEventInput({
      eventType: input.eventType,
      snapshot,
      transition,
      actor,
      recipients,
      ...(input.occurredAt === undefined
        ? {}
        : { occurredAt: input.occurredAt }),
    }),
  );
}
