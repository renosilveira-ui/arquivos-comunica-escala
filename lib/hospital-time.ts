/**
 * Horário de parede do hospital (America/Sao_Paulo, offset fixo -03:00).
 *
 * Instantes no banco são UTC; exibição e templates usam sempre o relógio
 * operacional do hospital, independente do fuso do dispositivo ou do servidor.
 */

export const HOSPITAL_TIME_ZONE_OFFSET = "-03:00";
const OFFSET_MS = 3 * 60 * 60 * 1000;

/** Mesmo instante, deslocado para que getters UTC leiam o relógio de parede. */
function asWallClock(date: Date): Date {
  return new Date(date.getTime() - OFFSET_MS);
}

function toDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value;
}

/** HH:mm no relógio do hospital. */
export function formatHospitalTime(date: Date | string): string {
  const w = asWallClock(toDate(date));
  return `${String(w.getUTCHours()).padStart(2, "0")}:${String(w.getUTCMinutes()).padStart(2, "0")}`;
}

/** Faixa HH:mm–HH:mm no relógio do hospital. */
export function formatHospitalTimeRange(
  startAt: Date | string,
  endAt: Date | string,
): string {
  return `${formatHospitalTime(startAt)}–${formatHospitalTime(endAt)}`;
}

/**
 * Combina "YYYY-MM-DD" com "HH:MM:SS" no fuso do hospital.
 * Turno noturno (fim ≤ início) avança o término para o dia seguinte.
 */
export function buildShiftTimestamps(
  date: string,
  startTime: string,
  endTime: string,
): [Date, Date] {
  const startAt = new Date(`${date}T${startTime}${HOSPITAL_TIME_ZONE_OFFSET}`);
  const endAt = new Date(`${date}T${endTime}${HOSPITAL_TIME_ZONE_OFFSET}`);
  if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1);
  return [startAt, endAt];
}
