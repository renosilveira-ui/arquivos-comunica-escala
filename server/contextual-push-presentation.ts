import {
  formatHospitalDate,
  formatHospitalTimeRange,
} from "../lib/hospital-time";

const CONTEXTUAL_PUSH_PRESENTATION_BRAND = Symbol(
  "contextual-push-presentation-v1",
);

export type ContextualPushPresentation = Readonly<{
  title: string;
  body: string;
  [CONTEXTUAL_PUSH_PRESENTATION_BRAND]: true;
}>;

export type CanonicalShiftPushContext = Readonly<{
  hospitalName: string;
  sectorName: string;
  startAt: Date | string;
  endAt: Date | string;
}>;

export type DutyConfirmationPresentationPurpose =
  | "CONFIRMATION_REQUEST"
  | "NOMINATION_REQUEST"
  | "REPLACEMENT_ACCEPTED_NOTICE"
  | "REPLACEMENT_DECLINED_NOTICE"
  | "SSO_READY"
  | "MANAGER_ESCALATION";

export type VacancyRequestPresentationPurpose =
  "MANAGER_ACTION_REQUIRED" | "REQUEST_APPROVED" | "REQUEST_REJECTED";

const MAX_CONTEXT_LABEL_CHARACTERS = 80;

function normalizedLabel(value: string): string {
  const compact = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return Array.from(compact).slice(0, MAX_CONTEXT_LABEL_CHARACTERS).join("");
}

function normalizedContextTitle(
  context: CanonicalShiftPushContext,
): string | null {
  const hospitalName = normalizedLabel(context.hospitalName);
  const sectorName = normalizedLabel(context.sectorName);
  if (!hospitalName || !sectorName) return null;
  return `${hospitalName} · ${sectorName}`;
}

function contextualPresentation(
  title: string,
  body: string,
): ContextualPushPresentation {
  const presentation = { title, body } as ContextualPushPresentation;
  Object.defineProperty(presentation, CONTEXTUAL_PUSH_PRESENTATION_BRAND, {
    value: true,
    enumerable: false,
  });
  return Object.freeze(presentation);
}

export function isContextualPushPresentation(
  value: unknown,
): value is ContextualPushPresentation {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<ContextualPushPresentation>)[
      CONTEXTUAL_PUSH_PRESENTATION_BRAND
    ] === true &&
    typeof (value as Partial<ContextualPushPresentation>).title === "string" &&
    typeof (value as Partial<ContextualPushPresentation>).body === "string"
  );
}

function shiftReference(context: CanonicalShiftPushContext): string {
  return `${formatHospitalDate(context.startAt)}, ${formatHospitalTimeRange(
    context.startAt,
    context.endAt,
  )}`;
}

/**
 * Cópia de tela bloqueada sem nomes de pessoas nem texto vindo do caller.
 * O chamador só pode usar o resultado depois de reconstruir a autoridade e a
 * topologia canônicas no banco imediatamente antes da submissão ao Expo.
 */
export function dutyConfirmationPushPresentation(
  purpose: DutyConfirmationPresentationPurpose,
  context: CanonicalShiftPushContext,
): ContextualPushPresentation | null {
  const title = normalizedContextTitle(context);
  if (!title) return null;
  const shift = shiftReference(context);
  switch (purpose) {
    case "CONFIRMATION_REQUEST":
      return contextualPresentation(title, `Confirme seu plantão de ${shift}.`);
    case "NOMINATION_REQUEST":
      return contextualPresentation(
        title,
        `Há uma nova oferta direcionada a você para ${shift}.`,
      );
    case "REPLACEMENT_ACCEPTED_NOTICE":
      return contextualPresentation(
        title,
        `O substituto aceitou o plantão de ${shift}.`,
      );
    case "REPLACEMENT_DECLINED_NOTICE":
      return contextualPresentation(
        title,
        `O substituto não aceitou o plantão de ${shift}.`,
      );
    case "SSO_READY":
      return contextualPresentation(title, `Seu plantão de ${shift} começou.`);
    case "MANAGER_ESCALATION":
      return contextualPresentation(
        title,
        `Uma confirmação do plantão de ${shift} requer verificação do gestor.`,
      );
  }
}

export function vacancyRequestPushPresentation(
  purpose: VacancyRequestPresentationPurpose,
  context: CanonicalShiftPushContext,
): ContextualPushPresentation | null {
  const title = normalizedContextTitle(context);
  if (!title) return null;
  const shift = shiftReference(context);
  switch (purpose) {
    case "MANAGER_ACTION_REQUIRED":
      return contextualPresentation(
        title,
        `Há uma nova solicitação para o plantão de ${shift}.`,
      );
    case "REQUEST_APPROVED":
      return contextualPresentation(
        title,
        `Sua solicitação para o plantão de ${shift} foi aprovada.`,
      );
    case "REQUEST_REJECTED":
      return contextualPresentation(
        title,
        `Sua solicitação para o plantão de ${shift} não foi aprovada.`,
      );
  }
}
