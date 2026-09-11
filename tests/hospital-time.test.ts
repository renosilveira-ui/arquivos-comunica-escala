import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildShiftTimestamps,
  formatHospitalDate,
  formatHospitalDateLong,
  formatHospitalTime,
  formatHospitalTimeRange,
  hospitalDateTime,
  toHospitalISODate,
} from "../lib/hospital-time";

const HOSPITAL_TIME_UI = [
  "app/shift-details.tsx",
  "app/edit-shift.tsx",
  "app/(tabs)/dashboard.tsx",
  "app/(tabs)/vacancies.tsx",
  "app/confirm-duty.tsx",
  "app/report.tsx",
  "app/(tabs)/agenda.tsx",
  "components/agenda/ShiftRowCard.tsx",
] as const;

/**
 * Telas que mostram data/hora vinda do SERVIDOR mas não necessariamente
 * formatam hora de plantão: aqui a guarda só proíbe os padrões que leem o
 * relógio do aparelho, sem exigir `formatHospitalTime`.
 *
 * Quatro arquivos ficam de fora DE PROPÓSITO, porque misturam instante do
 * servidor com data de calendário LOCAL — e a local está certa:
 *   app/(tabs)/pending.tsx        chips de dia (quickDates + toLocalISODateString)
 *   app/create-shift.tsx          rótulo do mês do calendário
 *   components/shift-filters.tsx  data escolhida no date picker
 *   app/google-calendar.tsx       "última sincronização", que não é plantão
 * Os instantes de plantão DESSES arquivos foram corrigidos mesmo assim; o que
 * não dá é blindar o arquivo inteiro por regex sem proibir a data local junto.
 */
const HOSPITAL_DATE_UI = [
  "app/my-offers.tsx",
  "app/my-applications.tsx",
  "app/approve-swaps.tsx",
  "app/request-swap.tsx",
  "app/schedule-invites.tsx",
  "app/audit-log.tsx",
  "components/swaps/AvailableSwapsList.tsx",
] as const;

/**
 * Dívida NOMEADA, não furo desconhecido: a Agenda ainda deriva "hoje" e "esta
 * semana" do relógio do aparelho (`startOfWeekMon`). As outras 6 chamadas da
 * função recebem datas de grade já locais por construção e estão corretas, então
 * a correção é trocar só os dois pontos que partem de `new Date()` — mudança que
 * merece verificação visual da tela principal, fora do escopo deste PR.
 */
const SET_HOURS_PENDENTE: ReadonlySet<string> = new Set([
  "app/(tabs)/agenda.tsx",
]);

describe("hospital-time", () => {
  it("formata hora no relógio do hospital (-03:00), não no fuso do processo", () => {
    const start = new Date("2026-09-07T10:00:00.000Z");
    const end = new Date("2026-09-07T16:00:00.000Z");
    expect(formatHospitalTime(start)).toBe("07:00");
    expect(formatHospitalTime(end)).toBe("13:00");
    expect(formatHospitalTimeRange(start, end)).toBe("07:00–13:00");
    expect(formatHospitalDate(start)).toBe("07/09/2026");
    expect(formatHospitalDate(new Date("2026-09-02T10:00:00.000-03:00"))).toBe(
      "02/09/2026",
    );
  });

  it("buildShiftTimestamps grava instante UTC do horário de parede", () => {
    const [startAt, endAt] = buildShiftTimestamps(
      "2026-09-07",
      "07:00:00",
      "13:00:00",
    );
    expect(startAt.toISOString()).toBe("2026-09-07T10:00:00.000Z");
    expect(endAt.toISOString()).toBe("2026-09-07T16:00:00.000Z");
  });

  it("buildShiftTimestamps avança término do turno noturno", () => {
    const [startAt, endAt] = buildShiftTimestamps(
      "2026-09-07",
      "19:00:00",
      "07:00:00",
    );
    expect(startAt.toISOString()).toBe("2026-09-07T22:00:00.000Z");
    expect(endAt.toISOString()).toBe("2026-09-08T10:00:00.000Z");
    expect(formatHospitalTimeRange(startAt, endAt)).toBe("19:00–07:00");
  });

  it("toHospitalISODate devolve o dia do hospital, não o do processo", () => {
    // 01:00Z de 08/09 ainda é 07/09 às 22:00 no hospital.
    expect(toHospitalISODate(new Date("2026-09-08T01:00:00.000Z"))).toBe(
      "2026-09-07",
    );
    expect(toHospitalISODate(new Date("2026-09-07T10:00:00.000Z"))).toBe(
      "2026-09-07",
    );
  });

  it("hospitalDateTime ancora o campo do formulário em -03:00", () => {
    expect(hospitalDateTime("2026-09-07", "07:00").toISOString()).toBe(
      "2026-09-07T10:00:00.000Z",
    );
    expect(hospitalDateTime("2026-09-07", "19:00").toISOString()).toBe(
      "2026-09-07T22:00:00.000Z",
    );
  });

  it("editar plantão faz a volta completa sem passar pelo fuso do aparelho", () => {
    // O que o servidor devolve → o que o formulário mostra → o que é gravado.
    const doServidor = new Date("2026-09-07T22:00:00.000Z");
    const data = toHospitalISODate(doServidor);
    const hora = formatHospitalTime(doServidor);
    expect([data, hora]).toEqual(["2026-09-07", "19:00"]);
    expect(hospitalDateTime(data, hora).toISOString()).toBe(
      doServidor.toISOString(),
    );
  });

  it("telas de plantão usam o relógio do hospital, não o fuso do dispositivo", () => {
    for (const file of HOSPITAL_TIME_UI) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(/formatHospitalTime(Range)?/);
    }

    for (const file of [...HOSPITAL_TIME_UI, ...HOSPITAL_DATE_UI]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("toLocaleTimeString");
      expect(source, file).not.toMatch(/\.getHours\s*\(/);
      // Sem `timeZone`, estas lêem o fuso do aparelho: perto da meia-noite a
      // DATA diverge da HORA na mesma tela. Use formatHospitalDateLong.
      expect(source, file).not.toMatch(/\.toLocaleDateString\s*\(/);
      expect(source, file).not.toMatch(/\.toLocaleString\s*\(/);
      if (!SET_HOURS_PENDENTE.has(file)) {
        expect(source, file).not.toMatch(/\.setHours\s*\(/);
      }
    }
  });

  it("a lista de dívida de setHours não cresce sem alguém decidir", () => {
    // Nomear a dívida só serve se ela não puder aumentar em silêncio.
    expect([...SET_HOURS_PENDENTE]).toEqual(["app/(tabs)/agenda.tsx"]);
  });

  it("formatHospitalDateLong não escorrega para o fuso do processo", () => {
    // 01:00Z de 08/09 ainda é a noite de 07/09 no hospital.
    expect(
      formatHospitalDateLong(new Date("2026-09-08T01:00:00.000Z"), {
        weekday: "long",
        day: "2-digit",
        month: "long",
      }),
    ).toBe("segunda-feira, 07 de setembro");
  });
});
