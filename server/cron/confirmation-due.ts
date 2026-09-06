// Antecedência da solicitação de confirmação de presença.
//
// A descoberta é due-based: assignment OCUPADO com startAt futuro e
// dueAt = startAt - lead <= agora. Não depende de gatilho 11/17/22 nem
// de janela de 20 min no relógio de parede.
//
// Lead operacional atual = compatibilidade histórica do cron 11/17/22
// (commit 74e73ad / #145). Não há requisito de produto inequívoco de
// “2h” ou “9h” em docs/product. Até o owner escolher:
//   CONFIRMATION_LEAD_TIME_OWNER_DECISION_REQUIRED
//   A = 07:00±30 → 9h; demais → 2h  (compatibilidade histórica; vigente)
//   B = 2h universal
//   C = configurável (só com requisito real de múltiplas políticas)
//
// A dúvida é dueAt = startAt - ?, não due-based vs trigger fixo.

export const HOSPITAL_TIME_ZONE =
  process.env.TZ_HOSPITAL || "America/Sao_Paulo";

/** Antecedência histórica do plantão das 07:00 (gatilho 22:00 do dia anterior). */
export const CONFIRMATION_MORNING_LEAD_MS = 9 * 60 * 60 * 1000;

/** Antecedência histórica de Tarde/Noite e default para início off-grid. */
export const CONFIRMATION_DEFAULT_LEAD_MS = 2 * 60 * 60 * 1000;

/** Teto da janela SQL de discovery: deriva do maior lead vigente, não de 9h solto. */
export const CONFIRMATION_MAX_LEAD_MS = Math.max(
  CONFIRMATION_MORNING_LEAD_MS,
  CONFIRMATION_DEFAULT_LEAD_MS,
);

/** Tolerância histórica de matching do início canônico (±30 min). */
export const CANONICAL_START_TOLERANCE_MIN = 30;

const MINUTES_PER_DAY = 24 * 60;
const MORNING_START_MIN = 7 * 60;

export function hospitalLocalClock(
  at: Date,
  timeZone: string = HOSPITAL_TIME_ZONE,
): { hours: number; minutes: number; dateStr: string } {
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => local.find((part) => part.type === type)?.value ?? "0";
  return {
    hours: Number(get("hour")),
    minutes: Number(get("minute")),
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function minutesFromMidnight(at: Date, timeZone: string): number {
  const clock = hospitalLocalClock(at, timeZone);
  return clock.hours * 60 + clock.minutes;
}

function circularMinuteDelta(left: number, right: number): number {
  const delta = Math.abs(left - right);
  return Math.min(delta, MINUTES_PER_DAY - delta);
}

export function confirmationLeadMs(
  startAt: Date,
  timeZone: string = HOSPITAL_TIME_ZONE,
): number {
  const startMinute = minutesFromMidnight(startAt, timeZone);
  if (
    circularMinuteDelta(startMinute, MORNING_START_MIN) <=
    CANONICAL_START_TOLERANCE_MIN
  ) {
    return CONFIRMATION_MORNING_LEAD_MS;
  }
  return CONFIRMATION_DEFAULT_LEAD_MS;
}

export function confirmationDueAt(
  startAt: Date,
  timeZone: string = HOSPITAL_TIME_ZONE,
): Date {
  return new Date(startAt.getTime() - confirmationLeadMs(startAt, timeZone));
}

export function isDueForConfirmation(
  startAt: Date,
  now: Date,
  timeZone: string = HOSPITAL_TIME_ZONE,
): boolean {
  return (
    startAt.getTime() > now.getTime() &&
    confirmationDueAt(startAt, timeZone).getTime() <= now.getTime()
  );
}

/** Janela SQL: startAt ∈ (now, now + maxLead]. O filtro de due fica no aplicativo. */
export function confirmationDiscoveryStartAtRange(now: Date): {
  after: Date;
  until: Date;
} {
  return {
    after: now,
    until: new Date(now.getTime() + CONFIRMATION_MAX_LEAD_MS),
  };
}
