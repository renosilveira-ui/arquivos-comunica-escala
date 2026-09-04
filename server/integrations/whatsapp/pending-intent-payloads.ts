/**
 * Contratos JSON versionados da conversa WhatsApp pendente (B2-A).
 *
 * Tipos runtime do núcleo NL (`SwapIntentDraft`, `ResolvedSwapIntent`) NÃO
 * são o schema de storage. Serializers copiam campos explícitos para V1.
 * Versão desconhecida → fail-closed, sem fallback.
 *
 * `resolved_payload` é snapshot semântico. NÃO é autorização. Mesmo no
 * futuro B5, `createSwapOffer()` revalida ownership, elegibilidade, mês
 * publicado e estado stale. Este módulo não chama `createSwapOffer`.
 *
 * Clarification de escolha humana persiste opção já projetada
 * (`professionalId`/`sectorId` + `label`), nunca o candidate cru do
 * resolver (`{ professionalId, name }`). `label` é identificação humana
 * segura produzida por B2-B/B2-C. Duas opções com o mesmo label
 * normalizado não são selecionáveis: ou labels distintos, ou
 * `unresolvedGroups`. Este módulo não consulta o banco para enriquecer.
 */
import { z } from "zod";
import type {
  ResolvedSwapIntent,
  SwapIntentDraft,
} from "../../natural-language/swap-intent-types";

export const WHATSAPP_PENDING_PAYLOAD_VERSION = 1 as const;

const FORBIDDEN_PARSED_KEYS = new Set([
  "userid",
  "professionalid",
  "institutionid",
  "hospitalid",
  "sectorid",
  "shiftinstanceid",
  "assignmentid",
  "phone",
  "telefone",
  "email",
  "body",
  "signature",
  "token",
  "authtoken",
  "media",
  "mediaurl",
]);

function isForbiddenParsedKey(key: string): boolean {
  if (key.endsWith("Id") || key.endsWith("_id")) return true;
  return FORBIDDEN_PARSED_KEYS.has(key.toLowerCase());
}

export function assertWhatsAppParsedPayloadHasNoInternalIds(
  value: unknown,
  path = "$",
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertWhatsAppParsedPayloadHasNoInternalIds(item, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenParsedKey(key)) {
      throw new Error(`PARSED_PAYLOAD_FORBIDDEN_KEY:${path}.${key}`);
    }
    assertWhatsAppParsedPayloadHasNoInternalIds(child, `${path}.${key}`);
  }
}

const dateExpressionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("OFFSET"),
    days: z.number().int(),
    said: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("WEEKDAY"),
    weekday: z.number().int().min(0).max(6),
    forceNext: z.boolean(),
    said: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("ABSOLUTE"),
    day: z.number().int().min(1).max(31),
    month: z.number().int().min(1).max(12).nullable(),
    said: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("NEXT_SHIFT"),
    said: z.string().min(1),
  }),
]);

const periodSchema = z.enum(["MORNING", "AFTERNOON", "NIGHT"]);

const shiftSlotSchema = z.strictObject({
  date: dateExpressionSchema.nullable(),
  period: periodSchema.nullable(),
  sectorText: z.string().min(1).nullable(),
});

const ownShiftSlotSchema = z.strictObject({
  date: dateExpressionSchema,
  period: periodSchema.nullable(),
  sectorText: z.string().min(1).nullable(),
});

const targetProfessionalSlotSchema = z.strictObject({
  name: z.string().min(1),
});

const parsedSwapSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  kind: z.literal("SWAP"),
  ownShift: ownShiftSlotSchema,
  targetProfessional: targetProfessionalSlotSchema,
  targetShift: shiftSlotSchema,
});

const parsedCessaoSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  kind: z.literal("CESSAO"),
  ownShift: ownShiftSlotSchema,
  targetProfessional: targetProfessionalSlotSchema,
});

export const whatsappParsedSwapIntentV1Schema = z.discriminatedUnion("kind", [
  parsedSwapSchema,
  parsedCessaoSchema,
]);

export type WhatsAppParsedSwapIntentV1 = z.infer<
  typeof whatsappParsedSwapIntentV1Schema
>;

const shiftSummarySchema = z.strictObject({
  label: z.string().min(1),
  sectorName: z.string().min(1),
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeRange: z.string().min(1),
});

const resolvedSwapSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  kind: z.literal("SWAP"),
  institutionId: z.number().int().positive(),
  fromShiftInstanceId: z.number().int().positive(),
  fromAssignmentId: z.number().int().positive(),
  toProfessionalId: z.number().int().positive(),
  toShiftInstanceId: z.number().int().positive(),
  targetProfessionalName: z.string().min(1),
  ownShift: shiftSummarySchema,
  targetShift: shiftSummarySchema,
});

const resolvedCessaoSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  kind: z.literal("CESSAO"),
  institutionId: z.number().int().positive(),
  fromShiftInstanceId: z.number().int().positive(),
  fromAssignmentId: z.number().int().positive(),
  toProfessionalId: z.number().int().positive(),
  toShiftInstanceId: z.null(),
  targetProfessionalName: z.string().min(1),
  ownShift: shiftSummarySchema,
  targetShift: z.null(),
});

export const whatsappResolvedSwapIntentV1Schema = z.discriminatedUnion("kind", [
  resolvedSwapSchema,
  resolvedCessaoSchema,
]);

export type WhatsAppResolvedSwapIntentV1 = z.infer<
  typeof whatsappResolvedSwapIntentV1Schema
>;

export const WHATSAPP_UNRESOLVED_HOMONYM_CODE = "UNRESOLVED_HOMONYM" as const;

const humanChoiceLabelSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);

const sectorChoiceSchema = z.strictObject({
  sectorId: z.number().int().positive(),
  label: humanChoiceLabelSchema,
});

const professionalChoiceSchema = z.strictObject({
  professionalId: z.number().int().positive(),
  label: humanChoiceLabelSchema,
});

const unresolvedHomonymGroupSchema = z.strictObject({
  code: z.literal(WHATSAPP_UNRESOLVED_HOMONYM_CODE),
  label: humanChoiceLabelSchema,
  count: z.number().int().min(2),
});

/**
 * Mesma identidade visual da #409 (`normalizeRecipientIdentityText`):
 * case, acento e espaço não distinguem duas opções humanas.
 */
export function normalizeWhatsAppChoiceLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function labelContainsInternalId(label: string, id: number): boolean {
  const digits = String(id);
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(label);
}

type HumanChoiceRef = { id: number; label: string };
type UnresolvedHomonymGroupV1 = {
  code: typeof WHATSAPP_UNRESOLVED_HOMONYM_CODE;
  label: string;
  count: number;
};

function assertHumanChoiceSet(input: {
  choices: readonly HumanChoiceRef[];
  unresolvedGroups: readonly UnresolvedHomonymGroupV1[];
}): void {
  if (input.choices.length === 0 && input.unresolvedGroups.length === 0) {
    throw new Error("CLARIFICATION_EMPTY_CHOICE_SET");
  }
  const seen = new Set<string>();
  for (const choice of input.choices) {
    const trimmed = choice.label.trim();
    if (!trimmed) throw new Error("CHOICE_LABEL_EMPTY");
    if (labelContainsInternalId(trimmed, choice.id)) {
      throw new Error("CHOICE_LABEL_CONTAINS_INTERNAL_ID");
    }
    const key = normalizeWhatsAppChoiceLabel(trimmed);
    if (!key) throw new Error("CHOICE_LABEL_EMPTY");
    if (seen.has(key)) throw new Error("INDISTINGUISHABLE_CHOICES");
    seen.add(key);
  }
  for (const group of input.unresolvedGroups) {
    const trimmed = group.label.trim();
    if (!trimmed) throw new Error("UNRESOLVED_LABEL_EMPTY");
    const key = normalizeWhatsAppChoiceLabel(trimmed);
    if (!key) throw new Error("UNRESOLVED_LABEL_EMPTY");
    if (seen.has(key)) throw new Error("INDISTINGUISHABLE_CHOICES");
    seen.add(key);
  }
}

const shiftCandidateSchema = z.strictObject({
  shiftInstanceId: z.number().int().positive(),
  label: z.string().min(1),
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeRange: z.string().min(1),
  sectorName: z.string().min(1),
  institutionName: z.string().min(1),
});

const clarificationAmbiguousIntentSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  code: z.literal("AMBIGUOUS_INTENT"),
});

const clarificationSectorSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  code: z.literal("AMBIGUOUS_SECTOR"),
  candidates: z.array(sectorChoiceSchema),
  unresolvedGroups: z.array(unresolvedHomonymGroupSchema),
});

const clarificationOwnShiftSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  code: z.literal("AMBIGUOUS_OWN_SHIFT"),
  candidates: z.array(shiftCandidateSchema).min(1),
});

const clarificationTargetShiftSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  code: z.literal("AMBIGUOUS_TARGET_SHIFT"),
  candidates: z.array(shiftCandidateSchema).min(1),
});

const clarificationTargetShiftRequiredSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  code: z.literal("SWAP_TARGET_SHIFT_REQUIRED"),
  candidates: z.array(shiftCandidateSchema).min(1),
});

const clarificationTargetProfessionalSchema = z.strictObject({
  version: z.literal(WHATSAPP_PENDING_PAYLOAD_VERSION),
  code: z.literal("AMBIGUOUS_TARGET_PROFESSIONAL"),
  candidates: z.array(professionalChoiceSchema),
  unresolvedGroups: z.array(unresolvedHomonymGroupSchema),
});

export const whatsappClarificationV1Schema = z.discriminatedUnion("code", [
  clarificationAmbiguousIntentSchema,
  clarificationSectorSchema,
  clarificationOwnShiftSchema,
  clarificationTargetShiftSchema,
  clarificationTargetShiftRequiredSchema,
  clarificationTargetProfessionalSchema,
]);

export type WhatsAppClarificationV1 = z.infer<
  typeof whatsappClarificationV1Schema
>;

export type WhatsAppPayloadParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "INVALID_PAYLOAD" };

function parseWith<T>(
  schema: z.ZodType<T>,
  input: unknown,
  extraGuard?: (value: T) => void,
): WhatsAppPayloadParseResult<T> {
  const result = schema.safeParse(input);
  if (!result.success) return { ok: false, code: "INVALID_PAYLOAD" };
  try {
    extraGuard?.(result.data);
  } catch {
    return { ok: false, code: "INVALID_PAYLOAD" };
  }
  return { ok: true, value: result.data };
}

export function parseStoredParsedIntent(
  input: unknown,
): WhatsAppPayloadParseResult<WhatsAppParsedSwapIntentV1> {
  return parseWith(whatsappParsedSwapIntentV1Schema, input, (value) => {
    assertWhatsAppParsedPayloadHasNoInternalIds(value);
  });
}

export function parseStoredResolvedIntent(
  input: unknown,
): WhatsAppPayloadParseResult<WhatsAppResolvedSwapIntentV1> {
  return parseWith(whatsappResolvedSwapIntentV1Schema, input);
}

export function parseStoredClarification(
  input: unknown,
): WhatsAppPayloadParseResult<WhatsAppClarificationV1> {
  return parseWith(whatsappClarificationV1Schema, input, (value) => {
    assertClarificationHasNoPii(value);
    assertClarificationHumanChoices(value);
  });
}

function assertClarificationHumanChoices(value: WhatsAppClarificationV1): void {
  if (value.code === "AMBIGUOUS_TARGET_PROFESSIONAL") {
    assertHumanChoiceSet({
      choices: value.candidates.map((choice) => ({
        id: choice.professionalId,
        label: choice.label,
      })),
      unresolvedGroups: value.unresolvedGroups,
    });
    return;
  }
  if (value.code === "AMBIGUOUS_SECTOR") {
    assertHumanChoiceSet({
      choices: value.candidates.map((choice) => ({
        id: choice.sectorId,
        label: choice.label,
      })),
      unresolvedGroups: value.unresolvedGroups,
    });
  }
}

export function projectWhatsAppTargetProfessionalClarificationV1(input: {
  candidates: readonly { professionalId: number; label: string }[];
  unresolvedGroups: readonly { label: string; count: number }[];
}): WhatsAppPayloadParseResult<
  Extract<WhatsAppClarificationV1, { code: "AMBIGUOUS_TARGET_PROFESSIONAL" }>
> {
  const parsed = parseStoredClarification({
    version: WHATSAPP_PENDING_PAYLOAD_VERSION,
    code: "AMBIGUOUS_TARGET_PROFESSIONAL",
    candidates: input.candidates,
    unresolvedGroups: input.unresolvedGroups.map((group) => ({
      code: WHATSAPP_UNRESOLVED_HOMONYM_CODE,
      label: group.label,
      count: group.count,
    })),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.code !== "AMBIGUOUS_TARGET_PROFESSIONAL") {
    return { ok: false, code: "INVALID_PAYLOAD" };
  }
  return { ok: true, value: parsed.value };
}

export function projectWhatsAppSectorClarificationV1(input: {
  candidates: readonly { sectorId: number; label: string }[];
  unresolvedGroups: readonly { label: string; count: number }[];
}): WhatsAppPayloadParseResult<
  Extract<WhatsAppClarificationV1, { code: "AMBIGUOUS_SECTOR" }>
> {
  const parsed = parseStoredClarification({
    version: WHATSAPP_PENDING_PAYLOAD_VERSION,
    code: "AMBIGUOUS_SECTOR",
    candidates: input.candidates,
    unresolvedGroups: input.unresolvedGroups.map((group) => ({
      code: WHATSAPP_UNRESOLVED_HOMONYM_CODE,
      label: group.label,
      count: group.count,
    })),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.code !== "AMBIGUOUS_SECTOR") {
    return { ok: false, code: "INVALID_PAYLOAD" };
  }
  return { ok: true, value: parsed.value };
}

function assertClarificationHasNoPii(value: WhatsAppClarificationV1): void {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (
        lower === "email" ||
        lower === "phone" ||
        lower === "telefone" ||
        lower === "cpf" ||
        lower === "name"
      ) {
        throw new Error("CLARIFICATION_PII");
      }
      walk(child);
    }
  };
  walk(value);
}

function shiftSummaryFromResolved(shift: {
  label: string;
  sectorName: string;
  dayKey: string;
  timeRange: string;
}) {
  return {
    label: shift.label,
    sectorName: shift.sectorName,
    dayKey: shift.dayKey,
    timeRange: shift.timeRange,
  };
}

export function serializeParsedSwapIntentV1(
  draft: SwapIntentDraft,
): WhatsAppPayloadParseResult<WhatsAppParsedSwapIntentV1> {
  if (draft.kind === "SWAP") {
    return parseStoredParsedIntent({
      version: WHATSAPP_PENDING_PAYLOAD_VERSION,
      kind: "SWAP",
      ownShift: {
        date: draft.ownShift.date,
        period: draft.ownShift.period,
        sectorText: draft.ownShift.sectorText,
      },
      targetProfessional: { name: draft.targetProfessional.name },
      targetShift: {
        date: draft.targetShift.date,
        period: draft.targetShift.period,
        sectorText: draft.targetShift.sectorText,
      },
    });
  }
  return parseStoredParsedIntent({
    version: WHATSAPP_PENDING_PAYLOAD_VERSION,
    kind: "CESSAO",
    ownShift: {
      date: draft.ownShift.date,
      period: draft.ownShift.period,
      sectorText: draft.ownShift.sectorText,
    },
    targetProfessional: { name: draft.targetProfessional.name },
  });
}

export function serializeResolvedSwapIntentV1(
  resolved: ResolvedSwapIntent,
): WhatsAppPayloadParseResult<WhatsAppResolvedSwapIntentV1> {
  const base = {
    version: WHATSAPP_PENDING_PAYLOAD_VERSION,
    institutionId: resolved.institutionId,
    fromShiftInstanceId: resolved.ownShift.shiftInstanceId,
    fromAssignmentId: resolved.ownShift.assignmentId,
    toProfessionalId: resolved.targetProfessional.professionalId,
    targetProfessionalName: resolved.targetProfessional.name,
    ownShift: shiftSummaryFromResolved(resolved.ownShift),
  };
  if (resolved.kind === "SWAP") {
    return parseStoredResolvedIntent({
      ...base,
      kind: "SWAP",
      toShiftInstanceId: resolved.targetShift.shiftInstanceId,
      targetShift: shiftSummaryFromResolved(resolved.targetShift),
    });
  }
  return parseStoredResolvedIntent({
    ...base,
    kind: "CESSAO",
    toShiftInstanceId: null,
    targetShift: null,
  });
}

export type WhatsAppPendingParseAdvanceOutcome =
  | {
      type: "clarification";
      parsed: null;
      clarification: Extract<WhatsAppClarificationV1, { code: "AMBIGUOUS_INTENT" }>;
    }
  | {
      type: "clarification";
      parsed: WhatsAppParsedSwapIntentV1;
      clarification: Exclude<
        WhatsAppClarificationV1,
        { code: "AMBIGUOUS_INTENT" }
      >;
    }
  | {
      type: "resolved";
      parsed: WhatsAppParsedSwapIntentV1;
      resolved: WhatsAppResolvedSwapIntentV1;
    };

export type AdvanceWhatsAppPendingFromParseInput = {
  pendingId: number;
  userId: number;
  expectedSourceInboundMessageId: number;
  outcome: WhatsAppPendingParseAdvanceOutcome;
};

const ambiguousIntentOutcomeSchema = z.strictObject({
  type: z.literal("clarification"),
  parsed: z.null(),
  clarification: clarificationAmbiguousIntentSchema,
});

const clarificationWithParsedOutcomeSchema = z.strictObject({
  type: z.literal("clarification"),
  parsed: whatsappParsedSwapIntentV1Schema,
  clarification: z.discriminatedUnion("code", [
    clarificationSectorSchema,
    clarificationOwnShiftSchema,
    clarificationTargetShiftSchema,
    clarificationTargetShiftRequiredSchema,
    clarificationTargetProfessionalSchema,
  ]),
});

const resolvedOutcomeSchema = z.strictObject({
  type: z.literal("resolved"),
  parsed: whatsappParsedSwapIntentV1Schema,
  resolved: whatsappResolvedSwapIntentV1Schema,
});

export const advanceWhatsAppPendingFromParseInputSchema = z.strictObject({
  pendingId: z.number().int().positive(),
  userId: z.number().int().positive(),
  expectedSourceInboundMessageId: z.number().int().positive(),
  outcome: z.union([
    ambiguousIntentOutcomeSchema,
    clarificationWithParsedOutcomeSchema,
    resolvedOutcomeSchema,
  ]),
});

export function parseAdvanceWhatsAppPendingFromParseInput(
  input: unknown,
): WhatsAppPayloadParseResult<AdvanceWhatsAppPendingFromParseInput> {
  const parsed = parseWith(advanceWhatsAppPendingFromParseInputSchema, input);
  if (!parsed.ok) return parsed;
  if (parsed.value.outcome.type === "resolved") {
    if (parsed.value.outcome.parsed.kind !== parsed.value.outcome.resolved.kind) {
      return { ok: false, code: "INVALID_PAYLOAD" };
    }
    try {
      assertWhatsAppParsedPayloadHasNoInternalIds(parsed.value.outcome.parsed);
    } catch {
      return { ok: false, code: "INVALID_PAYLOAD" };
    }
  } else if (parsed.value.outcome.parsed) {
    try {
      assertWhatsAppParsedPayloadHasNoInternalIds(parsed.value.outcome.parsed);
    } catch {
      return { ok: false, code: "INVALID_PAYLOAD" };
    }
  }
  return parsed;
}

export function payloadsCanonicalEqual(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a == null || b == null) return false;
  const parsedA = parseStoredParsedIntent(a);
  const parsedB = parseStoredParsedIntent(b);
  if (parsedA.ok && parsedB.ok) {
    return JSON.stringify(parsedA.value) === JSON.stringify(parsedB.value);
  }
  const resolvedA = parseStoredResolvedIntent(a);
  const resolvedB = parseStoredResolvedIntent(b);
  if (resolvedA.ok && resolvedB.ok) {
    return JSON.stringify(resolvedA.value) === JSON.stringify(resolvedB.value);
  }
  const clarA = parseStoredClarification(a);
  const clarB = parseStoredClarification(b);
  if (clarA.ok && clarB.ok) {
    return JSON.stringify(clarA.value) === JSON.stringify(clarB.value);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export type WhatsAppPendingAdvanceRowView = {
  status: string;
  stage: string;
  intentKind: string | null;
  parsedPayload: unknown;
  resolvedPayload: unknown;
  clarificationPayload: unknown;
  institutionId: number | null;
};

export function confirmationInvariantsHold(
  row: WhatsAppPendingAdvanceRowView,
): boolean {
  if (row.status !== "OPEN" || row.stage !== "CONFIRMATION") return false;
  if (row.intentKind == null || row.institutionId == null) return false;
  if (row.clarificationPayload != null) return false;
  const parsed = parseStoredParsedIntent(row.parsedPayload);
  const resolved = parseStoredResolvedIntent(row.resolvedPayload);
  if (!parsed.ok || !resolved.ok) return false;
  if (parsed.value.kind !== row.intentKind) return false;
  if (resolved.value.kind !== row.intentKind) return false;
  if (resolved.value.institutionId !== row.institutionId) return false;
  return true;
}

export function clarificationInvariantsHold(
  row: WhatsAppPendingAdvanceRowView,
): boolean {
  if (row.status !== "OPEN" || row.stage !== "CLARIFICATION") return false;
  if (row.resolvedPayload != null) return false;
  if (row.institutionId != null) return false;
  const clarification = parseStoredClarification(row.clarificationPayload);
  if (!clarification.ok) return false;
  if (clarification.value.code === "AMBIGUOUS_INTENT") {
    return row.intentKind == null && row.parsedPayload == null;
  }
  const parsed = parseStoredParsedIntent(row.parsedPayload);
  if (!parsed.ok) return false;
  return row.intentKind === parsed.value.kind;
}
