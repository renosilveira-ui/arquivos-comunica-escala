// server/natural-language/swap-intent-date.ts — data dita → dia do hospital.
//
// Fronteira de fuso desta frente. Toda conta de dia/hora passa pelos
// helpers canônicos de `server/local-time.ts` (offset fixo −03:00), nunca
// pelo fuso do processo: o servidor roda em UTC no Render e, entre 21h e
// meia-noite no Brasil, `new Date().getDate()` já devolve o dia seguinte.

import {
  addDaysToKey,
  dayKeyBrt,
  hourBrt,
  weekdayOfKey,
} from "../local-time";
import type { DateExpression, ShiftPeriod } from "./swap-intent-types";

export const WEEKDAY_LABEL = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
] as const;

export const PERIOD_LABEL: Record<ShiftPeriod, string> = {
  MORNING: "manhã",
  AFTERNOON: "tarde",
  NIGHT: "noite",
};

/**
 * Turno pelo horário de INÍCIO no relógio do hospital:
 * manhã 05h–12h, tarde 12h–18h, noite 18h–05h.
 *
 * Classificar pelo início (e não por hora exata 07/13/19) é o que mantém
 * plantão de 19h–07h resolvível como noite mesmo atravessando a meia-noite.
 */
export function periodOfStart(startAt: Date): ShiftPeriod {
  const hour = hourBrt(startAt);
  if (hour >= 5 && hour < 12) return "MORNING";
  if (hour >= 12 && hour < 18) return "AFTERNOON";
  return "NIGHT";
}

export type DateResolution =
  | { ok: true; dayKey: string; said: string }
  | { ok: false; message: string };

/**
 * Resolve a data dita para uma chave "YYYY-MM-DD" do relógio do hospital.
 * `NEXT_SHIFT` não tem dia: quem o usa busca o próximo plantão futuro.
 */
export function resolveDateExpression(
  expression: DateExpression,
  now: Date,
): DateResolution {
  const today = dayKeyBrt(now);
  let dayKey: string;

  switch (expression.kind) {
    case "OFFSET":
      dayKey = addDaysToKey(today, expression.days);
      break;
    case "WEEKDAY": {
      let delta = (expression.weekday - weekdayOfKey(today) + 7) % 7;
      if (delta === 0 && expression.forceNext) delta = 7;
      dayKey = addDaysToKey(today, delta);
      break;
    }
    case "ABSOLUTE": {
      const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
      let year = todayYear;
      let month = expression.month ?? todayMonth;
      if (expression.month === null && expression.day < todayDay) {
        // Sem mês dito, "dia 2" no dia 20 é o dia 2 do mês que vem.
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      } else if (
        expression.month !== null &&
        (month < todayMonth || (month === todayMonth && expression.day < todayDay))
      ) {
        year += 1; // mês já passou neste ano → ano que vem
      }
      const probe = new Date(Date.UTC(year, month - 1, expression.day));
      if (probe.getUTCMonth() + 1 !== month) {
        return {
          ok: false,
          message: `O dia ${expression.day} não existe em ${String(month).padStart(2, "0")}/${year}.`,
        };
      }
      dayKey = `${year}-${String(month).padStart(2, "0")}-${String(expression.day).padStart(2, "0")}`;
      break;
    }
    case "NEXT_SHIFT":
      return { ok: false, message: "Seu próximo plantão não depende de um dia." };
  }

  if (dayKey < today) {
    return {
      ok: false,
      message: "Esse plantão já passou — só é possível trocar ou ceder plantões futuros.",
    };
  }
  return { ok: true, dayKey, said: expression.said };
}

/** "DD/MM" a partir de uma chave "YYYY-MM-DD" (sem reinterpretar fuso). */
export function formatDayKeyShort(dayKey: string): string {
  const [, month, day] = dayKey.split("-");
  return `${day}/${month}`;
}

/** "quarta, 09/09" — como a pessoa reconhece o dia. */
export function formatDayKeyHuman(dayKey: string): string {
  return `${WEEKDAY_LABEL[weekdayOfKey(dayKey)]}, ${formatDayKeyShort(dayKey)}`;
}
