import { createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  notificationDeliveries,
  operationalEventRelatedContexts,
  operationalEventRecipients,
  operationalEvents,
  monthlyRosters,
  professionals,
  professionalInstitutions,
  scheduleContexts,
  shiftAssignmentsV2,
  shiftInstances,
  scheduleInvites,
  swapRequests,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  canonicalVacancyRequestManagerUserIds,
  isCanonicalVacancyRequestManagerActor,
  isCanonicalVacancyRequestRequesterDeliverable,
  resolveCanonicalVacancyRequestManagers,
} from "./vacancy-request-recipients";

/**
 * Catálogo fechado da primeira versão. Nenhuma mutação é ligada a ele nesta
 * frente; os emissores futuros deverão escolher explicitamente uma política
 * de entrega em vez de criar notificações ad hoc.
 */
export const OPERATIONAL_EVENT_TYPES = [
  "ASSIGNMENT_CREATED",
  "ASSIGNMENT_REMOVED",
  "ASSIGNMENT_DIRECT_ASSIGNED",
  "ASSIGNMENT_DIRECT_REMOVED",
  "ASSIGNMENT_SUBSTITUTION_ASSIGNED",
  "ASSIGNMENT_SUBSTITUTION_REMOVED",
  "VACANCY_REQUESTED",
  "ASSIGNMENT_APPROVED",
  "ASSIGNMENT_REJECTED",
  "SHIFT_UPDATED",
  "VACANCY_BROADCAST",
  "SCHEDULE_INVITE_CREATED",
  "SCHEDULE_INVITE_ACCEPTED",
  "SCHEDULE_INVITE_DECLINED",
  "SCHEDULE_INVITE_REVOKED",
  "SCHEDULE_INVITE_EXPIRED",
  "SWAP_OFFERED",
  "SWAP_ACCEPTED",
  "SWAP_REJECTED",
  "SWAP_CANCELLED",
  "SWAP_OFFER_DISMISSED",
  "SWAP_EXPIRED",
  "ROSTER_PUBLISHED",
  "ROSTER_LOCKED",
  "SCHEDULE_REPLICATED",
  "ACCESS_UPDATED",
  "SCHEDULE_CONTEXT_CREATED",
] as const;

export type OperationalEventType = (typeof OPERATIONAL_EVENT_TYPES)[number];

/**
 * O modo é imutável e vem exclusivamente do catálogo fechado do servidor.
 * Nesta etapa, todos os fatos permanecem em SHADOW; uma promoção a ACTIVE
 * exige frente própria, nunca payload, endpoint ou variável de ambiente.
 */
export const OPERATIONAL_EVENT_EMISSION_MODES = ["SHADOW", "ACTIVE"] as const;
export type OperationalEventEmissionMode =
  (typeof OPERATIONAL_EVENT_EMISSION_MODES)[number];

export const OPERATIONAL_EVENT_EMISSION_POLICIES = Object.freeze({
  ASSIGNMENT_CREATED: "SHADOW",
  ASSIGNMENT_REMOVED: "SHADOW",
  ASSIGNMENT_DIRECT_ASSIGNED: "SHADOW",
  ASSIGNMENT_DIRECT_REMOVED: "SHADOW",
  ASSIGNMENT_SUBSTITUTION_ASSIGNED: "SHADOW",
  ASSIGNMENT_SUBSTITUTION_REMOVED: "SHADOW",
  VACANCY_REQUESTED: "SHADOW",
  ASSIGNMENT_APPROVED: "SHADOW",
  ASSIGNMENT_REJECTED: "SHADOW",
  SHIFT_UPDATED: "SHADOW",
  VACANCY_BROADCAST: "SHADOW",
  SCHEDULE_INVITE_CREATED: "SHADOW",
  SCHEDULE_INVITE_ACCEPTED: "SHADOW",
  SCHEDULE_INVITE_DECLINED: "SHADOW",
  SCHEDULE_INVITE_REVOKED: "SHADOW",
  SCHEDULE_INVITE_EXPIRED: "SHADOW",
  SWAP_OFFERED: "SHADOW",
  SWAP_ACCEPTED: "SHADOW",
  SWAP_REJECTED: "SHADOW",
  SWAP_CANCELLED: "SHADOW",
  SWAP_OFFER_DISMISSED: "SHADOW",
  SWAP_EXPIRED: "SHADOW",
  ROSTER_PUBLISHED: "SHADOW",
  ROSTER_LOCKED: "SHADOW",
  SCHEDULE_REPLICATED: "SHADOW",
  ACCESS_UPDATED: "SHADOW",
  SCHEDULE_CONTEXT_CREATED: "SHADOW",
} satisfies Record<OperationalEventType, OperationalEventEmissionMode>);

export function getOperationalEventEmissionMode(
  eventType: OperationalEventType,
): OperationalEventEmissionMode {
  return OPERATIONAL_EVENT_EMISSION_POLICIES[eventType];
}

export const OPERATIONAL_AGGREGATE_TYPES = [
  "SHIFT_ASSIGNMENT",
  "SHIFT_INSTANCE",
  "VACANCY_REQUEST",
  "SWAP_REQUEST",
  "SCHEDULE_INVITE",
  "MONTHLY_ROSTER",
  "PROFESSIONAL_INSTITUTION_ACCESS",
  "SCHEDULE_CONTEXT",
] as const;
export type OperationalAggregateType =
  (typeof OPERATIONAL_AGGREGATE_TYPES)[number];

/**
 * Apenas MONTHLY_ROSTER e SWAP_REQUEST já possuem revisão monotônica gravada
 * no modelo atual. SHIFT_ASSIGNMENT continua bloqueado genericamente: os
 * quatro fatos fechados abaixo são a única exceção e usam a revisão
 * operacional persistida na própria alocação. Os demais writers/eventTypes
 * não recebem esta capability.
 */
export const OPERATIONAL_AGGREGATE_VERSION_CAPABILITIES = {
  SHIFT_ASSIGNMENT: "UNAVAILABLE",
  SHIFT_INSTANCE: "UNAVAILABLE",
  VACANCY_REQUEST: "UNAVAILABLE",
  SWAP_REQUEST: "ROW_VERSION",
  SCHEDULE_INVITE: "UNAVAILABLE",
  MONTHLY_ROSTER: "ROW_VERSION",
  PROFESSIONAL_INSTITUTION_ACCESS: "UNAVAILABLE",
  SCHEDULE_CONTEXT: "UNAVAILABLE",
} as const satisfies Record<
  OperationalAggregateType,
  "ROW_VERSION" | "UNAVAILABLE"
>;

export const OPERATIONAL_TRANSITION_STATES = [
  "NONE",
  "DRAFT",
  "ACTIVE",
  "INACTIVE",
  "PENDING",
  "OPEN",
  "VACANT",
  "ASSIGNED",
  "REMOVED",
  "APPROVED",
  "REJECTED",
  "ACCEPTED",
  "DECLINED",
  "CANCELLED",
  "REVOKED",
  "EXPIRED",
  "PUBLISHED",
  "LOCKED",
] as const;
export type OperationalTransitionState =
  (typeof OPERATIONAL_TRANSITION_STATES)[number];

export const OPERATIONAL_USER_ACTOR_ROLES = [
  "USER",
  "GESTOR_MEDICO",
  "GESTOR_PLUS",
] as const;
export const OPERATIONAL_SYSTEM_ACTOR_ROLES = [
  "SCHEDULE_EXPIRY_WORKER",
  "NOTIFICATION_DELIVERY_WORKER",
  "SCHEDULE_RECONCILIATION_WORKER",
] as const;

export const OPERATIONAL_DELIVERY_POLICIES = [
  "NOTIFY",
  "BROADCAST",
  "SILENT_AUDITED",
] as const;

export type OperationalDeliveryPolicy =
  (typeof OPERATIONAL_DELIVERY_POLICIES)[number];

export const OPERATIONAL_SCOPE_KINDS = [
  "INSTITUTION",
  "HOSPITAL",
  "SECTOR",
] as const;
export type OperationalScopeKind = (typeof OPERATIONAL_SCOPE_KINDS)[number];

type OperationalEventContract = {
  aggregateType: OperationalAggregateType;
  deliveryPolicies: readonly OperationalDeliveryPolicy[];
  scopeKinds: readonly OperationalScopeKind[];
  requiredContextIds?: readonly (
    "scheduleContextId" | "shiftInstanceId" | "assignmentId"
  )[];
  aggregateIdContextId?:
    "scheduleContextId" | "shiftInstanceId" | "assignmentId";
  /** Capability privada a fatos com operational_revision persistida. */
  aggregateRevision?:
    "SHIFT_ASSIGNMENT_OPERATIONAL" | "VACANCY_REQUEST_OPERATIONAL";
  /** O recipient é rederivado do agregado bloqueado, não do caller. */
  canonicalRecipient?:
    | "ASSIGNMENT_USER"
    | "VACANCY_REQUEST_REQUESTER"
    | "VACANCY_REQUEST_RESPONSIBLE_MANAGERS";
  /** O ator também é rederivado para evitar fato emitido por terceiro. */
  canonicalActor?:
    "VACANCY_REQUEST_REQUESTER" | "VACANCY_REQUEST_RESPONSIBLE_MANAGER";
  /** Remoção SHADOW pode auditar o vínculo canônico já revogado. */
  recipientMembership?: "ACTIVE" | "CANONICAL_ASSIGNMENT_HISTORICAL";
};

/**
 * Contrato fechado por fato. O emissor não escolhe livremente combinação de
 * tipo, agregado, política e escopo; novas mutações precisam alterar este
 * catálogo e seus testes de cobertura antes de poderem gravar evento.
 */
export const OPERATIONAL_EVENT_CONTRACTS: Record<
  OperationalEventType,
  OperationalEventContract
> = {
  ASSIGNMENT_CREATED: {
    aggregateType: "SHIFT_ASSIGNMENT",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
  },
  ASSIGNMENT_REMOVED: {
    aggregateType: "SHIFT_ASSIGNMENT",
    deliveryPolicies: ["NOTIFY", "SILENT_AUDITED"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
  },
  ASSIGNMENT_DIRECT_ASSIGNED: {
    aggregateType: "SHIFT_ASSIGNMENT",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
    aggregateRevision: "SHIFT_ASSIGNMENT_OPERATIONAL",
    canonicalRecipient: "ASSIGNMENT_USER",
  },
  ASSIGNMENT_DIRECT_REMOVED: {
    aggregateType: "SHIFT_ASSIGNMENT",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
    aggregateRevision: "SHIFT_ASSIGNMENT_OPERATIONAL",
    canonicalRecipient: "ASSIGNMENT_USER",
    recipientMembership: "CANONICAL_ASSIGNMENT_HISTORICAL",
  },
  ASSIGNMENT_SUBSTITUTION_ASSIGNED: {
    aggregateType: "SHIFT_ASSIGNMENT",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
    aggregateRevision: "SHIFT_ASSIGNMENT_OPERATIONAL",
    canonicalRecipient: "ASSIGNMENT_USER",
  },
  ASSIGNMENT_SUBSTITUTION_REMOVED: {
    aggregateType: "SHIFT_ASSIGNMENT",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
    aggregateRevision: "SHIFT_ASSIGNMENT_OPERATIONAL",
    canonicalRecipient: "ASSIGNMENT_USER",
    recipientMembership: "CANONICAL_ASSIGNMENT_HISTORICAL",
  },
  VACANCY_REQUESTED: {
    aggregateType: "VACANCY_REQUEST",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
    // No modelo atual, a solicitação é a alocação PENDENTE com revisão própria.
    aggregateRevision: "VACANCY_REQUEST_OPERATIONAL",
    canonicalRecipient: "VACANCY_REQUEST_RESPONSIBLE_MANAGERS",
    canonicalActor: "VACANCY_REQUEST_REQUESTER",
  },
  ASSIGNMENT_APPROVED: {
    aggregateType: "VACANCY_REQUEST",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
    aggregateRevision: "VACANCY_REQUEST_OPERATIONAL",
    canonicalRecipient: "VACANCY_REQUEST_REQUESTER",
    canonicalActor: "VACANCY_REQUEST_RESPONSIBLE_MANAGER",
  },
  ASSIGNMENT_REJECTED: {
    aggregateType: "VACANCY_REQUEST",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
    aggregateIdContextId: "assignmentId",
    aggregateRevision: "VACANCY_REQUEST_OPERATIONAL",
    canonicalRecipient: "VACANCY_REQUEST_REQUESTER",
    canonicalActor: "VACANCY_REQUEST_RESPONSIBLE_MANAGER",
  },
  SHIFT_UPDATED: {
    aggregateType: "SHIFT_INSTANCE",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId"],
    aggregateIdContextId: "shiftInstanceId",
  },
  VACANCY_BROADCAST: {
    aggregateType: "SHIFT_INSTANCE",
    deliveryPolicies: ["BROADCAST"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId"],
    aggregateIdContextId: "shiftInstanceId",
  },
  SCHEDULE_INVITE_CREATED: {
    aggregateType: "SCHEDULE_INVITE",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
  },
  SCHEDULE_INVITE_ACCEPTED: {
    aggregateType: "SCHEDULE_INVITE",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
  },
  SCHEDULE_INVITE_DECLINED: {
    aggregateType: "SCHEDULE_INVITE",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
  },
  SCHEDULE_INVITE_REVOKED: {
    aggregateType: "SCHEDULE_INVITE",
    deliveryPolicies: ["SILENT_AUDITED"],
    scopeKinds: ["SECTOR"],
  },
  SCHEDULE_INVITE_EXPIRED: {
    aggregateType: "SCHEDULE_INVITE",
    deliveryPolicies: ["NOTIFY", "SILENT_AUDITED"],
    scopeKinds: ["SECTOR"],
  },
  SWAP_OFFERED: {
    aggregateType: "SWAP_REQUEST",
    deliveryPolicies: ["NOTIFY", "BROADCAST"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
  },
  SWAP_ACCEPTED: {
    aggregateType: "SWAP_REQUEST",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
  },
  SWAP_REJECTED: {
    aggregateType: "SWAP_REQUEST",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
  },
  SWAP_CANCELLED: {
    aggregateType: "SWAP_REQUEST",
    deliveryPolicies: ["NOTIFY", "SILENT_AUDITED"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
  },
  SWAP_OFFER_DISMISSED: {
    aggregateType: "SWAP_REQUEST",
    deliveryPolicies: ["SILENT_AUDITED"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
  },
  SWAP_EXPIRED: {
    aggregateType: "SWAP_REQUEST",
    deliveryPolicies: ["SILENT_AUDITED"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["shiftInstanceId", "assignmentId"],
  },
  ROSTER_PUBLISHED: {
    aggregateType: "MONTHLY_ROSTER",
    deliveryPolicies: ["NOTIFY"],
    scopeKinds: ["HOSPITAL"],
  },
  ROSTER_LOCKED: {
    aggregateType: "MONTHLY_ROSTER",
    deliveryPolicies: ["SILENT_AUDITED"],
    scopeKinds: ["HOSPITAL"],
  },
  SCHEDULE_REPLICATED: {
    aggregateType: "MONTHLY_ROSTER",
    deliveryPolicies: ["NOTIFY", "SILENT_AUDITED"],
    scopeKinds: ["HOSPITAL"],
  },
  ACCESS_UPDATED: {
    aggregateType: "PROFESSIONAL_INSTITUTION_ACCESS",
    deliveryPolicies: ["NOTIFY", "SILENT_AUDITED"],
    scopeKinds: ["INSTITUTION"],
  },
  SCHEDULE_CONTEXT_CREATED: {
    aggregateType: "SCHEDULE_CONTEXT",
    deliveryPolicies: ["SILENT_AUDITED"],
    scopeKinds: ["SECTOR"],
    requiredContextIds: ["scheduleContextId"],
    aggregateIdContextId: "scheduleContextId",
  },
};

type CanonicalEventTransitionContract = {
  from: OperationalTransitionState | null;
  to: OperationalTransitionState | null;
  aggregateStatus?: string;
  assignmentState?: {
    status: string;
    isActive: boolean;
  };
};

/**
 * Uma linha no ledger só é emitível quando a transição do agregado já possui
 * semântica inequívoca no modelo atual. Os demais tipos permanecem declarados
 * (para cobertura de mutações), porém bloqueados até a frente do fluxo
 * correspondente fixar estado e revisão canônicos.
 */
export const OPERATIONAL_EVENT_TRANSITION_CONTRACTS: Record<
  OperationalEventType,
  CanonicalEventTransitionContract | null
> = {
  ASSIGNMENT_CREATED: null,
  ASSIGNMENT_REMOVED: null,
  ASSIGNMENT_DIRECT_ASSIGNED: {
    from: "NONE",
    to: "ASSIGNED",
    assignmentState: { status: "OCUPADO", isActive: true },
  },
  ASSIGNMENT_DIRECT_REMOVED: {
    from: "ASSIGNED",
    to: "REMOVED",
    assignmentState: { status: "OCUPADO", isActive: false },
  },
  ASSIGNMENT_SUBSTITUTION_ASSIGNED: {
    from: "NONE",
    to: "ASSIGNED",
    assignmentState: { status: "OCUPADO", isActive: true },
  },
  ASSIGNMENT_SUBSTITUTION_REMOVED: {
    from: "ASSIGNED",
    to: "REMOVED",
    assignmentState: { status: "OCUPADO", isActive: false },
  },
  VACANCY_REQUESTED: {
    from: "NONE",
    to: "PENDING",
    assignmentState: { status: "PENDENTE", isActive: true },
  },
  ASSIGNMENT_APPROVED: {
    from: "PENDING",
    to: "APPROVED",
    assignmentState: { status: "OCUPADO", isActive: true },
  },
  ASSIGNMENT_REJECTED: {
    from: "PENDING",
    to: "REJECTED",
    assignmentState: { status: "REJEITADO", isActive: false },
  },
  SHIFT_UPDATED: null,
  VACANCY_BROADCAST: null,
  SCHEDULE_INVITE_CREATED: null,
  SCHEDULE_INVITE_ACCEPTED: null,
  SCHEDULE_INVITE_DECLINED: null,
  SCHEDULE_INVITE_REVOKED: null,
  SCHEDULE_INVITE_EXPIRED: null,
  SWAP_OFFERED: { from: null, to: "PENDING", aggregateStatus: "PENDING" },
  SWAP_ACCEPTED: null,
  SWAP_REJECTED: null,
  SWAP_CANCELLED: null,
  SWAP_OFFER_DISMISSED: null,
  SWAP_EXPIRED: null,
  ROSTER_PUBLISHED: {
    from: "DRAFT",
    to: "PUBLISHED",
    aggregateStatus: "PUBLISHED",
  },
  ROSTER_LOCKED: {
    from: "PUBLISHED",
    to: "LOCKED",
    aggregateStatus: "LOCKED",
  },
  SCHEDULE_REPLICATED: null,
  ACCESS_UPDATED: null,
  SCHEDULE_CONTEXT_CREATED: null,
};

export const OPERATIONAL_RELATED_CONTEXT_KINDS = [
  "COUNTERPART",
  "AFFECTED_SCOPE",
] as const;
export type OperationalRelatedContextKind =
  (typeof OPERATIONAL_RELATED_CONTEXT_KINDS)[number];

export const OPERATIONAL_RECIPIENT_RESOLUTIONS = [
  "RESOLVED",
  "NO_ELIGIBLE_RECIPIENTS",
  "NO_RESPONSIBLE_MANAGERS",
  "NO_DELIVERABLE_RECIPIENTS",
  "NOT_APPLICABLE",
] as const;
export type OperationalRecipientResolution =
  (typeof OPERATIONAL_RECIPIENT_RESOLUTIONS)[number];

export const OPERATIONAL_DELIVERY_CHANNELS = ["PUSH", "EMAIL"] as const;
export type OperationalDeliveryChannel =
  (typeof OPERATIONAL_DELIVERY_CHANNELS)[number];

const NO_OPERATIONAL_DELIVERY_CHANNELS: readonly OperationalDeliveryChannel[] =
  Object.freeze([]);

/**
 * A fila só nasce para fatos promovidos explicitamente pelo catálogo fechado.
 * SHADOW preserva o fato e seus destinatários para auditoria, sem criar uma
 * entrega latente que poderia ser promovida por um worker futuro.
 *
 * O teste literal de ACTIVE também falha fechado para valores inválidos que
 * eventualmente atravessem uma fronteira JavaScript sem a tipagem TypeScript.
 */
export function operationalDeliveryChannelsForEmission(
  emissionMode: OperationalEventEmissionMode,
  channels: readonly OperationalDeliveryChannel[],
): readonly OperationalDeliveryChannel[] {
  return emissionMode === "ACTIVE"
    ? channels
    : NO_OPERATIONAL_DELIVERY_CHANNELS;
}

export const OPERATIONAL_DELIVERY_STATUSES = [
  "QUEUED",
  "PROCESSING",
  "PROVIDER_ACCEPTED",
  "DELIVERED",
  "FAILED",
  "DEAD",
  "SKIPPED",
] as const;

export type OperationalDeliveryStatus =
  (typeof OPERATIONAL_DELIVERY_STATUSES)[number];

export const OPERATIONAL_DELIVERY_MAX_ATTEMPTS = 6;

export const OPERATIONAL_EMAIL_TRUST_STATES = [
  "PENDING",
  "TRUSTED",
  "REVOKED",
] as const;

export type OperationalEmailTrustState =
  (typeof OPERATIONAL_EMAIL_TRUST_STATES)[number];

export const OPERATIONAL_EMAIL_TRUST_SOURCES = [
  "ADMIN_CREATED",
  "INVITE_ACTIVATED",
  "USER_CONFIRMED",
  "LEGACY",
] as const;

export type OperationalEmailTrustSource =
  (typeof OPERATIONAL_EMAIL_TRUST_SOURCES)[number];

export type OperationalEventContext = {
  institutionId: number;
  hospitalId?: number | null;
  scopeKind: OperationalScopeKind;
  sectorId?: number | null;
  scheduleContextId?: number | null;
  shiftInstanceId?: number | null;
  assignmentId?: number | null;
};

export type OperationalEventRelatedContext = {
  relationKind: OperationalRelatedContextKind;
  context: OperationalEventContext;
};

export type OperationalEventActor =
  | {
      kind: "USER";
      userId: number;
      professionalId?: number | null;
      role: (typeof OPERATIONAL_USER_ACTOR_ROLES)[number];
    }
  | {
      kind: "SYSTEM";
      role: (typeof OPERATIONAL_SYSTEM_ACTOR_ROLES)[number];
    };

export type OperationalEventRecipient =
  | {
      kind: "USER";
      userId: number;
      channels: readonly OperationalDeliveryChannel[];
    }
  | {
      kind: "SCHEDULE_INVITE";
      scheduleInviteId: number;
      channels: readonly OperationalDeliveryChannel[];
    };

export type CreateOperationalEventInput = {
  idempotencyKey: string;
  eventType: OperationalEventType;
  /** O caller não pode definir o modo de emissão do fato. */
  emissionMode?: never;
  deliveryPolicy: OperationalDeliveryPolicy;
  aggregate: {
    type: OperationalAggregateType;
    id: number;
    version: number;
  };
  transition?: {
    from?: OperationalTransitionState | null;
    to?: OperationalTransitionState | null;
  };
  context: OperationalEventContext;
  actor: OperationalEventActor;
  recipients: readonly OperationalEventRecipient[];
  /**
   * Torna explícito quando a política pretendia notificar, mas o cálculo
   * canônico não encontrou destinatário. Isso preserva a mutação/auditoria
   * sem mascarar uma configuração operacional incompleta como entrega feita.
   */
  recipientResolution?: OperationalRecipientResolution;
  /** Contextos adicionais, por IDs e FKs compostas; por exemplo, a outra
   * ponta de uma troca entre setores/hospitais do mesmo tenant. */
  relatedContexts?: readonly OperationalEventRelatedContext[];
  occurredAt?: Date;
};

export type OperationalEventCreateResult = {
  eventId: number;
  created: boolean;
  eventHash: string;
};

export class OperationalEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalEventValidationError";
  }
}

export class OperationalEventIdempotencyCollisionError extends Error {
  constructor() {
    super("A chave de idempotência já representa outro evento operacional");
    this.name = "OperationalEventIdempotencyCollisionError";
  }
}

type OperationalEventDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * O ledger só pode ser gravado dentro da mesma transação da mutação de
 * negócio. Usar o callback transaction do Drizzle impede, por tipo, que um
 * emitter futuro passe o db em autocommit e libere locks entre o fato, seus
 * destinatários e as entregas.
 */
export type OperationalEventTx = Parameters<
  Parameters<OperationalEventDb["transaction"]>[0]
>[0];

const MAX_IDEMPOTENCY_KEY_LENGTH = 191;

function assertPositiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new OperationalEventValidationError(
      `${label} deve ser um inteiro positivo`,
    );
  }
}

function assertNullablePositiveInteger(
  value: unknown,
  label: string,
): asserts value is number | null | undefined {
  if (value === null || value === undefined) return;
  assertPositiveInteger(value, label);
}

function assertNonBlank(
  value: unknown,
  label: string,
  maxLength: number,
): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new OperationalEventValidationError(`${label} é inválido`);
  }
}

function isOperationalEventType(value: string): value is OperationalEventType {
  return (OPERATIONAL_EVENT_TYPES as readonly string[]).includes(value);
}

function isOperationalAggregateType(
  value: string,
): value is OperationalAggregateType {
  return (OPERATIONAL_AGGREGATE_TYPES as readonly string[]).includes(value);
}

function isOperationalTransitionState(
  value: string,
): value is OperationalTransitionState {
  return (OPERATIONAL_TRANSITION_STATES as readonly string[]).includes(value);
}

function isOperationalUserActorRole(
  value: string,
): value is (typeof OPERATIONAL_USER_ACTOR_ROLES)[number] {
  return (OPERATIONAL_USER_ACTOR_ROLES as readonly string[]).includes(value);
}

function isOperationalSystemActorRole(
  value: string,
): value is (typeof OPERATIONAL_SYSTEM_ACTOR_ROLES)[number] {
  return (OPERATIONAL_SYSTEM_ACTOR_ROLES as readonly string[]).includes(value);
}

function isDeliveryPolicy(value: string): value is OperationalDeliveryPolicy {
  return (OPERATIONAL_DELIVERY_POLICIES as readonly string[]).includes(value);
}

function isScopeKind(value: string): value is OperationalScopeKind {
  return (OPERATIONAL_SCOPE_KINDS as readonly string[]).includes(value);
}

function isRecipientResolution(
  value: string,
): value is OperationalRecipientResolution {
  return (OPERATIONAL_RECIPIENT_RESOLUTIONS as readonly string[]).includes(
    value,
  );
}

function isDeliveryChannel(value: string): value is OperationalDeliveryChannel {
  return (OPERATIONAL_DELIVERY_CHANNELS as readonly string[]).includes(value);
}

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (
    "code" in error &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  ) {
    return true;
  }
  if ("cause" in error) {
    return isDuplicateEntry((error as { cause?: unknown }).cause);
  }
  return false;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OperationalEventValidationError(
        "projeção canônica contém número inválido",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OperationalEventValidationError(
        "projeção canônica deve conter somente objetos JSON",
      );
    }
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new OperationalEventValidationError(
    "projeção canônica contém valor não serializável",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function targetKey(recipient: OperationalEventRecipient): string {
  return recipient.kind === "USER"
    ? `USER:${recipient.userId}`
    : `SCHEDULE_INVITE:${recipient.scheduleInviteId}`;
}

/** Comparação por code point, independente do locale configurado no runtime. */
function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRecipients(
  recipients: readonly OperationalEventRecipient[],
): readonly OperationalEventRecipient[] {
  const seenTargets = new Set<string>();
  const normalized: OperationalEventRecipient[] = [];
  for (const recipient of recipients) {
    if (!recipient || typeof recipient !== "object") {
      throw new OperationalEventValidationError(
        "Destinatário operacional inválido",
      );
    }
    // Não há e-mail/endereço no contrato de recipient. Rejeitar explicitamente
    // chaves de transporte evita que um futuro caller transforme esta camada
    // interna em um relay de e-mail arbitrário.
    if (
      "email" in recipient ||
      "address" in recipient ||
      "to" in recipient ||
      "recipientEmail" in recipient
    ) {
      throw new OperationalEventValidationError(
        "Destinatário operacional não aceita endereço de e-mail",
      );
    }
    if (!Array.isArray(recipient.channels) || recipient.channels.length === 0) {
      throw new OperationalEventValidationError(
        "Destinatário sem canal de entrega",
      );
    }
    const channels = [...new Set(recipient.channels)];
    if (
      channels.some(
        (channel) => typeof channel !== "string" || !isDeliveryChannel(channel),
      )
    ) {
      throw new OperationalEventValidationError("Canal de entrega inválido");
    }
    if (recipient.kind === "USER") {
      assertPositiveInteger(recipient.userId, "recipient.userId");
      if ("scheduleInviteId" in recipient) {
        throw new OperationalEventValidationError(
          "Recipient USER não pode conter scheduleInviteId",
        );
      }
      const key = targetKey(recipient);
      if (seenTargets.has(key)) {
        throw new OperationalEventValidationError(
          "Destinatário duplicado no evento",
        );
      }
      seenTargets.add(key);
      normalized.push({ kind: "USER", userId: recipient.userId, channels });
      continue;
    }
    if (recipient.kind === "SCHEDULE_INVITE") {
      assertPositiveInteger(
        recipient.scheduleInviteId,
        "recipient.scheduleInviteId",
      );
      if ("userId" in recipient) {
        throw new OperationalEventValidationError(
          "Recipient SCHEDULE_INVITE não pode conter userId",
        );
      }
      // Convites não carregam dispositivo. O push, quando existir para uma
      // pessoa já cadastrada, deve ser representado por recipient USER próprio.
      if (channels.some((channel) => channel === "PUSH")) {
        throw new OperationalEventValidationError(
          "Recipient SCHEDULE_INVITE só pode receber EMAIL",
        );
      }
      const key = targetKey(recipient);
      if (seenTargets.has(key)) {
        throw new OperationalEventValidationError(
          "Destinatário duplicado no evento",
        );
      }
      seenTargets.add(key);
      normalized.push({
        kind: "SCHEDULE_INVITE",
        scheduleInviteId: recipient.scheduleInviteId,
        channels,
      });
      continue;
    }
    throw new OperationalEventValidationError("Tipo de destinatário inválido");
  }
  return normalized.sort((left, right) =>
    compareCanonicalStrings(targetKey(left), targetKey(right)),
  );
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function validateOperationalContext(
  context: OperationalEventContext,
  label: string,
): void {
  assertPositiveInteger(context.institutionId, `${label}.institutionId`);
  if (!isScopeKind(context.scopeKind)) {
    throw new OperationalEventValidationError(`${label}.scopeKind inválido`);
  }

  const resourceFields: [string, unknown][] = [
    ["sectorId", context.sectorId],
    ["scheduleContextId", context.scheduleContextId],
    ["shiftInstanceId", context.shiftInstanceId],
    ["assignmentId", context.assignmentId],
  ];

  if (context.scopeKind === "INSTITUTION") {
    if (isPresent(context.hospitalId)) {
      throw new OperationalEventValidationError(
        `Evento INSTITUTION não pode informar ${label}.hospitalId`,
      );
    }
    if (resourceFields.some(([, value]) => isPresent(value))) {
      throw new OperationalEventValidationError(
        `Evento INSTITUTION não pode informar recursos de escala`,
      );
    }
    return;
  }

  assertPositiveInteger(context.hospitalId, `${label}.hospitalId`);
  if (context.scopeKind === "HOSPITAL") {
    if (resourceFields.some(([, value]) => isPresent(value))) {
      throw new OperationalEventValidationError(
        `Evento HOSPITAL não pode informar recursos setoriais`,
      );
    }
    return;
  }

  assertPositiveInteger(context.sectorId, `${label}.sectorId`);
  assertNullablePositiveInteger(
    context.scheduleContextId,
    `${label}.scheduleContextId`,
  );
  assertNullablePositiveInteger(
    context.shiftInstanceId,
    `${label}.shiftInstanceId`,
  );
  assertNullablePositiveInteger(context.assignmentId, `${label}.assignmentId`);
  if (isPresent(context.assignmentId) && !isPresent(context.shiftInstanceId)) {
    throw new OperationalEventValidationError(
      `${label}.assignmentId exige shiftInstanceId`,
    );
  }
}

function normalizedContext(
  context: OperationalEventContext,
): Required<OperationalEventContext> {
  return {
    institutionId: context.institutionId,
    hospitalId: context.hospitalId ?? null,
    scopeKind: context.scopeKind,
    sectorId: context.sectorId ?? null,
    scheduleContextId: context.scheduleContextId ?? null,
    shiftInstanceId: context.shiftInstanceId ?? null,
    assignmentId: context.assignmentId ?? null,
  };
}

function normalizedRelatedContexts(
  relatedContexts: readonly OperationalEventRelatedContext[] | undefined,
): readonly OperationalEventRelatedContext[] {
  if ((relatedContexts?.length ?? 0) !== 0) {
    throw new OperationalEventValidationError(
      "relatedContexts é derivado do agregado canônico e não aceita entrada do caller",
    );
  }
  return [];
}

function resolveRecipientResolution(
  input: CreateOperationalEventInput,
  recipients: readonly OperationalEventRecipient[],
): OperationalRecipientResolution {
  const requested = input.recipientResolution;
  if (requested !== undefined && !isRecipientResolution(requested)) {
    throw new OperationalEventValidationError("recipientResolution inválida");
  }
  if (input.deliveryPolicy === "SILENT_AUDITED") {
    if (requested !== undefined && requested !== "NOT_APPLICABLE") {
      throw new OperationalEventValidationError(
        "Evento SILENT_AUDITED só aceita recipientResolution NOT_APPLICABLE",
      );
    }
    return "NOT_APPLICABLE";
  }
  if (recipients.length > 0) {
    if (requested !== undefined && requested !== "RESOLVED") {
      throw new OperationalEventValidationError(
        "Evento com destinatários resolvidos não aceita recipientResolution pendente",
      );
    }
    return "RESOLVED";
  }
  if (
    requested === undefined ||
    requested === "RESOLVED" ||
    requested === "NOT_APPLICABLE"
  ) {
    throw new OperationalEventValidationError(
      "Evento sem destinatários exige a causa explícita da resolução vazia",
    );
  }
  return requested;
}

type CanonicalOperationalEventInput = {
  idempotencyKey: string;
  eventType: OperationalEventType;
  emissionMode: OperationalEventEmissionMode;
  deliveryPolicy: OperationalDeliveryPolicy;
  aggregate: Readonly<{
    type: OperationalAggregateType;
    id: number;
    version: number;
  }>;
  transition: Readonly<{
    from: OperationalTransitionState | null;
    to: OperationalTransitionState | null;
  }>;
  context: Required<OperationalEventContext>;
  actor: OperationalEventActor;
  recipients: readonly OperationalEventRecipient[];
  recipientResolution: OperationalRecipientResolution;
  occurredAt: Date | undefined;
};

/**
 * Destinatários são sempre resolvidos por IDs canônicos, mas a referência
 * precisa também pertencer ao tenant do fato. A FK composta protege o evento
 * e o convite; para usuário, o vínculo ativo é revalidado na própria
 * transação. Somente remoção SHADOW pode manter o vínculo canônico já
 * revogado para não impedir a retirada; o worker fail-closed repetirá a
 * checagem ativa imediatamente antes de qualquer entrega.
 */
async function assertRecipientsInInstitution(
  tx: OperationalEventTx,
  institutionId: number,
  recipients: readonly OperationalEventRecipient[],
  contract: OperationalEventContract,
): Promise<void> {
  const requiresActiveMembership =
    contract.recipientMembership !== "CANONICAL_ASSIGNMENT_HISTORICAL";
  for (const recipient of recipients) {
    if (recipient.kind === "USER") {
      const membershipConditions = [
        eq(professionalInstitutions.userId, recipient.userId),
        eq(professionalInstitutions.institutionId, institutionId),
        ...(requiresActiveMembership
          ? [eq(professionalInstitutions.active, true)]
          : []),
      ];
      const [membership] = await tx
        .select({ id: professionalInstitutions.id })
        .from(professionalInstitutions)
        .where(and(...membershipConditions))
        .limit(1)
        .for("update");
      if (!membership) {
        throw new OperationalEventValidationError(
          requiresActiveMembership
            ? "Destinatário USER sem vínculo institucional ativo"
            : "Destinatário USER sem vínculo institucional canônico",
        );
      }
      continue;
    }

    const [invite] = await tx
      .select({ id: scheduleInvites.id })
      .from(scheduleInvites)
      .where(
        and(
          eq(scheduleInvites.id, recipient.scheduleInviteId),
          eq(scheduleInvites.institutionId, institutionId),
          isNull(scheduleInvites.revokedAt),
          isNull(scheduleInvites.declinedAt),
          gt(scheduleInvites.expiresAt, new Date()),
          sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
        ),
      )
      .limit(1)
      .for("update");
    if (!invite) {
      throw new OperationalEventValidationError(
        "Destinatário SCHEDULE_INVITE não está ativo na instituição",
      );
    }
  }
}

async function assertActorInInstitution(
  tx: OperationalEventTx,
  institutionId: number,
  actor: OperationalEventActor,
): Promise<void> {
  if (actor.kind === "SYSTEM") return;
  const conditions = [
    eq(professionalInstitutions.userId, actor.userId),
    eq(professionalInstitutions.institutionId, institutionId),
    eq(professionalInstitutions.active, true),
  ];
  if (actor.professionalId !== null && actor.professionalId !== undefined) {
    conditions.push(
      eq(professionalInstitutions.professionalId, actor.professionalId),
    );
  }
  const [membership] = await tx
    .select({
      id: professionalInstitutions.id,
      roleInInstitution: professionalInstitutions.roleInInstitution,
    })
    .from(professionalInstitutions)
    .where(and(...conditions))
    .limit(1)
    .for("update");
  if (!membership) {
    throw new OperationalEventValidationError(
      "Ator USER sem vínculo institucional ativo",
    );
  }
  if (membership.roleInInstitution !== actor.role) {
    throw new OperationalEventValidationError(
      "Papel do ator diverge do vínculo institucional canônico",
    );
  }
}

/**
 * As FKs compostas provam tenant/hospital/setor, mas não que uma alocação
 * pertença à instância de turno informada. Esta leitura canônica fecha essa
 * relação antes da gravação. Todas as leituras canônicas são feitas sob lock
 * na transação que insere o evento, fechando a janela entre validação e
 * persistência do ledger.
 */
async function assertResourceContextConsistency(
  tx: OperationalEventTx,
  context: OperationalEventContext,
): Promise<void> {
  if (
    context.scheduleContextId !== null &&
    context.scheduleContextId !== undefined &&
    (context.shiftInstanceId === null || context.shiftInstanceId === undefined)
  ) {
    const [scheduleContext] = await tx
      .select({ id: scheduleContexts.id })
      .from(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.id, context.scheduleContextId),
          eq(scheduleContexts.institutionId, context.institutionId),
          eq(scheduleContexts.hospitalId, context.hospitalId!),
          eq(scheduleContexts.sectorId, context.sectorId!),
        ),
      )
      .limit(1)
      .for("update");
    if (!scheduleContext) {
      throw new OperationalEventValidationError(
        "Contexto de escala não pertence à topologia informada",
      );
    }
  }

  if (
    context.shiftInstanceId !== null &&
    context.shiftInstanceId !== undefined
  ) {
    const shiftConditions = [
      eq(shiftInstances.id, context.shiftInstanceId),
      eq(shiftInstances.institutionId, context.institutionId),
      eq(shiftInstances.hospitalId, context.hospitalId!),
      eq(shiftInstances.sectorId, context.sectorId!),
      ...(context.scheduleContextId === null ||
      context.scheduleContextId === undefined
        ? []
        : [eq(shiftInstances.scheduleContextId, context.scheduleContextId)]),
    ];
    const [shift] = await tx
      .select({
        id: shiftInstances.id,
        scheduleContextId: shiftInstances.scheduleContextId,
      })
      .from(shiftInstances)
      .where(and(...shiftConditions))
      .limit(1)
      .for("update");
    if (!shift) {
      throw new OperationalEventValidationError(
        "Instância de turno não pertence à topologia ou contexto informado",
      );
    }
    // Um turno classificado não pode perder seu contexto no ledger. Para
    // instâncias legadas não classificadas, ambos permanecem NULL; em todos
    // os demais casos a igualdade prova que o fato carrega a escala correta.
    if (shift.scheduleContextId !== context.scheduleContextId) {
      throw new OperationalEventValidationError(
        "Contexto de escala do evento diverge da instância de turno canônica",
      );
    }
  }

  if (
    context.assignmentId !== null &&
    context.assignmentId !== undefined &&
    context.shiftInstanceId !== null &&
    context.shiftInstanceId !== undefined
  ) {
    const [assignment] = await tx
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.id, context.assignmentId),
          eq(shiftAssignmentsV2.institutionId, context.institutionId),
          eq(shiftAssignmentsV2.hospitalId, context.hospitalId!),
          eq(shiftAssignmentsV2.sectorId, context.sectorId!),
          eq(shiftAssignmentsV2.shiftInstanceId, context.shiftInstanceId),
        ),
      )
      .limit(1)
      .for("update");
    if (!assignment) {
      throw new OperationalEventValidationError(
        "Alocação não pertence à instância de turno informada",
      );
    }
  }
}

function isPushAndEmailUserRecipient(
  recipient: OperationalEventRecipient | undefined,
  userId: number,
): boolean {
  return (
    recipient?.kind === "USER" &&
    recipient.userId === userId &&
    recipient.channels.length === 2 &&
    recipient.channels.includes("PUSH") &&
    recipient.channels.includes("EMAIL")
  );
}

function assertCanonicalVacancyRequesterActor(
  input: CanonicalOperationalEventInput,
  assignment: { professionalId: number; requesterUserId: number },
): void {
  if (
    input.actor.kind !== "USER" ||
    input.actor.userId !== assignment.requesterUserId ||
    input.actor.professionalId !== assignment.professionalId
  ) {
    throw new OperationalEventValidationError(
      "Ator não corresponde ao solicitante canônico da vaga",
    );
  }
}

function assertCanonicalVacancyRequesterRecipient(
  input: CanonicalOperationalEventInput,
  requesterUserId: number,
  requesterDeliverable: boolean,
): void {
  if (!requesterDeliverable) {
    if (
      input.recipients.length !== 0 ||
      input.recipientResolution !== "NO_DELIVERABLE_RECIPIENTS"
    ) {
      throw new OperationalEventValidationError(
        "Solicitante não entregável exige resolução canônica vazia",
      );
    }
    return;
  }
  if (
    input.recipientResolution !== "RESOLVED" ||
    input.recipients.length !== 1 ||
    !isPushAndEmailUserRecipient(input.recipients[0], requesterUserId)
  ) {
    throw new OperationalEventValidationError(
      "Destinatário não corresponde ao solicitante canônico da vaga",
    );
  }
}

function assertCanonicalVacancyManagerRecipients(
  input: CanonicalOperationalEventInput,
  responsibleManagerUserIds: readonly number[],
  requesterUserId: number,
): void {
  const recipientUserIds = responsibleManagerUserIds.filter(
    (userId) => userId !== requesterUserId,
  );
  if (recipientUserIds.length === 0) {
    const expectedResolution =
      responsibleManagerUserIds.length === 0
        ? "NO_RESPONSIBLE_MANAGERS"
        : "NO_DELIVERABLE_RECIPIENTS";
    if (
      input.recipients.length !== 0 ||
      input.recipientResolution !== expectedResolution
    ) {
      throw new OperationalEventValidationError(
        "Solicitação sem destinatário gestor exige resolução canônica vazia",
      );
    }
    return;
  }
  if (
    input.recipientResolution !== "RESOLVED" ||
    input.recipients.length !== recipientUserIds.length
  ) {
    throw new OperationalEventValidationError(
      "Destinatários não correspondem aos gestores responsáveis canônicos",
    );
  }
  for (let index = 0; index < recipientUserIds.length; index += 1) {
    if (
      !isPushAndEmailUserRecipient(
        input.recipients[index],
        recipientUserIds[index],
      )
    ) {
      throw new OperationalEventValidationError(
        "Destinatários não correspondem aos gestores responsáveis canônicos",
      );
    }
  }
}

/**
 * O agregado também é uma referência de autoridade: ele não pode ser um ID
 * solto, nem pertencer a outro tenant. Relações adicionais não são aceitas do
 * caller; para troca, a contrapartida é derivada exclusivamente da linha
 * canônica de swap sob a mesma versão.
 */
async function resolveCanonicalAggregateContexts(
  tx: OperationalEventTx,
  input: CanonicalOperationalEventInput,
): Promise<readonly OperationalEventRelatedContext[]> {
  const { aggregate, context } = input;
  const transitionContract =
    OPERATIONAL_EVENT_TRANSITION_CONTRACTS[input.eventType];
  const eventContract = OPERATIONAL_EVENT_CONTRACTS[input.eventType];
  if (!transitionContract) {
    throw new OperationalEventValidationError(
      "Evento ainda não possui contrato canônico de transição",
    );
  }
  switch (aggregate.type) {
    case "SHIFT_ASSIGNMENT": {
      if (
        eventContract.aggregateRevision !== "SHIFT_ASSIGNMENT_OPERATIONAL" ||
        eventContract.canonicalRecipient !== "ASSIGNMENT_USER" ||
        !transitionContract.assignmentState
      ) {
        throw new OperationalEventValidationError(
          "Alocação sem capability operacional canônica não pode emitir evento",
        );
      }
      const [assignment] = await tx
        .select({
          id: shiftAssignmentsV2.id,
          professionalId: shiftAssignmentsV2.professionalId,
          userId: professionals.userId,
          operationalRevision: shiftAssignmentsV2.operationalRevision,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
        })
        .from(shiftAssignmentsV2)
        .innerJoin(
          professionals,
          eq(professionals.id, shiftAssignmentsV2.professionalId),
        )
        .where(
          and(
            eq(shiftAssignmentsV2.id, aggregate.id),
            eq(shiftAssignmentsV2.institutionId, context.institutionId),
            eq(shiftAssignmentsV2.hospitalId, context.hospitalId!),
            eq(shiftAssignmentsV2.sectorId, context.sectorId!),
            eq(shiftAssignmentsV2.shiftInstanceId, context.shiftInstanceId!),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !assignment ||
        assignment.operationalRevision !== aggregate.version ||
        assignment.status !== transitionContract.assignmentState.status ||
        assignment.isActive !== transitionContract.assignmentState.isActive
      ) {
        throw new OperationalEventValidationError(
          "Alocação não pertence à revisão ou transição canônica do evento",
        );
      }
      if (
        input.recipients.length !== 1 ||
        input.recipients[0]?.kind !== "USER" ||
        input.recipients[0].userId !== assignment.userId
      ) {
        throw new OperationalEventValidationError(
          "Destinatário não corresponde ao usuário canônico da alocação",
        );
      }
      return [];
    }
    case "VACANCY_REQUEST": {
      if (
        eventContract.aggregateRevision !== "VACANCY_REQUEST_OPERATIONAL" ||
        !eventContract.canonicalRecipient ||
        !eventContract.canonicalActor ||
        !transitionContract.assignmentState
      ) {
        throw new OperationalEventValidationError(
          "Solicitação de vaga sem capability operacional canônica não pode emitir evento",
        );
      }
      const scheduleContextPredicate =
        context.scheduleContextId === null
          ? isNull(shiftInstances.scheduleContextId)
          : eq(shiftInstances.scheduleContextId, context.scheduleContextId);
      const [assignment] = await tx
        .select({
          id: shiftAssignmentsV2.id,
          professionalId: shiftAssignmentsV2.professionalId,
          createdByUserId: shiftAssignmentsV2.createdBy,
          requesterUserId: professionals.userId,
          operationalRevision: shiftAssignmentsV2.operationalRevision,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
        })
        .from(shiftAssignmentsV2)
        .innerJoin(
          professionals,
          eq(professionals.id, shiftAssignmentsV2.professionalId),
        )
        .innerJoin(
          shiftInstances,
          and(
            eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
            eq(shiftInstances.institutionId, shiftAssignmentsV2.institutionId),
            eq(shiftInstances.hospitalId, shiftAssignmentsV2.hospitalId),
            eq(shiftInstances.sectorId, shiftAssignmentsV2.sectorId),
          ),
        )
        .where(
          and(
            eq(shiftAssignmentsV2.id, aggregate.id),
            eq(shiftAssignmentsV2.institutionId, context.institutionId),
            eq(shiftAssignmentsV2.hospitalId, context.hospitalId!),
            eq(shiftAssignmentsV2.sectorId, context.sectorId!),
            eq(shiftAssignmentsV2.shiftInstanceId, context.shiftInstanceId!),
            eq(shiftInstances.id, context.shiftInstanceId!),
            eq(shiftInstances.institutionId, context.institutionId),
            eq(shiftInstances.hospitalId, context.hospitalId!),
            eq(shiftInstances.sectorId, context.sectorId!),
            scheduleContextPredicate,
          ),
        )
        .limit(1)
        .for("update");
      if (!assignment) {
        throw new OperationalEventValidationError(
          "Solicitação de vaga não pertence à revisão, solicitante ou transição canônica do evento",
        );
      }
      const createdByUserId = assignment.createdByUserId;
      const requesterUserId = assignment.requesterUserId;
      const isVacancyRequestCreation = input.eventType === "VACANCY_REQUESTED";
      if (
        typeof createdByUserId !== "number" ||
        !Number.isSafeInteger(createdByUserId) ||
        createdByUserId <= 0 ||
        !Number.isSafeInteger(requesterUserId) ||
        requesterUserId <= 0 ||
        createdByUserId !== requesterUserId ||
        assignment.operationalRevision !== aggregate.version ||
        (isVacancyRequestCreation &&
          (aggregate.version !== 1 || assignment.operationalRevision !== 1)) ||
        assignment.status !== transitionContract.assignmentState.status ||
        assignment.isActive !== transitionContract.assignmentState.isActive
      ) {
        throw new OperationalEventValidationError(
          "Solicitação de vaga não pertence à revisão, solicitante ou transição canônica do evento",
        );
      }

      const managers = await resolveCanonicalVacancyRequestManagers(tx, {
        institutionId: context.institutionId,
        hospitalId: context.hospitalId!,
        sectorId: context.sectorId!,
      });
      const managerUserIds = canonicalVacancyRequestManagerUserIds(managers);
      const requester = {
        institutionId: context.institutionId,
        professionalId: assignment.professionalId,
        userId: assignment.requesterUserId,
      };
      if (eventContract.canonicalActor === "VACANCY_REQUEST_REQUESTER") {
        assertCanonicalVacancyRequesterActor(input, assignment);
      } else if (
        eventContract.canonicalActor === "VACANCY_REQUEST_RESPONSIBLE_MANAGER"
      ) {
        if (
          input.actor.kind !== "USER" ||
          !isCanonicalVacancyRequestManagerActor(managers, input.actor)
        ) {
          throw new OperationalEventValidationError(
            "Ator não corresponde a gestor responsável canônico da vaga",
          );
        }
      } else {
        throw new OperationalEventValidationError(
          "Ator canônico da solicitação de vaga é inválido",
        );
      }

      const requesterDeliverable =
        eventContract.canonicalActor === "VACANCY_REQUEST_REQUESTER" ||
        eventContract.canonicalRecipient === "VACANCY_REQUEST_REQUESTER"
          ? await isCanonicalVacancyRequestRequesterDeliverable(tx, requester)
          : undefined;
      if (
        eventContract.canonicalActor === "VACANCY_REQUEST_REQUESTER" &&
        !requesterDeliverable
      ) {
        throw new OperationalEventValidationError(
          "Solicitante da vaga não possui vínculo entregável no momento do pedido",
        );
      }

      if (eventContract.canonicalRecipient === "VACANCY_REQUEST_REQUESTER") {
        assertCanonicalVacancyRequesterRecipient(
          input,
          assignment.requesterUserId,
          requesterDeliverable === true,
        );
      } else if (
        eventContract.canonicalRecipient ===
        "VACANCY_REQUEST_RESPONSIBLE_MANAGERS"
      ) {
        assertCanonicalVacancyManagerRecipients(
          input,
          managerUserIds,
          assignment.requesterUserId,
        );
      } else {
        throw new OperationalEventValidationError(
          "Destinatário canônico da solicitação de vaga é inválido",
        );
      }
      return [];
    }
    case "SWAP_REQUEST": {
      const [swap] = await tx
        .select({
          id: swapRequests.id,
          version: swapRequests.version,
          status: swapRequests.status,
          fromShiftInstanceId: swapRequests.fromShiftInstanceId,
          fromAssignmentId: swapRequests.fromAssignmentId,
          toShiftInstanceId: swapRequests.toShiftInstanceId,
          toAssignmentId: swapRequests.toAssignmentId,
        })
        .from(swapRequests)
        .where(
          and(
            eq(swapRequests.id, aggregate.id),
            eq(swapRequests.institutionId, context.institutionId),
            eq(swapRequests.hospitalId, context.hospitalId!),
            eq(swapRequests.sectorId, context.sectorId!),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !swap ||
        swap.version !== aggregate.version ||
        swap.status !== transitionContract.aggregateStatus ||
        swap.fromShiftInstanceId !== context.shiftInstanceId ||
        swap.fromAssignmentId !== context.assignmentId
      ) {
        throw new OperationalEventValidationError(
          "Troca não pertence ao contexto ou versão canônica do evento",
        );
      }
      if (swap.toShiftInstanceId === null) {
        if (swap.toAssignmentId !== null) {
          throw new OperationalEventValidationError(
            "Troca canônica possui contrapartida inconsistente",
          );
        }
        return [];
      }
      const [counterpartShift] = await tx
        .select({
          institutionId: shiftInstances.institutionId,
          hospitalId: shiftInstances.hospitalId,
          sectorId: shiftInstances.sectorId,
          scheduleContextId: shiftInstances.scheduleContextId,
        })
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, swap.toShiftInstanceId),
            eq(shiftInstances.institutionId, context.institutionId),
          ),
        )
        .limit(1)
        .for("update");
      if (!counterpartShift) {
        throw new OperationalEventValidationError(
          "Turno de contrapartida não pertence à troca canônica",
        );
      }
      if (swap.toAssignmentId !== null) {
        const [counterpartAssignment] = await tx
          .select({ id: shiftAssignmentsV2.id })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.id, swap.toAssignmentId),
              eq(
                shiftAssignmentsV2.institutionId,
                counterpartShift.institutionId,
              ),
              eq(shiftAssignmentsV2.hospitalId, counterpartShift.hospitalId),
              eq(shiftAssignmentsV2.sectorId, counterpartShift.sectorId),
              eq(shiftAssignmentsV2.shiftInstanceId, swap.toShiftInstanceId),
            ),
          )
          .limit(1)
          .for("update");
        if (!counterpartAssignment) {
          throw new OperationalEventValidationError(
            "Alocação de contrapartida não pertence à troca canônica",
          );
        }
      }
      return [
        {
          relationKind: "COUNTERPART",
          context: {
            institutionId: counterpartShift.institutionId,
            hospitalId: counterpartShift.hospitalId,
            scopeKind: "SECTOR",
            sectorId: counterpartShift.sectorId,
            scheduleContextId: counterpartShift.scheduleContextId,
            shiftInstanceId: swap.toShiftInstanceId,
            assignmentId: swap.toAssignmentId,
          },
        },
      ];
    }
    case "MONTHLY_ROSTER": {
      const [roster] = await tx
        .select({
          id: monthlyRosters.id,
          version: monthlyRosters.version,
          status: monthlyRosters.status,
        })
        .from(monthlyRosters)
        .where(
          and(
            eq(monthlyRosters.id, aggregate.id),
            eq(monthlyRosters.institutionId, context.institutionId),
            eq(monthlyRosters.hospitalId, context.hospitalId!),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !roster ||
        roster.version !== aggregate.version ||
        roster.status !== transitionContract.aggregateStatus
      ) {
        throw new OperationalEventValidationError(
          "Escala mensal não pertence ao contexto ou versão canônica do evento",
        );
      }
      return [];
    }
    default:
      throw new OperationalEventValidationError(
        "Agregado sem revisão canônica não pode emitir evento operacional",
      );
  }
}

function validateCreateInput(
  input: CreateOperationalEventInput,
): CanonicalOperationalEventInput {
  assertNonBlank(
    input.idempotencyKey,
    "idempotencyKey",
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  if (!isOperationalEventType(input.eventType)) {
    throw new OperationalEventValidationError("eventType inválido");
  }
  if ("emissionMode" in (input as object)) {
    throw new OperationalEventValidationError(
      "Modo de emissão é definido exclusivamente pelo servidor",
    );
  }
  if (!isDeliveryPolicy(input.deliveryPolicy)) {
    throw new OperationalEventValidationError("deliveryPolicy inválida");
  }
  if (!isOperationalAggregateType(input.aggregate.type)) {
    throw new OperationalEventValidationError("aggregate.type inválido");
  }
  assertPositiveInteger(input.aggregate.id, "aggregate.id");
  if (
    !Number.isSafeInteger(input.aggregate.version) ||
    input.aggregate.version < 0
  ) {
    throw new OperationalEventValidationError(
      "aggregate.version deve ser inteiro não negativo",
    );
  }
  validateOperationalContext(input.context, "context");
  const contract = OPERATIONAL_EVENT_CONTRACTS[input.eventType];
  const emissionMode = getOperationalEventEmissionMode(input.eventType);
  if (contract.aggregateType !== input.aggregate.type) {
    throw new OperationalEventValidationError(
      "aggregate.type não corresponde ao eventType",
    );
  }
  if (!contract.deliveryPolicies.includes(input.deliveryPolicy)) {
    throw new OperationalEventValidationError(
      "deliveryPolicy não corresponde ao eventType",
    );
  }
  if (!contract.scopeKinds.includes(input.context.scopeKind)) {
    throw new OperationalEventValidationError(
      "scopeKind não corresponde ao eventType",
    );
  }
  if (
    contract.recipientMembership === "CANONICAL_ASSIGNMENT_HISTORICAL" &&
    emissionMode !== "SHADOW"
  ) {
    throw new OperationalEventValidationError(
      "Destinatário histórico só é permitido em emissão SHADOW",
    );
  }
  for (const contextId of contract.requiredContextIds ?? []) {
    assertPositiveInteger(
      input.context[contextId],
      `context.${contextId} é obrigatório para ${input.eventType}`,
    );
  }
  if (
    contract.aggregateIdContextId &&
    input.aggregate.id !== input.context[contract.aggregateIdContextId]
  ) {
    throw new OperationalEventValidationError(
      "aggregate.id não corresponde ao recurso canônico do contexto",
    );
  }
  const usesAssignmentOperationalRevision =
    contract.aggregateRevision === "SHIFT_ASSIGNMENT_OPERATIONAL" &&
    contract.aggregateType === "SHIFT_ASSIGNMENT" &&
    input.aggregate.type === "SHIFT_ASSIGNMENT";
  const usesVacancyRequestOperationalRevision =
    contract.aggregateRevision === "VACANCY_REQUEST_OPERATIONAL" &&
    contract.aggregateType === "VACANCY_REQUEST" &&
    input.aggregate.type === "VACANCY_REQUEST";
  if (
    !usesAssignmentOperationalRevision &&
    !usesVacancyRequestOperationalRevision &&
    OPERATIONAL_AGGREGATE_VERSION_CAPABILITIES[input.aggregate.type] !==
      "ROW_VERSION"
  ) {
    throw new OperationalEventValidationError(
      "Agregado ainda não possui revisão canônica; emissão operacional bloqueada",
    );
  }
  if (input.actor.kind === "USER") {
    assertPositiveInteger(input.actor.userId, "actor.userId");
    assertNullablePositiveInteger(
      input.actor.professionalId,
      "actor.professionalId",
    );
    if (!isOperationalUserActorRole(input.actor.role)) {
      throw new OperationalEventValidationError("actor.role inválido");
    }
  } else if (input.actor.kind === "SYSTEM") {
    if (!isOperationalSystemActorRole(input.actor.role)) {
      throw new OperationalEventValidationError("actor.role inválido");
    }
  } else {
    throw new OperationalEventValidationError("actor.kind inválido");
  }
  if (
    input.transition?.from !== undefined &&
    input.transition.from !== null &&
    !isOperationalTransitionState(input.transition.from)
  ) {
    throw new OperationalEventValidationError("transition.from inválido");
  }
  if (
    input.transition?.to !== undefined &&
    input.transition.to !== null &&
    !isOperationalTransitionState(input.transition.to)
  ) {
    throw new OperationalEventValidationError("transition.to inválido");
  }
  const canonicalTransition =
    OPERATIONAL_EVENT_TRANSITION_CONTRACTS[input.eventType];
  if (!canonicalTransition) {
    throw new OperationalEventValidationError(
      "Evento ainda não possui contrato canônico de transição; emissão bloqueada",
    );
  }
  if (
    (input.transition?.from ?? null) !== canonicalTransition.from ||
    (input.transition?.to ?? null) !== canonicalTransition.to
  ) {
    throw new OperationalEventValidationError(
      "transition não corresponde ao contrato canônico do evento",
    );
  }
  if ("metadata" in (input as object)) {
    throw new OperationalEventValidationError(
      "Evento operacional não aceita metadata livre",
    );
  }
  if (input.transition && "reason" in (input.transition as object)) {
    throw new OperationalEventValidationError(
      "Evento operacional não aceita reason livre",
    );
  }
  if (
    input.occurredAt !== undefined &&
    (!(input.occurredAt instanceof Date) ||
      !Number.isFinite(input.occurredAt.getTime()))
  ) {
    throw new OperationalEventValidationError("occurredAt inválido");
  }

  const recipients = normalizedRecipients(input.recipients);
  if (input.deliveryPolicy === "SILENT_AUDITED" && recipients.length !== 0) {
    throw new OperationalEventValidationError(
      "Evento SILENT_AUDITED não pode possuir destinatários",
    );
  }
  normalizedRelatedContexts(input.relatedContexts);

  const actor: OperationalEventActor =
    input.actor.kind === "USER"
      ? {
          kind: "USER",
          userId: input.actor.userId,
          professionalId: input.actor.professionalId ?? null,
          role: input.actor.role,
        }
      : { kind: "SYSTEM", role: input.actor.role };
  const normalizedRecipientsSnapshot = Object.freeze(
    recipients.map((recipient) =>
      Object.freeze({
        ...recipient,
        channels: Object.freeze(
          [...recipient.channels].sort(compareCanonicalStrings),
        ),
      }),
    ),
  ) as readonly OperationalEventRecipient[];

  // A partir deste ponto o caller não participa mais da operação: nenhuma
  // leitura após await pode observar uma mutação adversarial do objeto input.
  return Object.freeze({
    idempotencyKey: input.idempotencyKey,
    eventType: input.eventType,
    emissionMode,
    deliveryPolicy: input.deliveryPolicy,
    aggregate: Object.freeze({
      type: input.aggregate.type,
      id: input.aggregate.id,
      version: input.aggregate.version,
    }),
    transition: Object.freeze({
      from: input.transition?.from ?? null,
      to: input.transition?.to ?? null,
    }),
    context: Object.freeze(normalizedContext(input.context)),
    actor: Object.freeze(actor),
    recipients: normalizedRecipientsSnapshot,
    recipientResolution: resolveRecipientResolution(
      input,
      normalizedRecipientsSnapshot,
    ),
    occurredAt:
      input.occurredAt === undefined
        ? undefined
        : new Date(input.occurredAt.getTime()),
  });
}

function identityProjection(
  input: CanonicalOperationalEventInput,
  relatedContexts: readonly OperationalEventRelatedContext[] = [],
): Record<string, unknown> {
  return {
    eventType: input.eventType,
    emissionMode: input.emissionMode,
    deliveryPolicy: input.deliveryPolicy,
    aggregate: {
      type: input.aggregate.type,
      id: input.aggregate.id,
      version: input.aggregate.version,
    },
    transition: {
      from: input.transition.from,
      to: input.transition.to,
    },
    context: input.context,
    actor:
      input.actor.kind === "USER"
        ? {
            kind: "USER",
            userId: input.actor.userId,
            professionalId: input.actor.professionalId,
            role: input.actor.role,
          }
        : {
            kind: "SYSTEM",
            role: input.actor.role,
          },
    relatedContexts: relatedContexts.map((related) => ({
      relationKind: related.relationKind,
      context: related.context,
    })),
    recipientResolution: input.recipientResolution,
    recipients: input.recipients.map((recipient) => ({
      ...recipient,
      channels: recipient.channels,
    })),
  };
}

export function operationalEventHash(
  input: CreateOperationalEventInput,
): string {
  return sha256(canonicalJson(identityProjection(validateCreateInput(input))));
}

export function operationalDeliveryDedupKey(input: {
  institutionId: number;
  eventIdempotencyKey: string;
  emissionMode: OperationalEventEmissionMode;
  recipient: OperationalEventRecipient;
  channel: OperationalDeliveryChannel;
}): string {
  return sha256(
    canonicalJson({
      institutionId: input.institutionId,
      eventIdempotencyKey: input.eventIdempotencyKey,
      emissionMode: input.emissionMode,
      recipient: targetKey(input.recipient),
      channel: input.channel,
    }),
  );
}

/**
 * Insere o fato e seus destinatários no mesmo commit da mutação de negócio que
 * o chamar. A fila multicanal só é persistida para um fato ACTIVE; SHADOW
 * registra a auditoria sem criar entregas latentes. A função relê e bloqueia a
 * topologia, o agregado e os vínculos envolvidos antes de persistir o ledger;
 * ela recusa contexto incompleto em vez de tentar derivar autoridade de texto
 * ou de estado do cliente.
 */
export async function createOperationalEventInTransaction(
  tx: OperationalEventTx,
  input: CreateOperationalEventInput,
): Promise<OperationalEventCreateResult> {
  const eventInput = validateCreateInput(input);
  const occurredAt = eventInput.occurredAt ?? new Date();

  await assertActorInInstitution(
    tx,
    eventInput.context.institutionId,
    eventInput.actor,
  );
  await assertResourceContextConsistency(tx, eventInput.context);
  const relatedContexts = await resolveCanonicalAggregateContexts(
    tx,
    eventInput,
  );
  const eventHash = sha256(
    canonicalJson(identityProjection(eventInput, relatedContexts)),
  );
  await assertRecipientsInInstitution(
    tx,
    eventInput.context.institutionId,
    eventInput.recipients,
    OPERATIONAL_EVENT_CONTRACTS[eventInput.eventType],
  );

  let created = false;
  const idempotencyKeyHash = sha256(eventInput.idempotencyKey);
  try {
    await tx.insert(operationalEvents).values({
      idempotencyKeyHash,
      eventHash,
      eventType: eventInput.eventType,
      emissionMode: eventInput.emissionMode,
      deliveryPolicy: eventInput.deliveryPolicy,
      recipientResolution: eventInput.recipientResolution,
      aggregateType: eventInput.aggregate.type,
      aggregateId: eventInput.aggregate.id,
      aggregateVersion: eventInput.aggregate.version,
      transitionFrom: eventInput.transition.from,
      transitionTo: eventInput.transition.to,
      actorKind: eventInput.actor.kind,
      actorUserId:
        eventInput.actor.kind === "USER" ? eventInput.actor.userId : null,
      actorProfessionalId:
        eventInput.actor.kind === "USER"
          ? eventInput.actor.professionalId
          : null,
      actorRole: eventInput.actor.role,
      institutionId: eventInput.context.institutionId,
      hospitalId: eventInput.context.hospitalId,
      scopeKind: eventInput.context.scopeKind,
      sectorId: eventInput.context.sectorId,
      scheduleContextId: eventInput.context.scheduleContextId,
      shiftInstanceId: eventInput.context.shiftInstanceId,
      assignmentId: eventInput.context.assignmentId,
      occurredAt,
    });
    created = true;
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
  }

  const [event] = await tx
    .select({
      id: operationalEvents.id,
      eventHash: operationalEvents.eventHash,
    })
    .from(operationalEvents)
    .where(
      and(
        eq(operationalEvents.institutionId, eventInput.context.institutionId),
        eq(operationalEvents.idempotencyKeyHash, idempotencyKeyHash),
      ),
    )
    .limit(1);
  if (!event) {
    throw new Error("Evento operacional não foi persistido");
  }
  if (event.eventHash !== eventHash) {
    throw new OperationalEventIdempotencyCollisionError();
  }

  // A colisão da chave única é o único sinal confiável para um retry, inclusive
  // para SILENT_AUDITED, que legitimamente não possui recipients. Não usamos a
  // existência de recipients como heurística porque ela confundiria esse caso.
  if (!created) {
    return { eventId: event.id, created: false, eventHash };
  }

  for (const related of relatedContexts) {
    await tx.insert(operationalEventRelatedContexts).values({
      operationalEventId: event.id,
      relationKind: related.relationKind,
      institutionId: related.context.institutionId,
      hospitalId: related.context.hospitalId ?? null,
      scopeKind: related.context.scopeKind,
      sectorId: related.context.sectorId ?? null,
      scheduleContextId: related.context.scheduleContextId ?? null,
      shiftInstanceId: related.context.shiftInstanceId ?? null,
      assignmentId: related.context.assignmentId ?? null,
    });
  }

  for (const recipient of eventInput.recipients) {
    const [recipientRow] = await tx
      .insert(operationalEventRecipients)
      .values(
        recipient.kind === "USER"
          ? {
              operationalEventId: event.id,
              institutionId: eventInput.context.institutionId,
              recipientKind: "USER",
              userId: recipient.userId,
              scheduleInviteId: null,
            }
          : {
              operationalEventId: event.id,
              institutionId: eventInput.context.institutionId,
              recipientKind: "SCHEDULE_INVITE",
              userId: null,
              scheduleInviteId: recipient.scheduleInviteId,
            },
      )
      .$returningId();
    if (!recipientRow?.id) {
      throw new Error("Destinatário operacional não foi persistido");
    }
    for (const channel of operationalDeliveryChannelsForEmission(
      eventInput.emissionMode,
      recipient.channels,
    )) {
      await tx.insert(notificationDeliveries).values({
        operationalEventRecipientId: recipientRow.id,
        channel,
        status: "QUEUED",
        dedupKey: operationalDeliveryDedupKey({
          institutionId: eventInput.context.institutionId,
          eventIdempotencyKey: eventInput.idempotencyKey,
          emissionMode: eventInput.emissionMode,
          recipient,
          channel,
        }),
        attemptCount: 0,
        availableAt: occurredAt,
      });
    }
  }

  return { eventId: event.id, created: true, eventHash };
}

export function hashOperationalEmailAddress(email: string): string {
  if (typeof email !== "string") {
    throw new OperationalEventValidationError("E-mail operacional inválido");
  }
  const normalized = email.trim().toLocaleLowerCase("en-US");
  if (!normalized || normalized.length > 320) {
    throw new OperationalEventValidationError("E-mail operacional inválido");
  }
  return sha256(normalized);
}

export function isTrustedOperationalEmail(input: {
  state: OperationalEmailTrustState;
  trustedEmailHash: string;
  currentEmail: string | null | undefined;
}): boolean {
  if (input.state !== "TRUSTED" || !input.currentEmail) return false;
  return (
    hashOperationalEmailAddress(input.currentEmail) === input.trustedEmailHash
  );
}

export function isTerminalOperationalDeliveryStatus(
  status: OperationalDeliveryStatus,
): boolean {
  return status === "DELIVERED" || status === "DEAD" || status === "SKIPPED";
}

export function isOperationalDeliveryRetryExhausted(
  attemptCount: number,
): boolean {
  return (
    Number.isSafeInteger(attemptCount) &&
    attemptCount >= OPERATIONAL_DELIVERY_MAX_ATTEMPTS
  );
}

/**
 * Backoff exponencial com jitter positivo limitado a 20%. A fonte de aleatoriedade
 * é injetável para testes; o worker futuro deve consultar
 * `isOperationalDeliveryRetryExhausted` antes de reagendar a sétima tentativa.
 */
export function operationalDeliveryRetryDelayMs(
  attemptCount: number,
  random: () => number = Math.random,
): number {
  const normalizedAttempt =
    Number.isSafeInteger(attemptCount) && attemptCount >= 1 ? attemptCount : 1;
  const baseDelay = Math.min(
    60_000 * 2 ** (normalizedAttempt - 1),
    60 * 60 * 1000,
  );
  const entropy = random();
  const boundedEntropy = Number.isFinite(entropy)
    ? Math.max(0, Math.min(entropy, 0.999_999))
    : 0;
  return baseDelay + Math.floor(baseDelay * 0.2 * boundedEntropy);
}
