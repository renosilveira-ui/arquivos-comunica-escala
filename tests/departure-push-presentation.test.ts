import { describe, expect, it } from "vitest";

import {
  departurePushPresentation,
  isContextualPushPresentation,
} from "../server/contextual-push-presentation";
import {
  DEPARTURE_ALERT_PAYLOAD_TYPE,
  departureAuthorityMatchesPayload,
  isDeparturePushPayload,
  parseDeparturePushAuthority,
  type DeparturePushAuthority,
} from "../server/departure-push-authority";

/**
 * O aviso de deslocamento é a única notificação cujo VALOR é o conteúdo.
 *
 * As outras podem dizer "abra o aplicativo" sem perder muito. Esta não:
 * existe para dizer a que horas sair de casa e chega uma hora antes do
 * plantão. Até 12/09/2026 ela era enfileirada SEM autoridade, e o envio —
 * que só libera o texto real quando prova o dono do aparelho — mandava a
 * apresentação neutra. O PO recebeu "Há uma atualização disponível. Abra o
 * aplicativo para consultar." e não soube do que se tratava.
 */

const CONTEXTO = {
  hospitalName: "Hospital São Carlos",
  sectorName: "Sala de Recuperação",
  // 13:00–19:00 no relógio do hospital (-03:00).
  startAt: "2026-09-12T16:00:00.000Z",
  endAt: "2026-09-12T22:00:00.000Z",
} as const;

describe("apresentação do aviso de deslocamento", () => {
  it("diz a hora de sair e o trajeto, sem mandar abrir o app", () => {
    const p = departurePushPresentation(CONTEXTO, {
      departAt: "2026-09-12T15:52:00.000Z",
      estimatedDurationSeconds: 7 * 60,
    });
    expect(p).not.toBeNull();
    expect(isContextualPushPresentation(p)).toBe(true);
    expect(p!.title).toBe("Hospital São Carlos · Sala de Recuperação");
    expect(p!.body).toContain("12:52");
    expect(p!.body).toContain("13:00");
    expect(p!.body).toContain("7 min");
    expect(p!.body).not.toMatch(/atualização disponível|abra o aplicativo/i);
  });

  /** Sem trânsito, a hora de sair ainda é o que o médico precisa. */
  it("sem estimativa de trajeto, ainda diz a hora de sair", () => {
    const p = departurePushPresentation(CONTEXTO, {
      departAt: "2026-09-12T15:52:00.000Z",
      estimatedDurationSeconds: null,
    });
    expect(p!.body).toContain("12:52");
    expect(p!.body).not.toMatch(/min de trajeto/);
  });

  it("arredonda para cima: trajeto de segundos nunca vira zero minuto", () => {
    const p = departurePushPresentation(CONTEXTO, {
      departAt: "2026-09-12T15:52:00.000Z",
      estimatedDurationSeconds: 20,
    });
    expect(p!.body).toContain("1 min");
  });

  it("não cita nome de pessoa nem texto vindo do produtor", () => {
    const p = departurePushPresentation(CONTEXTO, {
      departAt: "2026-09-12T15:52:00.000Z",
      estimatedDurationSeconds: 600,
    });
    // Só hospital, setor e horários — a mesma classe de dado das demais.
    expect(p!.title + p!.body).not.toMatch(/Reno|Heitor|@/);
  });

  it("recusa contexto sem hospital ou setor, e hora de saída inválida", () => {
    expect(
      departurePushPresentation(
        { ...CONTEXTO, hospitalName: "  " },
        { departAt: "2026-09-12T15:52:00.000Z", estimatedDurationSeconds: 60 },
      ),
    ).toBeNull();
    expect(
      departurePushPresentation(CONTEXTO, {
        departAt: "não é data",
        estimatedDurationSeconds: 60,
      }),
    ).toBeNull();
  });
});

describe("autoridade do aviso de deslocamento", () => {
  const AUTORIDADE: DeparturePushAuthority = {
    kind: "DEPARTURE_ALERT",
    planId: 31,
    expectedUserId: 53,
    professionalId: 53,
    assignmentId: 550,
    institutionId: 4,
    hospitalId: 7,
    sectorId: 9,
    shiftInstanceId: 292,
  };

  it("reconhece o payload do aviso", () => {
    expect(isDeparturePushPayload({ type: DEPARTURE_ALERT_PAYLOAD_TYPE })).toBe(
      true,
    );
    expect(isDeparturePushPayload({ type: "shift_assigned" })).toBe(false);
  });

  it("aceita a autoridade completa e recusa a incompleta", () => {
    expect(parseDeparturePushAuthority({ ...AUTORIDADE })).not.toBeNull();
    for (const campo of [
      "planId",
      "expectedUserId",
      "professionalId",
      "assignmentId",
      "institutionId",
      "hospitalId",
      "sectorId",
      "shiftInstanceId",
    ]) {
      const quebrada = { ...AUTORIDADE, [campo]: 0 };
      expect(parseDeparturePushAuthority(quebrada), campo).toBeNull();
    }
    expect(
      parseDeparturePushAuthority({ ...AUTORIDADE, kind: "SWAP_OFFER" }),
    ).toBeNull();
  });

  it("o payload precisa falar do mesmo plantão", () => {
    expect(
      departureAuthorityMatchesPayload(AUTORIDADE, {
        type: DEPARTURE_ALERT_PAYLOAD_TYPE,
        shiftInstanceId: 292,
      }),
    ).toBe(true);
    expect(
      departureAuthorityMatchesPayload(AUTORIDADE, {
        type: DEPARTURE_ALERT_PAYLOAD_TYPE,
        shiftInstanceId: 999,
      }),
    ).toBe(false);
    expect(
      departureAuthorityMatchesPayload(AUTORIDADE, {
        type: "shift_assigned",
        shiftInstanceId: 292,
      }),
    ).toBe(false);
  });
});
