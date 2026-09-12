import {
  formatHospitalDate,
  formatHospitalTime,
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

export type AssignmentLifecyclePresentationPurpose =
  | "ASSIGNED"
  | "UNASSIGNED";

export type SwapOfferPresentationAudience = "OPEN" | "DIRECTED";

export type SwapTakenPresentationType = "SWAP" | "TRANSFER" | "CESSAO";

/** O que o plano de deslocamento calculou, lido do banco no envio. */
export type CanonicalDeparturePlanContext = Readonly<{
  departAt: Date | string;
  estimatedDurationSeconds: number | null;
}>;

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

export function assignmentLifecyclePushPresentation(
  purpose: AssignmentLifecyclePresentationPurpose,
  context: CanonicalShiftPushContext,
): ContextualPushPresentation | null {
  const title = normalizedContextTitle(context);
  if (!title) return null;
  const shift = shiftReference(context);
  switch (purpose) {
    case "ASSIGNED":
      return contextualPresentation(
        title,
        `Você foi escalado para o plantão de ${shift}.`,
      );
    case "UNASSIGNED":
      return contextualPresentation(
        title,
        `Sua alocação no plantão de ${shift} foi retirada.`,
      );
  }
}

export function vacancyBroadcastPushPresentation(
  context: CanonicalShiftPushContext,
): ContextualPushPresentation | null {
  const title = normalizedContextTitle(context);
  if (!title) return null;
  return contextualPresentation(
    title,
    `Há um plantão vago em ${shiftReference(context)}.`,
  );
}

export function swapOfferPushPresentation(
  audience: SwapOfferPresentationAudience,
  context: CanonicalShiftPushContext,
): ContextualPushPresentation | null {
  const title = normalizedContextTitle(context);
  if (!title) return null;
  const shift = shiftReference(context);
  return audience === "DIRECTED"
    ? contextualPresentation(
        title,
        `Há uma nova oferta direcionada a você para ${shift}.`,
      )
    : contextualPresentation(
        title,
        `Há uma nova oferta de plantão disponível para ${shift}.`,
      );
}

export function swapTakenPushPresentation(
  type: SwapTakenPresentationType,
  context: CanonicalShiftPushContext,
): ContextualPushPresentation | null {
  const title = normalizedContextTitle(context);
  if (!title) return null;
  const shift = shiftReference(context);
  return type === "SWAP"
    ? contextualPresentation(
        title,
        `Sua troca de plantão de ${shift} foi concluída.`,
      )
    : contextualPresentation(
        title,
        `Seu plantão de ${shift} foi assumido.`,
      );
}

/**
 * Aviso de deslocamento: a única notificação cujo VALOR é o conteúdo.
 *
 * As outras podem dizer "abra o aplicativo" sem perder muito — a informação
 * está lá dentro. Esta não: ela existe para dizer a que horas sair de casa, e
 * chega uma hora antes do plantão, quando o médico está fazendo outra coisa.
 * Um aviso genérico aqui é um aviso inútil, porque obriga a abrir o app
 * justamente para descobrir se era urgente.
 *
 * Por isso ela ganhou apresentação contextual. Até 12/09/2026 não tinha
 * nenhuma, e todo aviso de deslocamento saía como "Há uma atualização
 * disponível. Abra o aplicativo para consultar." — o PO recebeu exatamente
 * isso e não soube do que se tratava.
 *
 * Sem nome de pessoa, como as demais: hospital, setor, horário do plantão e
 * a hora de sair. Tudo reconstruído do banco no envio, nada vindo do
 * produtor da notificação.
 */
export function departurePushPresentation(
  context: CanonicalShiftPushContext,
  plan: CanonicalDeparturePlanContext,
): ContextualPushPresentation | null {
  const title = normalizedContextTitle(context);
  if (!title) return null;

  const departAt = new Date(plan.departAt);
  if (!Number.isFinite(departAt.getTime())) return null;

  const inicio = formatHospitalTime(context.startAt);
  const saida = formatHospitalTime(departAt);
  if (!inicio || !saida) return null;

  const minutos =
    plan.estimatedDurationSeconds !== null &&
    Number.isFinite(plan.estimatedDurationSeconds) &&
    plan.estimatedDurationSeconds > 0
      ? Math.max(1, Math.round(plan.estimatedDurationSeconds / 60))
      : null;

  // Sem estimativa de trânsito o aviso ainda vale: a hora de sair é o que o
  // médico precisa. A estimativa entra como justificativa, quando existe.
  const corpo =
    minutos === null
      ? `Plantão às ${inicio}. Saia até ${saida}.`
      : `Plantão às ${inicio}. Cerca de ${minutos} min de trajeto — saia até ${saida}.`;

  return contextualPresentation(title, corpo);
}
