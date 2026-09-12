import { and, asc, desc, eq } from "drizzle-orm";

import {
  hospitals,
  institutions,
  professionalInstitutions,
} from "../drizzle/schema";
// Somente tipo: o resolvedor é puro e não deve arrastar o pool de conexões
// para dentro de uma suíte que não usa banco.
import type { getDb } from "./db";
import { civilDateTimeToInstant } from "./personal-calendar-domain";
import { addDaysToKey, addMonthsYearMonth, weekdayOfKey } from "./local-time";

/**
 * Fuso IANA por instituição e por hospital.
 *
 * Hoje o domínio de escala inteiro assume `-03:00` fixo (`server/local-time.ts`).
 * Isso está correto para São Paulo e errado para qualquer instituição futura
 * fora desse offset — e passaria a doer de verdade quando a rota e o aviso de
 * saída passarem a somar minutos sobre um horário de plantão.
 *
 * Esta frente NÃO reescreve o domínio temporal. Ela instala a fonte da
 * verdade (coluna + resolução + janela consciente de fuso) para que os
 * chamadores migrem um a um, com teste de compatibilidade, conforme a regra
 * de não mudar todo o domínio temporal numa PR só. `local-time.ts` continua
 * valendo enquanto o backfill mantém todas as instituições em
 * `America/Sao_Paulo`, onde os dois caminhos coincidem.
 */

export const DEFAULT_SCHEDULE_TIME_ZONE = "America/Sao_Paulo";

const DAY_MS = 24 * 60 * 60 * 1000;

const timeZoneSupportCache = new Map<string, boolean>();
const MAX_TIME_ZONE_CACHE_ENTRIES = 512;

/** O runtime conhece este fuso? Consulta o ICU, sem tabela própria. */
export function isSupportedTimeZone(timeZone: string): boolean {
  const cached = timeZoneSupportCache.get(timeZone);
  if (cached !== undefined) return cached;
  let supported: boolean;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    supported = true;
  } catch {
    supported = false;
  }
  if (timeZoneSupportCache.size >= MAX_TIME_ZONE_CACHE_ENTRIES) {
    timeZoneSupportCache.clear();
  }
  timeZoneSupportCache.set(timeZone, supported);
  return supported;
}

/**
 * Aceita apenas identificador IANA de região (`Area/Local`). Offsets fixos
 * como `-03:00` e `Etc/GMT+3` são recusados de propósito: eles não carregam
 * regra de horário de verão, e uma instituição gravada assim voltaria a
 * errar a hora no dia em que o fuso dela mudar.
 */
export function normalizeTimeZone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 64) return null;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(value)) {
    return null;
  }
  if (value.startsWith("Etc/")) return null;
  return isSupportedTimeZone(value) ? value : null;
}

/**
 * Fuso efetivo de uma operação: o hospital manda, a instituição é o padrão,
 * e `America/Sao_Paulo` é o piso.
 *
 * Nunca lança. Um valor corrompido no banco não pode derrubar a leitura de
 * uma escala inteira — ele cai para o nível seguinte, e a checagem de
 * integridade é feita na escrita, não aqui.
 */
export function resolveScheduleTimeZone(input: {
  hospitalTimeZone?: unknown;
  institutionTimeZone?: unknown;
}): string {
  return (
    normalizeTimeZone(input.hospitalTimeZone) ??
    normalizeTimeZone(input.institutionTimeZone) ??
    DEFAULT_SCHEDULE_TIME_ZONE
  );
}

type TimeZoneReaderDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

export async function readInstitutionTimeZone(
  db: TimeZoneReaderDb,
  institutionId: number,
): Promise<string> {
  const [row] = await db
    .select({ timeZone: institutions.timeZone })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  return resolveScheduleTimeZone({ institutionTimeZone: row?.timeZone });
}

/**
 * Fuso da CONTA, para operações sem tenant ativo (worker de sincronização,
 * callback OAuth): o da instituição principal da pessoa, ou da primeira
 * ativa; sem vínculo, o padrão do sistema. O botão do app usa o fuso do
 * aparelho; aqui não há aparelho.
 */
export async function resolveUserTimeZone(
  db: TimeZoneReaderDb,
  userId: number,
): Promise<string> {
  const [row] = await db
    .select({ institutionId: professionalInstitutions.institutionId })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .orderBy(
      desc(professionalInstitutions.isPrimary),
      asc(professionalInstitutions.id),
    )
    .limit(1);
  if (!row) return resolveScheduleTimeZone({});
  return readInstitutionTimeZone(db, row.institutionId);
}

/**
 * O hospital é lido sob o tenant informado. Sem o `institution_id` no WHERE,
 * um id de hospital de outra instituição responderia com o fuso dela.
 */
export async function readHospitalTimeZone(
  db: TimeZoneReaderDb,
  institutionId: number,
  hospitalId: number,
): Promise<string> {
  const [row] = await db
    .select({
      hospitalTimeZone: hospitals.timeZone,
      institutionTimeZone: institutions.timeZone,
    })
    .from(hospitals)
    .innerJoin(institutions, eq(institutions.id, hospitals.institutionId))
    .where(
      and(
        eq(hospitals.id, hospitalId),
        eq(hospitals.institutionId, institutionId),
      ),
    )
    .limit(1);
  return resolveScheduleTimeZone({
    hospitalTimeZone: row?.hospitalTimeZone,
    institutionTimeZone: row?.institutionTimeZone,
  });
}

/**
 * Janela [início, fim) de um dia civil no fuso informado.
 *
 * Reusa `civilDateTimeToInstant`, que já resolve transição de horário de
 * verão. Um segundo motor temporal no repositório seria uma segunda chance
 * de divergir.
 */
export function dayWindowInTimeZone(
  dayKey: string,
  timeZone: string,
): { start: Date; end: Date } {
  const zone = normalizeTimeZone(timeZone) ?? DEFAULT_SCHEDULE_TIME_ZONE;
  const start = civilDateTimeToInstant(dayKey, "00:00:00", zone).instant;
  const nextDay = new Date(
    Date.UTC(
      Number(dayKey.slice(0, 4)),
      Number(dayKey.slice(5, 7)) - 1,
      Number(dayKey.slice(8, 10)) + 1,
    ),
  );
  const nextDayKey = nextDay.toISOString().slice(0, 10);
  const end = civilDateTimeToInstant(nextDayKey, "00:00:00", zone).instant;
  return { start, end };
}

// ---------------------------------------------------------------------------
// Aritmética de calendário no fuso de quem opera o plantão
//
// Estes auxiliares saíram de server/shifts-crud.ts em 12/09/2026, quando o
// offset fixo -03:00 de lá foi removido. Moram aqui porque este módulo já é
// a fonte da verdade de fuso, e porque a migração dos demais chamadores de
// server/local-time.ts vai precisar exatamente deles.
// ---------------------------------------------------------------------------

/** Meia-noite de um dia "YYYY-MM-DD" no fuso de quem opera o plantão. */
export function dayStartInZone(dayKey: string, timeZone: string): Date {
  return civilDateTimeToInstant(dayKey, "00:00:00", timeZone).instant;
}

/**
 * Primeira segunda-feira em ou depois de uma data civil.
 *
 * Trabalha em CHAVE de dia, não em instante, de propósito: o dia da semana
 * de uma data do calendário não depende de fuso nenhum — 03/03/2028 é uma
 * sexta-feira em Fortaleza, em Lisboa e em Tóquio. A versão anterior
 * convertia para instante e subtraía três horas fixas para ler o dia da
 * semana, o que amarrava esta conta a UTC-3 sem necessidade.
 */
export function firstMondayKeyOnOrAfter(dayKey: string): string {
  const dow = weekdayOfKey(dayKey);
  return addDaysToKey(dayKey, (8 - dow) % 7);
}

/**
 * Mesma hora de parede, N dias depois, no fuso de quem opera o plantão.
 *
 * A versão anterior somava `N × 24 h` ao instante. Sem horário de verão isso
 * coincide; com ele, replicar uma escala por cima de uma virada moveria todo
 * plantão em uma hora — a escala inteira do mês seguinte sairia deslocada,
 * sem erro nenhum aparecer.
 */
export function shiftInstantByDays(
  instant: Date,
  days: number,
  timeZone: string,
): Date {
  const [dateKey, timeKey] = civilPartsInZone(instant, timeZone);
  return civilDateTimeToInstant(addDaysToKey(dateKey, days), timeKey, timeZone)
    .instant;
}

/**
 * Janela [início, fim) de um mês "YYYY-MM" no fuso de quem opera o plantão.
 *
 * O equivalente fixo em `local-time.ts` (`monthWindowBrt`) segue valendo para
 * quem ainda não migrou; aqui o mês é o do hospital.
 */
export function monthWindowInZone(
  yearMonth: string,
  timeZone: string,
): { start: Date; end: Date } {
  const startKey = `${yearMonth}-01`;
  const nextKey = `${addMonthsYearMonth(yearMonth, 1)}-01`;
  return {
    start: dayStartInZone(startKey, timeZone),
    end: dayStartInZone(nextKey, timeZone),
  };
}

/** "YYYY-MM-DD" e "HH:MM:SS" de um instante, no fuso informado. */
export function civilPartsInZone(instant: Date, timeZone: string): [string, string] {
  // sv-SE entrega exatamente "YYYY-MM-DD HH:MM:SS".
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(instant);
  const [dateKey, timeKey] = formatted.split(" ");
  return [dateKey, timeKey];
}

/**
 * Distância em dias entre duas datas civis.
 *
 * Também sem fuso: a diferença entre 01/03 e 08/03 é sete dias em qualquer
 * lugar do mundo, inclusive num dia de mudança de horário de verão, quando
 * a diferença em HORAS não seria 168.
 */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  const asUtc = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((asUtc(toKey) - asUtc(fromKey)) / DAY_MS);
}

/**
 * Janela de origem [fromStart, fromEnd), janela de destino e o
 * deslocamento em dias locais.
 *
 * - week: 7 dias a partir de from.start → 7 dias a partir de to.start.
 * - month: mês civil de from.start → mês civil de to.start. O
 *   deslocamento alinha a primeira segunda-feira da origem à primeira
 *   segunda-feira do destino, para que cada turno caia no MESMO DIA DA
 *   SEMANA (escala hospitalar é semanal por natureza). Turnos que, com
 *   esse deslocamento, caem fora do mês de destino não são copiados e
 *   contam em outOfRange.
 */
