import { describe, expect, it } from "vitest";

import {
  IMPORT_MAX_EVENTS_PER_RUN,
  IMPORT_SOURCE_CALENDAR_ID,
  draftFromExternalEvent,
  importMutationId,
} from "../server/integrations/google/import";
import type { ExternalCalendarEvent } from "../server/integrations/providers/calendar-provider";

const TZ = "America/Sao_Paulo";

function event(
  overrides: Partial<ExternalCalendarEvent> = {},
): ExternalCalendarEvent {
  return {
    externalEventId: "abc123",
    calendarId: IMPORT_SOURCE_CALENDAR_ID,
    etag: '"1"',
    summary: "Consulta",
    startsAtUtc: new Date("2026-09-15T17:30:00Z"), // 14:30 em São Paulo
    endsAtUtc: new Date("2026-09-15T18:30:00Z"),
    allDay: false,
    busy: true,
    cancelled: false,
    originMarker: null,
    ...overrides,
  };
}

/**
 * A tradução de instante para data/hora civil é o ponto que mais erra em
 * calendário. Um compromisso das 14:30 que vira 17:30 no app é um médico
 * chegando três horas atrasado — e confiando no app.
 */
describe("evento do Google → rascunho de compromisso", () => {
  it("compromisso com hora fica no fuso do usuário, não em UTC", () => {
    const draft = draftFromExternalEvent(event(), TZ);
    expect(draft.kind).toBe("APPOINTMENT");
    expect(draft.allDay).toBe(false);
    expect(draft.timeZone).toBe(TZ);
    if (draft.kind === "APPOINTMENT" && !draft.allDay) {
      expect(draft.startLocalDate).toBe("2026-09-15");
      expect(draft.startLocalTime).toBe("14:30");
      expect(draft.endLocalDate).toBe("2026-09-15");
      expect(draft.endLocalTime).toBe("15:30");
    }
  });

  it("compromisso que cruza a meia-noite local muda de data no fim", () => {
    const draft = draftFromExternalEvent(
      event({
        startsAtUtc: new Date("2026-09-16T02:00:00Z"), // 23:00 do dia 15 em SP
        endsAtUtc: new Date("2026-09-16T04:00:00Z"), // 01:00 do dia 16
      }),
      TZ,
    );
    if (draft.kind === "APPOINTMENT" && !draft.allDay) {
      expect(draft.startLocalDate).toBe("2026-09-15");
      expect(draft.startLocalTime).toBe("23:00");
      expect(draft.endLocalDate).toBe("2026-09-16");
      expect(draft.endLocalTime).toBe("01:00");
    }
  });

  /**
   * O Google marca dia inteiro com fim EXCLUSIVO: um evento de um dia vai de
   * 15/09 00:00 a 16/09 00:00. Copiar isso literalmente faria todo evento de
   * dia inteiro ocupar dois dias no app.
   */
  it("dia inteiro: fim exclusivo do Google vira fim inclusivo", () => {
    const draft = draftFromExternalEvent(
      event({
        allDay: true,
        startsAtUtc: new Date("2026-09-15T00:00:00Z"),
        endsAtUtc: new Date("2026-09-16T00:00:00Z"),
      }),
      TZ,
    );
    expect(draft.allDay).toBe(true);
    if (draft.kind === "APPOINTMENT" && draft.allDay) {
      expect(draft.startLocalDate).toBe("2026-09-15");
      expect(draft.endLocalDate).toBe("2026-09-15");
    }
  });

  it("dia inteiro de vários dias preserva a duração", () => {
    const draft = draftFromExternalEvent(
      event({
        allDay: true,
        startsAtUtc: new Date("2026-09-15T00:00:00Z"),
        endsAtUtc: new Date("2026-09-18T00:00:00Z"),
      }),
      TZ,
    );
    if (draft.kind === "APPOINTMENT" && draft.allDay) {
      expect(draft.startLocalDate).toBe("2026-09-15");
      expect(draft.endLocalDate).toBe("2026-09-17");
    }
  });

  it("dia inteiro sem fim válido não vira duração negativa", () => {
    const draft = draftFromExternalEvent(
      event({
        allDay: true,
        startsAtUtc: new Date("2026-09-15T00:00:00Z"),
        endsAtUtc: new Date("2026-09-15T00:00:00Z"),
      }),
      TZ,
    );
    if (draft.kind === "APPOINTMENT" && draft.allDay) {
      expect(draft.endLocalDate).toBe("2026-09-15");
    }
  });

  it("disponibilidade segue o Google: ocupado é ocupado, livre é livre", () => {
    expect(draftFromExternalEvent(event({ busy: true }), TZ).availability).toBe(
      "BUSY",
    );
    expect(
      draftFromExternalEvent(event({ busy: false }), TZ).availability,
    ).toBe("FREE");
  });

  it("título vazio não vira compromisso sem nome, e título longo cabe no campo", () => {
    expect(draftFromExternalEvent(event({ summary: "" }), TZ).title).toBe(
      "(sem título)",
    );
    const long = "x".repeat(500);
    expect(
      draftFromExternalEvent(event({ summary: long }), TZ).title.length,
    ).toBe(160);
  });

  it("nunca traz notas nem localização do Google", () => {
    const draft = draftFromExternalEvent(event(), TZ);
    expect(draft.notes).toBeNull();
    expect(draft.locationLabel).toBeNull();
    expect(draft.latitude).toBeNull();
  });
});

/**
 * A idempotência da importação é a chave única `(owner, client_mutation_id)`
 * do banco. Ela só funciona se o id for o MESMO a cada ciclo para o mesmo
 * evento — e couber na coluna.
 */
describe("identidade da importação", () => {
  it("é determinística e cabe em 64 caracteres", () => {
    const a = importMutationId("primary", "abc123");
    const b = importMutationId("primary", "abc123");
    expect(a).toBe(b);
    expect(a).toBe("google:primary:abc123");
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it("id longo do Google ainda cabe e continua distinto", () => {
    const x = importMutationId("primary", "a".repeat(80));
    const y = importMutationId("primary", "a".repeat(79) + "b");
    expect(x.length).toBeLessThanOrEqual(64);
    expect(y.length).toBeLessThanOrEqual(64);
    expect(x).not.toBe(y);
  });

  it("lê só o calendário principal e limita o lote", () => {
    expect(IMPORT_SOURCE_CALENDAR_ID).toBe("primary");
    expect(IMPORT_MAX_EVENTS_PER_RUN).toBeGreaterThan(50);
    expect(IMPORT_MAX_EVENTS_PER_RUN).toBeLessThanOrEqual(1000);
  });
});
