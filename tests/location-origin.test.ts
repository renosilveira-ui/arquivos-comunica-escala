import { describe, expect, it } from "vitest";

import {
  LOCATION_ACCESS,
  REPORT_SKIP_REASONS,
  locationGuidance,
  shouldReport,
  type LocationAccess,
} from "../lib/location-origin";
import {
  MAX_ACCEPTED_ACCURACY_METERS,
  MIN_MOVEMENT_METERS,
} from "../lib/integration-providers";

const FORTALEZA = { latitude: -3.7507478, longitude: -38.498879 };

function point(
  overrides: Partial<{
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
  }> = {},
) {
  return { ...FORTALEZA, accuracyMeters: 25, ...overrides };
}

describe("o texto que o médico lê", () => {
  const states = Object.values(LOCATION_ACCESS) as LocationAccess[];

  /**
   * Quem lê é um médico decidindo sobre a própria localização, não um
   * desenvolvedor. Uma única palavra de sistema na tela e ele para de ler.
   */
  it("nenhum estado fala a língua de sistema", () => {
    const proibidas = [
      /coordenada/i,
      /\bGPS\b/,
      /segundo plano/i,
      /background/i,
      /\bAPI\b/,
      /criptograf/i,
      /token/i,
      /servidor/i,
      /latitude|longitude/i,
      /cache/i,
    ];
    for (const state of states) {
      const g = locationGuidance(state);
      const texto = `${g.title} ${g.body} ${g.action ?? ""}`;
      for (const proibida of proibidas) {
        expect(texto, `${state} — ${proibida}`).not.toMatch(proibida);
      }
    }
  });

  it("todo estado diz alguma coisa, e nenhum título é vazio", () => {
    for (const state of states) {
      const g = locationGuidance(state);
      expect(g.title.length, state).toBeGreaterThan(5);
      expect(g.body.length, state).toBeGreaterThan(40);
    }
  });

  /**
   * "Durante o uso" é o estado traiçoeiro: parece resolvido, e o aviso sairia
   * sem trânsito porque, uma hora antes do plantão, o app está fechado. A
   * tela precisa dizer isso, não mostrar um "ok".
   */
  it("permissão só com o app aberto é tratada como pendência, não como pronto", () => {
    for (const canAskInApp of [true, false]) {
      const g = locationGuidance(LOCATION_ACCESS.foreground, { canAskInApp });
      expect(g.trafficWorks, String(canAskInApp)).toBe(false);
      expect(g.action, String(canAskInApp)).toBeTruthy();
      expect(g.body, String(canAskInApp)).toMatch(/fechado/i);
      expect(g.title, String(canAskInApp)).not.toMatch(/ligada|pronto|ok/i);
    }
  });

  /**
   * Mandar alguém aos ajustes do aparelho quando bastava um toque é perder a
   * pessoa no meio do caminho. Enquanto o sistema aceita mostrar o pedido, a
   * tela pede; só quando ele fecha a porta é que os ajustes viram o caminho.
   */
  it("com o app aberto: pede ali mesmo enquanto o sistema aceita, e só então manda aos ajustes", () => {
    const podePedir = locationGuidance(LOCATION_ACCESS.foreground, {
      canAskInApp: true,
    });
    expect(podePedir.action).toBe("Liberar com o app fechado");
    expect(podePedir.action).not.toMatch(/ajustes/i);
    expect(podePedir.body).not.toMatch(/ajustes do aparelho/i);

    const portaFechada = locationGuidance(LOCATION_ACCESS.foreground, {
      canAskInApp: false,
    });
    expect(portaFechada.action).toMatch(/ajustes/i);
    expect(portaFechada.body).toMatch(/ajustes do aparelho/i);
  });

  it("sem a opção, o padrão é o caminho conservador dos ajustes", () => {
    expect(locationGuidance(LOCATION_ACCESS.foreground).action).toMatch(
      /ajustes/i,
    );
  });

  it("a opção não muda nenhum outro estado", () => {
    for (const state of [
      LOCATION_ACCESS.always,
      LOCATION_ACCESS.denied,
      LOCATION_ACCESS.unknown,
    ]) {
      expect(locationGuidance(state, { canAskInApp: true }), state).toEqual(
        locationGuidance(state, { canAskInApp: false }),
      );
    }
  });

  it("só o estado completo promete o trânsito", () => {
    for (const state of states) {
      expect(locationGuidance(state).trafficWorks, state).toBe(
        state === LOCATION_ACCESS.always,
      );
    }
  });

  /**
   * Recusar não pode parecer uma porta fechada: o aviso continua existindo, e
   * a tela precisa dizer exatamente o que ele perde.
   */
  it("a recusa explica o que continua funcionando", () => {
    const g = locationGuidance(LOCATION_ACCESS.denied);
    expect(g.body).toMatch(/continua chegando/i);
    expect(g.body).toMatch(/trânsito/i);
    expect(g.body).toMatch(/endereço/i);
  });

  it("o estado inicial promete o benefício e diz o que é guardado", () => {
    const g = locationGuidance(LOCATION_ACCESS.unknown);
    expect(g.action).toBe("Usar minha localização");
    expect(g.body).toMatch(/mais recente/i);
    expect(g.body).toMatch(/nunca por onde você andou/i);
  });
});

describe("quando vale mandar o ponto", () => {
  it("primeiro ponto sempre vai", () => {
    expect(shouldReport({ previous: null, next: point() })).toEqual({
      send: true,
    });
  });

  it("parado no mesmo lugar não gasta rede", () => {
    const decision = shouldReport({
      previous: point(),
      next: point({ latitude: FORTALEZA.latitude + 0.0005 }), // ~55 m
    });
    expect(decision).toEqual({
      send: false,
      reason: REPORT_SKIP_REASONS.unchanged,
    });
  });

  it("deslocamento real vai", () => {
    // ~1,1 km ao norte.
    const decision = shouldReport({
      previous: point(),
      next: point({ latitude: FORTALEZA.latitude + 0.01 }),
    });
    expect(decision).toEqual({ send: true });
  });

  it("o limiar é o que a constante compartilhada diz", () => {
    const graus = (MIN_MOVEMENT_METERS + 50) / 111_320;
    expect(
      shouldReport({
        previous: point(),
        next: point({ latitude: FORTALEZA.latitude + graus }),
      }),
    ).toEqual({ send: true });
  });

  /**
   * Um ponto com quilômetros de incerteza produziria uma estimativa de
   * trânsito com a mesma aparência de uma precisa. Melhor não ter.
   */
  it("ponto impreciso demais é recusado", () => {
    expect(
      shouldReport({
        previous: null,
        next: point({ accuracyMeters: MAX_ACCEPTED_ACCURACY_METERS + 1 }),
      }),
    ).toEqual({ send: false, reason: REPORT_SKIP_REASONS.imprecise });
  });

  it("aparelho sem informar precisão ainda vale", () => {
    expect(
      shouldReport({ previous: null, next: point({ accuracyMeters: null }) }),
    ).toEqual({ send: true });
  });

  /**
   * (0, 0) fica no Atlântico e é o que aparelho sem sinal costuma devolver.
   * Aceitar isso mandaria o médico sair de casa para o golfo da Guiné.
   */
  it("recusa coordenada nula e valores impossíveis", () => {
    for (const bad of [
      { latitude: 0, longitude: 0 },
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: Number.NaN, longitude: -38 },
    ]) {
      expect(
        shouldReport({ previous: null, next: point(bad) }),
        JSON.stringify(bad),
      ).toEqual({ send: false, reason: REPORT_SKIP_REASONS.invalid });
    }
  });
});
