import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import {
  departurePlans,
  hospitals,
  institutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  userDeparturePreferences,
  userTravelOrigins,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  dispatchDueDepartures,
  readTravelOrigin,
  recomputeDuePlans,
  syncDeparturePlans,
  truncateToStoredSecond,
} from "../server/departure-engine";
import { sealExternalCredential } from "../server/external-credentials-crypto";
import { TRAVEL_ORIGIN_SEAL_SCOPE } from "../lib/integration-providers";
import {
  ROUTE_ESTIMATE_QUALITY,
  type LocationProvider,
} from "../server/integrations/providers/location-provider";
import type { WeatherProvider } from "../server/integrations/providers/weather-provider";
import { WEATHER_CONDITIONS } from "../server/integrations/providers/weather-provider";
import {
  PROVIDER_FAILURE_REASONS,
  providerFailure,
  providerSuccess,
} from "../server/integrations/providers/types";

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Provedor de rota falso: responde o que o teste mandar, sem rede. */
function fakeLocationProvider(options: {
  durationSeconds?: number;
  fail?: boolean;
}): LocationProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    providerId: "GOOGLE_PLACES_ROUTES",
    get calls() {
      return state.calls;
    },
    async autocomplete() {
      return providerSuccess([]);
    },
    async placeDetails() {
      return providerFailure(PROVIDER_FAILURE_REASONS.notFound);
    },
    async computeRoute() {
      state.calls += 1;
      if (options.fail) {
        return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
      }
      return providerSuccess({
        durationSeconds: options.durationSeconds ?? 1800,
        distanceMeters: 15_000,
        quality: ROUTE_ESTIMATE_QUALITY.liveTraffic,
        computedAtUtc: new Date(),
      });
    },
  } as LocationProvider & { calls: number };
}

function fakeWeatherProvider(rain: boolean): WeatherProvider {
  return {
    providerId: "WEATHERKIT",
    async forecastAt() {
      return providerSuccess({
        validAtUtc: new Date(),
        condition: rain
          ? WEATHER_CONDITIONS.heavyRain
          : WEATHER_CONDITIONS.clear,
        temperatureCelsius: 25,
        precipitationChance: rain ? 0.9 : 0.05,
        attribution: {
          providerName: "Apple Weather",
          legalPageUrl: "https://weatherkit.apple.com/legal-attribution.html",
        },
      });
    },
  };
}

/**
 * Duas instituições criadas em runtime — uma com hospital localizado e outra
 * sem. É o caso que importa: a funcionalidade tem de valer para qualquer
 * instituição, inclusive uma criada depois, e o hospital sem coordenada não
 * pode quebrar o aviso, só cair para o fallback declarado.
 */
describe("motor de aviso de saída", () => {
  let db: Db;
  const institutionIds: number[] = [];
  const hospitalIds: number[] = [];
  const sectorIds: number[] = [];
  const shiftIds: number[] = [];
  const assignmentIds: number[] = [];
  const professionalIds: number[] = [];
  const userIds: number[] = [];
  let userId = 0;
  let originId = 0;

  const NOW = new Date();
  const SHIFT_START = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);

  beforeAll(async () => {
    const loaded = await getDb();
    if (!loaded) throw new Error("Banco de testes indisponível");
    db = loaded;

    const [user] = await db.insert(users).values({
      name: `Saída ${stamp}`,
      email: `saida-${stamp}@test.local`,
      password: "x".repeat(20),
      role: "doctor",
    });
    userId = user.insertId;
    userIds.push(userId);

    for (const [index, key] of ["com-local", "sem-local"].entries()) {
      const [institution] = await db.insert(institutions).values({
        name: `Inst ${key} ${stamp}`,
        cnpj: `${stamp}${index}`.slice(-14).padStart(14, "0"),
      });
      institutionIds.push(institution.insertId);

      const [hospital] = await db.insert(hospitals).values({
        institutionId: institution.insertId,
        name: `Hosp ${key} ${stamp}`,
        // Só o primeiro tem coordenada configurada.
        ...(index === 0
          ? { latitude: "-3.7327000", longitude: "-38.5267000" }
          : {}),
      });
      hospitalIds.push(hospital.insertId);

      const [sector] = await db.insert(sectors).values({
        institutionId: institution.insertId,
        hospitalId: hospital.insertId,
        name: `Setor ${key} ${stamp}`,
        category: "internacao",
        color: "#123456",
      });
      sectorIds.push(sector.insertId);

      const [professional] = await db.insert(professionals).values({
        userId,
        name: `Prof ${key} ${stamp}`,
        role: "doctor",
        institutionId: institution.insertId,
      });
      professionalIds.push(professional.insertId);

      const [shift] = await db.insert(shiftInstances).values({
        institutionId: institution.insertId,
        hospitalId: hospital.insertId,
        sectorId: sector.insertId,
        label: `Plantão ${key} ${stamp}`,
        startAt: new Date(SHIFT_START.getTime() + index * 3_600_000),
        endAt: new Date(
          SHIFT_START.getTime() + index * 3_600_000 + 12 * 3_600_000,
        ),
        modality: "PLANTAO",
      });
      shiftIds.push(shift.insertId);

      const [assignment] = await db.insert(shiftAssignmentsV2).values({
        institutionId: institution.insertId,
        hospitalId: hospital.insertId,
        sectorId: sector.insertId,
        shiftInstanceId: shift.insertId,
        professionalId: professional.insertId,
      });
      assignmentIds.push(assignment.insertId);
    }

    const [origin] = await db.insert(userTravelOrigins).values({
      userId,
      label: `Casa ${stamp}`,
      sealedLocation: sealExternalCredential(
        JSON.stringify({
          placeId: "ChIJtestecasa",
          latitude: -3.74,
          longitude: -38.53,
          formattedAddress: "Rua Exemplo, 100",
        }),
        { userId, scope: TRAVEL_ORIGIN_SEAL_SCOPE },
      ),
      encryptionKid: "current",
      consentGrantedAt: NOW,
      consentVersion: "origem-v1",
      isDefault: true,
    });
    originId = origin.insertId;
  });

  beforeEach(async () => {
    await db.delete(departurePlans).where(eq(departurePlans.userId, userId));
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(departurePlans)
      .where(inArray(departurePlans.userId, userIds));
    await db
      .delete(userDeparturePreferences)
      .where(inArray(userDeparturePreferences.userId, userIds));
    await db
      .delete(userTravelOrigins)
      .where(inArray(userTravelOrigins.userId, userIds));
    if (assignmentIds.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.id, assignmentIds));
    }
    if (shiftIds.length) {
      await db
        .delete(shiftInstances)
        .where(inArray(shiftInstances.id, shiftIds));
    }
    if (professionalIds.length) {
      await db
        .delete(professionals)
        .where(inArray(professionals.id, professionalIds));
    }
    if (sectorIds.length)
      await db.delete(sectors).where(inArray(sectors.id, sectorIds));
    if (hospitalIds.length) {
      await db.delete(hospitals).where(inArray(hospitals.id, hospitalIds));
    }
    if (institutionIds.length) {
      await db
        .delete(institutions)
        .where(inArray(institutions.id, institutionIds));
    }
    await db.delete(users).where(inArray(users.id, userIds));
  });

  async function enable(
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await db
      .insert(userDeparturePreferences)
      .values({
        userId,
        enabled: true,
        travelOriginId: originId,
        arrivalMarginMinutes: 15,
        fallbackTravelMinutes: 40,
        ...overrides,
      })
      .onDuplicateKeyUpdate({
        set: {
          enabled: true,
          travelOriginId: originId,
          arrivalMarginMinutes: 15,
          fallbackTravelMinutes: 40,
          ...overrides,
        },
      });
  }

  async function disable(): Promise<void> {
    await db
      .insert(userDeparturePreferences)
      .values({ userId, enabled: false })
      .onDuplicateKeyUpdate({ set: { enabled: false } });
  }

  describe("opt-in", () => {
    /**
     * Conveniência que ninguém pediu vira ruído, e ruído em app de plantão
     * treina o médico a ignorar notificação — inclusive as que importam.
     */
    it("sem preferência não planeja nada", async () => {
      await db
        .delete(userDeparturePreferences)
        .where(eq(userDeparturePreferences.userId, userId));
      const summary = await syncDeparturePlans({ db, userId, now: NOW });
      expect(summary.created).toBe(0);
      const plans = await db
        .select({ id: departurePlans.id })
        .from(departurePlans)
        .where(eq(departurePlans.userId, userId));
      expect(plans).toHaveLength(0);
    });

    it("ligado, planeja os plantões de todas as instituições", async () => {
      await enable();
      const summary = await syncDeparturePlans({ db, userId, now: NOW });
      expect(summary.created).toBe(2);
      const plans = await db
        .select({ institutionId: departurePlans.institutionId })
        .from(departurePlans)
        .where(eq(departurePlans.userId, userId));
      expect(new Set(plans.map((p) => p.institutionId)).size).toBe(2);
    });

    it("desligar cancela os planos abertos na hora", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await disable();
      const summary = await syncDeparturePlans({ db, userId, now: NOW });
      expect(summary.cancelled).toBe(2);
      const open = await db
        .select({ id: departurePlans.id })
        .from(departurePlans)
        .where(inArray(departurePlans.status, ["PENDING", "SCHEDULED"]));
      expect(open.filter(Boolean)).toHaveLength(0);
    });
  });

  describe("reconciliação", () => {
    it("é idempotente: rodar de novo não duplica plano", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const second = await syncDeparturePlans({ db, userId, now: NOW });
      expect(second.created).toBe(0);
      expect(second.refreshed).toBe(0);
      const plans = await db
        .select({ id: departurePlans.id })
        .from(departurePlans)
        .where(eq(departurePlans.userId, userId));
      expect(plans).toHaveLength(2);
    });

    /**
     * Sem isto o médico receberia "saia às 18h07" para um plantão que mudou
     * de hora — um aviso pior que nenhum, porque ele confia.
     */
    it("plantão que muda de horário invalida o cálculo", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        now: NOW,
      });

      await db
        .update(shiftInstances)
        .set({ startAt: new Date(SHIFT_START.getTime() + 2 * 3_600_000) })
        .where(eq(shiftInstances.id, shiftIds[0]));

      const summary = await syncDeparturePlans({ db, userId, now: NOW });
      expect(summary.refreshed).toBe(1);

      const [plan] = await db
        .select({
          status: departurePlans.status,
          departAt: departurePlans.departAt,
        })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);
      expect(plan.status).toBe("PENDING");
      expect(plan.departAt).toBeNull();

      await db
        .update(shiftInstances)
        .set({ startAt: SHIFT_START })
        .where(eq(shiftInstances.id, shiftIds[0]));
    });

    it("alocação removida cancela o plano", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, assignmentIds[1]));

      const summary = await syncDeparturePlans({ db, userId, now: NOW });
      expect(summary.cancelled).toBe(1);

      const [restored] = await db.insert(shiftAssignmentsV2).values({
        institutionId: institutionIds[1],
        hospitalId: hospitalIds[1],
        sectorId: sectorIds[1],
        shiftInstanceId: shiftIds[1],
        professionalId: professionalIds[1],
      });
      assignmentIds[1] = restored.insertId;
    });
  });

  describe("cálculo", () => {
    it("hospital com coordenada usa a rota e marca a qualidade", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const provider = fakeLocationProvider({ durationSeconds: 1800 });
      const summary = await recomputeDuePlans({
        db,
        locationProvider: provider,
        now: NOW,
      });
      expect(summary.computed).toBeGreaterThan(0);

      const [plan] = await db
        .select({
          status: departurePlans.status,
          departAt: departurePlans.departAt,
          quality: departurePlans.estimateQuality,
          duration: departurePlans.estimatedDurationSeconds,
          desiredArrivalAt: departurePlans.desiredArrivalAt,
        })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);

      expect(plan.status).toBe("SCHEDULED");
      expect(plan.quality).toBe(ROUTE_ESTIMATE_QUALITY.liveTraffic);
      expect(plan.duration).toBe(1800);
      // Saída = chegada desejada menos a duração.
      expect(plan.departAt?.getTime()).toBe(
        plan.desiredArrivalAt.getTime() - 1800 * 1000,
      );
    });

    /**
     * A ausência do Google não pode virar ausência de aviso. O hospital sem
     * coordenada ainda produz plano — com o número marcado como fallback.
     */
    it("hospital sem coordenada cai no fallback declarado", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        now: NOW,
      });

      const [plan] = await db
        .select({
          quality: departurePlans.estimateQuality,
          duration: departurePlans.estimatedDurationSeconds,
          status: departurePlans.status,
        })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[1]))
        .limit(1);

      expect(plan.status).toBe("SCHEDULED");
      expect(plan.quality).toBe(ROUTE_ESTIMATE_QUALITY.fallback);
      expect(plan.duration).toBe(40 * 60);
    });

    it("provedor indisponível também cai no fallback, sem derrubar o plano", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const summary = await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ fail: true }),
        now: NOW,
      });
      expect(summary.fallback).toBe(2);
      expect(summary.computed).toBe(0);
    });

    it("sem provedor nenhum ainda planeja", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const summary = await recomputeDuePlans({
        db,
        locationProvider: null,
        now: NOW,
      });
      expect(summary.fallback).toBe(2);
    });

    it("clima entra na mensagem sem bloquear o cálculo", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        weatherProvider: fakeWeatherProvider(true),
        now: NOW,
      });
      const [plan] = await db
        .select({ weather: departurePlans.weatherSummary })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);
      expect(plan.weather).toContain("Chuva forte");
    });

    it("tempo bom não polui a mensagem", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        weatherProvider: fakeWeatherProvider(false),
        now: NOW,
      });
      const [plan] = await db
        .select({ weather: departurePlans.weatherSummary })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);
      expect(plan.weather).toBeNull();
    });
  });

  describe("envio", () => {
    it("envia uma vez só, mesmo com duas execuções concorrentes", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        now: NOW,
      });

      const [plan] = await db
        .select({ departAt: departurePlans.departAt })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);
      const sendTime = new Date(plan.departAt!.getTime() + 1000);

      const sent: string[] = [];
      const send = async (input: { dedupKey: string; title: string }) => {
        sent.push(`${input.dedupKey}|${input.title}`);
      };

      const [first, second] = await Promise.all([
        dispatchDueDepartures({ db, send, now: sendTime }),
        dispatchDueDepartures({ db, send, now: sendTime }),
      ]);

      // Perder um aviso é ruim; mandar dois é pior — treina o médico a
      // silenciar o app.
      expect(first.sent + second.sent).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Saia às");
    });

    it("aviso atrasado demais é encerrado sem envio", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        now: NOW,
      });
      const [plan] = await db
        .select({ departAt: departurePlans.departAt })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);

      const sent: string[] = [];
      const summary = await dispatchDueDepartures({
        db,
        send: async () => {
          sent.push("enviou");
        },
        now: new Date(plan.departAt!.getTime() + 30 * 60_000),
      });
      expect(summary.expired).toBeGreaterThan(0);
      expect(sent).toHaveLength(0);
    });

    /**
     * Os outros médicos do mesmo tick também têm plantão hoje. Uma entrega
     * que falha não pode derrubar o lote inteiro.
     */
    it("falha de entrega não derruba o lote nem reenvia", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        now: NOW,
      });

      // Os dois planos passam a sair no mesmo instante: o alvo aqui é o
      // comportamento do LOTE, não o do cálculo.
      const sendTime = new Date(NOW.getTime() + 60_000);
      await db
        .update(departurePlans)
        .set({ departAt: sendTime })
        .where(eq(departurePlans.userId, userId));

      let attempts = 0;
      const summary = await dispatchDueDepartures({
        db,
        send: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transporte indisponível");
        },
        now: new Date(sendTime.getTime() + 1000),
      });

      // O primeiro falhou, o segundo passou: o lote seguiu adiante.
      expect(attempts).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.sent).toBe(1);

      // E nenhum dos dois volta a ser enviado num tick seguinte — o outbox de
      // push tem retry próprio; reenviar daqui duplicaria o aviso.
      const again = await dispatchDueDepartures({
        db,
        send: async () => {
          throw new Error("não deveria reenviar");
        },
        now: new Date(sendTime.getTime() + 2000),
      });
      expect(again.sent).toBe(0);
      expect(again.failed).toBe(0);
    });

    it("não envia antes da hora", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        now: NOW,
      });
      const summary = await dispatchDueDepartures({
        db,
        send: async () => {
          throw new Error("não deveria enviar");
        },
        now: NOW,
      });
      expect(summary.sent).toBe(0);
    });

    it("a mensagem diz a origem do número", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeDuePlans({ db, locationProvider: null, now: NOW });

      const [plan] = await db
        .select({ departAt: departurePlans.departAt })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);

      let body = "";
      await dispatchDueDepartures({
        db,
        send: async (input) => {
          body = input.body;
        },
        now: new Date(plan.departAt!.getTime() + 1000),
      });
      expect(body).toContain("não foi possível consultar o trânsito");
    });
  });

  /**
   * `TIMESTAMP` no MySQL arredonda o milissegundo em vez de cortá-lo. Um
   * plano gravado em T.700 vira T+1s no banco, e o worker que roda em T
   * deixa de enxergá-lo como vencido. É a mesma armadilha que já escondeu
   * pedidos do outbox de recuperação de credenciais.
   */
  describe("precisão de timestamp", () => {
    it("trunca para o segundo em vez de arredondar", () => {
      expect(
        truncateToStoredSecond(
          new Date("2026-09-11T10:00:00.700Z"),
        ).toISOString(),
      ).toBe("2026-09-11T10:00:00.000Z");
      expect(
        truncateToStoredSecond(
          new Date("2026-09-11T10:00:00.000Z"),
        ).toISOString(),
      ).toBe("2026-09-11T10:00:00.000Z");
    });

    it("um plano criado com fração de segundo é visto pelo worker no mesmo instante", async () => {
      await enable();
      // Instante com .700: sem truncar, o banco guardaria T+1s e o recálculo
      // abaixo, feito exatamente em T, não encontraria nada.
      const fractional = new Date(
        Math.floor(NOW.getTime() / 1000) * 1000 + 700,
      );
      await syncDeparturePlans({ db, userId, now: fractional });

      const summary = await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        now: fractional,
      });
      expect(summary.computed + summary.fallback).toBeGreaterThan(0);
    });
  });

  describe("privacidade da origem", () => {
    it("a origem só abre para o dono", async () => {
      const own = await readTravelOrigin(db, userId, originId);
      expect(own?.location.latitude).toBeCloseTo(-3.74, 3);

      const [other] = await db.insert(users).values({
        name: `Intruso ${stamp}`,
        email: `intruso-${stamp}@test.local`,
        password: "x".repeat(20),
        role: "doctor",
      });
      userIds.push(other.insertId);
      // Id de origem alheio: o WHERE é por user_id, então não encontra.
      expect(await readTravelOrigin(db, other.insertId, originId)).toBeNull();
    });

    it("nenhuma coluna guarda coordenada em claro", async () => {
      const [row] = await db
        .select({ sealed: userTravelOrigins.sealedLocation })
        .from(userTravelOrigins)
        .where(eq(userTravelOrigins.id, originId))
        .limit(1);
      expect(row.sealed).not.toContain("-3.74");
      expect(row.sealed).not.toContain("Rua Exemplo");
      expect(row.sealed).toMatch(/^v1\./);
    });
  });
});
