import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

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
  DEPARTURE_MAX_SEND_ATTEMPTS,
  dispatchDueDepartures,
  readTravelOrigin,
  reconcileEnabledUsers,
  recordAutomaticOrigin,
  recomputeDuePlans,
  syncDeparturePlans,
  truncateToStoredSecond,
} from "../server/departure-engine";
import { sealExternalCredential } from "../server/external-credentials-crypto";
import {
  AUTOMATIC_ORIGIN_LABEL,
  MAX_ACCEPTED_ACCURACY_METERS,
  TRAVEL_ORIGIN_SEAL_SCOPE,
} from "../lib/integration-providers";
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

  /**
   * Instante alinhado ao segundo. `TIMESTAMP` no MySQL não guarda fração e
   * ARREDONDA o milissegundo; partir de um instante cravado deixa os horários
   * do plano comparáveis ao milissegundo, sem deriva de 1 s por causa do
   * relógio da máquina.
   */
  const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
  const SHIFT_START = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
  /** Uma hora antes do plantão: o instante do aviso. Fixo. */
  const NOTICE_AT = new Date(SHIFT_START.getTime() - 60 * 60_000);
  /**
   * A rota de cada plantão é calculada 70 min antes dele. Como o segundo
   * plantão começa uma hora depois do primeiro, cada um vence o recálculo no
   * seu próprio instante — e não existe um instante em que os dois estejam
   * vencidos e nenhum aviso tenha expirado.
   */
  const RECOMPUTE_AT_FIRST = new Date(SHIFT_START.getTime() - 70 * 60_000);
  const RECOMPUTE_AT_SECOND = new Date(SHIFT_START.getTime() - 10 * 60_000);

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
    await db
      .delete(userTravelOrigins)
      .where(
        and(
          eq(userTravelOrigins.userId, userId),
          eq(userTravelOrigins.label, AUTOMATIC_ORIGIN_LABEL),
        ),
      );
    // A origem fixa da fixture volta a ser a padrão.
    await db
      .update(userTravelOrigins)
      .set({ isDefault: true })
      .where(eq(userTravelOrigins.id, originId));
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
      .values({ userId, enabled: true, travelOriginId: originId, ...overrides })
      .onDuplicateKeyUpdate({
        set: { enabled: true, travelOriginId: originId, ...overrides },
      });
  }

  async function disable(): Promise<void> {
    await db
      .insert(userDeparturePreferences)
      .values({ userId, enabled: false })
      .onDuplicateKeyUpdate({ set: { enabled: false } });
  }

  /**
   * Roda o recálculo no instante devido de cada um dos dois plantões, somando
   * os resultados. É o que o worker faz ao longo do tempo — aqui condensado,
   * porque o alvo destes testes é o resultado, não a cadência.
   */
  async function recomputeBoth(options: {
    locationProvider: LocationProvider | null;
    weatherProvider?: WeatherProvider | null;
  }): Promise<{
    withTraffic: number;
    withoutTraffic: number;
    expired: number;
  }> {
    const total = { withTraffic: 0, withoutTraffic: 0, expired: 0 };
    for (const now of [RECOMPUTE_AT_FIRST, RECOMPUTE_AT_SECOND]) {
      const partial = await recomputeDuePlans({ db, ...options, now });
      total.withTraffic += partial.withTraffic;
      total.withoutTraffic += partial.withoutTraffic;
      total.expired += partial.expired;
    }
    return total;
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
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
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

    /**
     * O usuário desliga o aviso e religa no dia seguinte. O plano foi
     * cancelado no desligamento; se a reconciliação o ignorasse por
     * "assinatura igual", o plantão ficaria para sempre sem aviso.
     */
    it("religar o aviso ressuscita o plano cancelado", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await disable();
      await syncDeparturePlans({ db, userId, now: NOW });

      await enable();
      const summary = await syncDeparturePlans({ db, userId, now: NOW });
      expect(summary.refreshed).toBe(2);

      const open = await db
        .select({ id: departurePlans.id })
        .from(departurePlans)
        .where(
          and(
            eq(departurePlans.userId, userId),
            eq(departurePlans.status, "PENDING"),
          ),
        );
      expect(open).toHaveLength(2);
    });

    /**
     * O outro lado da mesma moeda: aviso já entregue, mundo inalterado. Voltar
     * a enfileirar treinaria o médico a silenciar o app.
     */
    it("plano já enviado não volta para a fila", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await db
        .update(departurePlans)
        .set({ status: "SENT", sentAt: NOW })
        .where(eq(departurePlans.userId, userId));

      const summary = await syncDeparturePlans({ db, userId, now: NOW });
      expect(summary.refreshed).toBe(0);
      expect(summary.created).toBe(0);

      const still = await db
        .select({ status: departurePlans.status })
        .from(departurePlans)
        .where(eq(departurePlans.userId, userId));
      expect(still.every((plan) => plan.status === "SENT")).toBe(true);
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

    /**
     * Troca e remoção pelo gestor não apagam a alocação: marcam
     * `is_active = 0`. O plano precisa sumir do mesmo jeito.
     */
    it("alocação inativa cancela o plano sem apagar a linha", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await db
        .update(shiftAssignmentsV2)
        .set({ isActive: false })
        .where(eq(shiftAssignmentsV2.id, assignmentIds[1]));
      try {
        const summary = await syncDeparturePlans({ db, userId, now: NOW });
        expect(summary.cancelled).toBe(1);
        const [plan] = await db
          .select({ status: departurePlans.status })
          .from(departurePlans)
          .where(eq(departurePlans.assignmentId, assignmentIds[1]));
        expect(plan?.status).toBe("CANCELLED");
      } finally {
        await db
          .update(shiftAssignmentsV2)
          .set({ isActive: true })
          .where(eq(shiftAssignmentsV2.id, assignmentIds[1]));
      }
    });

    it("conta excluída cancela os planos abertos e não cria novos", async () => {
      await enable();
      const before = await syncDeparturePlans({ db, userId, now: NOW });
      expect(before.created).toBeGreaterThan(0);
      await db
        .update(users)
        .set({ deletedAt: NOW })
        .where(eq(users.id, userId));
      try {
        const summary = await syncDeparturePlans({ db, userId, now: NOW });
        expect(summary.cancelled).toBe(before.created);
        expect(summary.created).toBe(0);
      } finally {
        await db
          .update(users)
          .set({ deletedAt: null })
          .where(eq(users.id, userId));
      }
    });
  });

  describe("cálculo", () => {
    it("hospital com coordenada usa a rota e marca a qualidade", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const provider = fakeLocationProvider({ durationSeconds: 1800 });
      const summary = await recomputeBoth({
        locationProvider: provider,
      });
      expect(summary.withTraffic).toBeGreaterThan(0);

      const [plan] = await db
        .select({
          status: departurePlans.status,
          departAt: departurePlans.departAt,
          quality: departurePlans.estimateQuality,
          duration: departurePlans.estimatedDurationSeconds,
        })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);

      expect(plan.status).toBe("SCHEDULED");
      expect(plan.quality).toBe(ROUTE_ESTIMATE_QUALITY.liveTraffic);
      expect(plan.duration).toBe(1800);
      // Saída = início do plantão menos a duração do trajeto.
      expect(plan.departAt?.getTime()).toBe(
        SHIFT_START.getTime() - 1800 * 1000,
      );
    });

    /**
     * Places e Routes cobram por requisição. A pergunta é "quanto leva agora",
     * e ela só tem resposta útil agora — uma consulta por plantão, pouco antes
     * do aviso. Seis consultas convergindo para o mesmo número seriam conta
     * paga para responder sobre um trânsito que o médico não vai pegar.
     */
    it("gasta UMA consulta de rota por plantão", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const provider = fakeLocationProvider({ durationSeconds: 1800 });
      await recomputeBoth({
        locationProvider: provider,
      });
      // Só o hospital com coordenada consulta; o outro nem chega ao provedor.
      expect(provider.calls).toBe(1);

      // Já calculado, não há o que recalcular: o tick seguinte não gasta cota.
      await recomputeBoth({
        locationProvider: provider,
      });
      expect(provider.calls).toBe(1);
    });

    /**
     * A ausência do Google não pode virar ausência de aviso — nem virar um
     * número inventado. O plano fica de pé, sem estimativa, e a mensagem diz
     * isso com todas as letras.
     */
    it("hospital sem coordenada fica sem estimativa, não com uma chutada", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
      });

      const [plan] = await db
        .select({
          quality: departurePlans.estimateQuality,
          duration: departurePlans.estimatedDurationSeconds,
          departAt: departurePlans.departAt,
          status: departurePlans.status,
        })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[1]))
        .limit(1);

      expect(plan.status).toBe("SCHEDULED");
      expect(plan.quality).toBeNull();
      expect(plan.duration).toBeNull();
      expect(plan.departAt).toBeNull();
    });

    it("provedor indisponível não derruba o plano", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const summary = await recomputeBoth({
        locationProvider: fakeLocationProvider({ fail: true }),
      });
      expect(summary.withoutTraffic).toBe(2);
      expect(summary.withTraffic).toBe(0);
    });

    it("sem provedor nenhum ainda planeja", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const summary = await recomputeBoth({
        locationProvider: null,
      });
      expect(summary.withoutTraffic).toBe(2);
    });

    /**
     * O worker pode ter dormido (plano free do Render) e acordado horas
     * depois. Consultar a rota de um aviso que não vai mais sair é gastar
     * cota paga por um resultado que o despacho descartaria em seguida.
     */
    it("aviso já vencido é encerrado sem consultar o Google", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      const provider = fakeLocationProvider({ durationSeconds: 1800 });

      const summary = await recomputeDuePlans({
        db,
        locationProvider: provider,
        // Muito depois dos dois avisos: o worker acordou tarde demais.
        now: new Date(SHIFT_START.getTime() + 6 * 60 * 60_000),
      });

      expect(provider.calls).toBe(0);
      expect(summary.expired).toBe(2);
      expect(summary.withTraffic + summary.withoutTraffic).toBe(0);

      const plans = await db
        .select({
          status: departurePlans.status,
          reason: departurePlans.lastFailureReason,
        })
        .from(departurePlans)
        .where(eq(departurePlans.userId, userId));
      expect(plans.every((plan) => plan.status === "CANCELLED")).toBe(true);
      expect(plans.every((plan) => plan.reason === "EXPIRED")).toBe(true);
    });

    it("clima entra na mensagem sem bloquear o cálculo", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        weatherProvider: fakeWeatherProvider(true),
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
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        weatherProvider: fakeWeatherProvider(false),
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
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
      });

      const [plan] = await db
        .select({ noticeAt: departurePlans.noticeAt })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);
      const sendTime = new Date(plan.noticeAt.getTime() + 1000);

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
      expect(sent[0]).toContain("Horário do plantão se aproxima");
    });

    it("aviso atrasado demais é encerrado sem envio", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
      });
      const [plan] = await db
        .select({ noticeAt: departurePlans.noticeAt })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);

      const sent: string[] = [];
      const summary = await dispatchDueDepartures({
        db,
        send: async () => {
          sent.push("enviou");
        },
        now: new Date(plan.noticeAt.getTime() + 31 * 60_000),
      });
      expect(summary.expired).toBeGreaterThan(0);
      expect(sent).toHaveLength(0);
    });

    it("conta excluída: aviso devido é encerrado sem envio", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
      });
      const [plan] = await db
        .select({ noticeAt: departurePlans.noticeAt })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);
      await db
        .update(users)
        .set({ deletedAt: NOW })
        .where(eq(users.id, userId));
      try {
        const sent: string[] = [];
        const summary = await dispatchDueDepartures({
          db,
          send: async () => {
            sent.push("enviou");
          },
          now: new Date(plan.noticeAt.getTime() + 1000),
        });
        expect(summary.cancelled).toBe(1);
        expect(summary.sent).toBe(0);
        expect(sent).toHaveLength(0);
        const [after] = await db
          .select({
            status: departurePlans.status,
            reason: departurePlans.lastFailureReason,
          })
          .from(departurePlans)
          .where(eq(departurePlans.assignmentId, assignmentIds[0]));
        expect(after).toEqual({ status: "CANCELLED", reason: "ACCOUNT_DELETED" });
      } finally {
        await db
          .update(users)
          .set({ deletedAt: null })
          .where(eq(users.id, userId));
      }
    });

    /**
     * Os outros médicos do mesmo tick também têm plantão hoje. Uma entrega
     * que falha não pode derrubar o lote inteiro — e, como o que falhou foi o
     * enfileiramento (idempotente por dedupKey), o plano reabre para o tick
     * seguinte sem risco de aviso duplicado.
     */
    it("falha de enfileiramento não derruba o lote e reabre o plano uma vez", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
      });

      // Os dois planos passam a sair no mesmo instante: o alvo aqui é o
      // comportamento do LOTE, não o do cálculo.
      const sendTime = new Date(NOW.getTime() + 60_000);
      await db
        .update(departurePlans)
        .set({ noticeAt: sendTime })
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

      // O que falhou voltou para a fila com o motivo; o que saiu ficou SENT.
      const plans = (
        await db
          .select({
            status: departurePlans.status,
            reason: departurePlans.lastFailureReason,
            attempts: departurePlans.attemptCount,
          })
          .from(departurePlans)
          .where(eq(departurePlans.userId, userId))
      ).sort((a, b) => a.status.localeCompare(b.status));
      expect(plans).toEqual([
        { status: "SCHEDULED", reason: "SEND_FAILED", attempts: 1 },
        { status: "SENT", reason: null, attempts: 1 },
      ]);

      // Tick seguinte: só o reaberto sai, e sai uma vez.
      const again = await dispatchDueDepartures({
        db,
        send: async () => {},
        now: new Date(sendTime.getTime() + 2000),
      });
      expect(again.sent).toBe(1);
      expect(again.failed).toBe(0);
      const third = await dispatchDueDepartures({
        db,
        send: async () => {
          throw new Error("não deveria reenviar");
        },
        now: new Date(sendTime.getTime() + 3000),
      });
      expect(third.sent).toBe(0);
      expect(third.failed).toBe(0);
    });

    it("esgotadas as tentativas, o plano fica SENT com o motivo, sem loop", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
      });
      const sendTime = new Date(NOW.getTime() + 60_000);
      await db
        .update(departurePlans)
        .set({ noticeAt: sendTime })
        .where(eq(departurePlans.userId, userId));

      let attempts = 0;
      const failing = async () => {
        attempts += 1;
        throw new Error("transporte indisponível");
      };
      for (let tick = 1; tick <= DEPARTURE_MAX_SEND_ATTEMPTS; tick += 1) {
        await dispatchDueDepartures({
          db,
          send: failing,
          now: new Date(sendTime.getTime() + tick * 1000),
        });
      }
      // Dois planos × teto de tentativas, e nem uma a mais.
      expect(attempts).toBe(2 * DEPARTURE_MAX_SEND_ATTEMPTS);
      const after = await dispatchDueDepartures({
        db,
        send: failing,
        now: new Date(sendTime.getTime() + 60_000),
      });
      expect(after.sent + after.failed).toBe(0);
      const plans = await db
        .select({
          status: departurePlans.status,
          reason: departurePlans.lastFailureReason,
          attempts: departurePlans.attemptCount,
        })
        .from(departurePlans)
        .where(eq(departurePlans.userId, userId));
      expect(plans).toHaveLength(2);
      for (const plan of plans) {
        expect(plan).toEqual({
          status: "SENT",
          reason: "SEND_FAILED",
          attempts: DEPARTURE_MAX_SEND_ATTEMPTS,
        });
      }
    });

    it("não envia antes da hora", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
      });
      const summary = await dispatchDueDepartures({
        db,
        send: async () => {
          throw new Error("não deveria enviar");
        },
        // Um minuto antes do aviso. O plano está calculado e pronto — e
        // mesmo assim não sai.
        now: new Date(NOTICE_AT.getTime() - 60_000),
      });
      expect(summary.sent).toBe(0);
    });

    /**
     * Sem Google o aviso continua saindo — e admite o que não sabe. Um número
     * inventado, no aparelho do médico, tem a mesma aparência de um calculado.
     */
    it("sem rota, o aviso sai admitindo que não sabe o trânsito", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: null,
      });

      const [plan] = await db
        .select({ noticeAt: departurePlans.noticeAt })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);

      let body = "";
      let title = "";
      await dispatchDueDepartures({
        db,
        send: async (input) => {
          body = input.body;
          title = input.title;
        },
        now: new Date(plan.noticeAt.getTime() + 1000),
      });
      expect(title).toBe("Horário do plantão se aproxima");
      expect(body).toContain("Estimativas de trânsito não disponíveis.");
      expect(body).not.toMatch(/\d+\s*min/);
    });

    /**
     * O aviso é sempre uma hora antes — não no horário de sair. Se o trajeto
     * leva 25 minutos, o médico é avisado com 60, e a mensagem diz até que
     * horas sair.
     */
    it("o aviso sai uma hora antes, não na hora de sair", async () => {
      await enable();
      await syncDeparturePlans({ db, userId, now: NOW });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1500 }),
      });

      const [plan] = await db
        .select({
          noticeAt: departurePlans.noticeAt,
          departAt: departurePlans.departAt,
        })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);

      expect(plan.noticeAt.getTime()).toBe(NOTICE_AT.getTime());
      // A saída fica 35 minutos DEPOIS do aviso: é informação, não gatilho.
      expect(plan.departAt!.getTime() - plan.noticeAt.getTime()).toBe(
        35 * 60_000,
      );

      let body = "";
      await dispatchDueDepartures({
        db,
        send: async (input) => {
          body = input.body;
        },
        now: new Date(plan.noticeAt.getTime() + 1000),
      });
      expect(body).toContain("25 min");
      expect(body).toMatch(/saia até \d{2}:\d{2}/);
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

    /**
     * O worker roda EXATAMENTE no instante gravado. Se o banco tivesse
     * arredondado para cima, a linha estaria 1 s no futuro e este tick não a
     * enxergaria — o aviso só sairia no tick seguinte, ou não sairia.
     */
    it("o plano é visto pelo worker no instante exato que ficou gravado", async () => {
      await enable();
      // Reconciliação com fração de segundo no relógio: o horário do plano
      // deriva do plantão, e não pode herdar a fração nem o arredondamento.
      await syncDeparturePlans({
        db,
        userId,
        now: new Date(NOW.getTime() + 700),
      });

      const [plan] = await db
        .select({
          noticeAt: departurePlans.noticeAt,
          nextRecomputeAt: departurePlans.nextRecomputeAt,
        })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]))
        .limit(1);

      expect(plan.noticeAt.getTime()).toBe(NOTICE_AT.getTime());
      expect(plan.nextRecomputeAt!.getTime()).toBe(
        NOTICE_AT.getTime() - 10 * 60_000,
      );

      const summary = await recomputeDuePlans({
        db,
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
        now: plan.nextRecomputeAt!,
      });
      expect(summary.withTraffic + summary.withoutTraffic).toBeGreaterThan(0);
    });
  });

  /**
   * A escala muda toda semana. Se o aviso só existisse para plantões que já
   * estavam lá quando o médico ligou a preferência, o gestor alocaria, o
   * médico não receberia nada, e ninguém descobriria por quê.
   */
  describe("reconciliação periódica", () => {
    it("plantão alocado DEPOIS de ligar o aviso também vira plano", async () => {
      await enable();
      await db.delete(departurePlans).where(eq(departurePlans.userId, userId));

      const summary = await reconcileEnabledUsers({ db, now: NOW });
      expect(summary.scanned).toBeGreaterThan(0);
      expect(summary.created).toBe(2);

      const plans = await db
        .select({ id: departurePlans.id })
        .from(departurePlans)
        .where(eq(departurePlans.userId, userId));
      expect(plans).toHaveLength(2);
    });

    it("quem está com o aviso desligado não gera trabalho", async () => {
      await disable();
      const summary = await reconcileEnabledUsers({
        db,
        now: NOW,
        afterUserId: userId - 1,
        limit: 1,
      });
      expect(summary.scanned).toBe(0);
      expect(summary.created).toBe(0);
    });

    /**
     * O cursor avança por `user_id` e dá a volta ao chegar ao fim. Sem a
     * volta, quem tem id menor que o último visto nunca mais seria
     * reconciliado.
     */
    it("o cursor avança e volta ao início ao terminar a lista", async () => {
      await enable();
      const page = await reconcileEnabledUsers({
        db,
        now: NOW,
        afterUserId: userId - 1,
        limit: 1,
      });
      expect(page.scanned).toBe(1);
      expect(page.nextCursor).toBe(userId);

      const last = await reconcileEnabledUsers({
        db,
        now: NOW,
        afterUserId: userId,
        limit: 1,
      });
      expect(last.scanned).toBe(0);
      expect(last.nextCursor).toBe(0);
    });
  });

  /**
   * O ponto de partida vem do aparelho e substitui o anterior: uma linha por
   * conta, nunca histórico. Saber por onde um médico andou não é necessário
   * para dizer a que horas ele deve sair de casa.
   */
  describe("origem automática (do aparelho)", () => {
    const CASA = { latitude: -3.74, longitude: -38.53 };

    async function automaticRows() {
      return db
        .select({
          id: userTravelOrigins.id,
          isDefault: userTravelOrigins.isDefault,
          version: userTravelOrigins.version,
        })
        .from(userTravelOrigins)
        .where(
          and(
            eq(userTravelOrigins.userId, userId),
            eq(userTravelOrigins.label, AUTOMATIC_ORIGIN_LABEL),
          ),
        );
    }

    it("grava selado, como padrão, sob o rótulo fixo", async () => {
      const result = await recordAutomaticOrigin({
        db,
        userId,
        point: CASA,
        accuracyMeters: 30,
      });
      expect(result).toEqual({ stored: true, reason: null });
      const rows = await automaticRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].isDefault).toBe(true);
      const opened = await readTravelOrigin(db, userId, null);
      expect(opened?.label).toBe(AUTOMATIC_ORIGIN_LABEL);
      expect(opened?.location.latitude).toBeCloseTo(CASA.latitude, 5);
    });

    it("mal saiu do lugar: não regrava", async () => {
      await recordAutomaticOrigin({
        db,
        userId,
        point: CASA,
        accuracyMeters: 30,
      });
      const [before] = await automaticRows();
      const result = await recordAutomaticOrigin({
        db,
        userId,
        point: { latitude: CASA.latitude + 0.0005, longitude: CASA.longitude }, // ~55 m
        accuracyMeters: 30,
      });
      expect(result).toEqual({ stored: false, reason: "UNCHANGED" });
      const [after] = await automaticRows();
      expect(after.version).toBe(before.version);
    });

    /** A garantia de "sem histórico" é do banco: a chave única substitui. */
    it("deslocamento real substitui a MESMA linha — nunca acrescenta", async () => {
      await recordAutomaticOrigin({
        db,
        userId,
        point: CASA,
        accuracyMeters: 30,
      });
      const [before] = await automaticRows();
      const result = await recordAutomaticOrigin({
        db,
        userId,
        point: { latitude: CASA.latitude + 0.02, longitude: CASA.longitude }, // ~2,2 km
        accuracyMeters: 30,
      });
      expect(result).toEqual({ stored: true, reason: null });
      const rows = await automaticRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(before.id);
      expect(rows[0].version).toBeGreaterThan(before.version);
      const opened = await readTravelOrigin(db, userId, null);
      expect(opened?.location.latitude).toBeCloseTo(CASA.latitude + 0.02, 5);
    });

    it("ponto impreciso demais é recusado sem escrever", async () => {
      const result = await recordAutomaticOrigin({
        db,
        userId,
        point: CASA,
        accuracyMeters: MAX_ACCEPTED_ACCURACY_METERS + 1,
      });
      expect(result).toEqual({ stored: false, reason: "IMPRECISE" });
      expect(await automaticRows()).toHaveLength(0);
    });

    it("coordenada inválida é recusada sem escrever", async () => {
      const result = await recordAutomaticOrigin({
        db,
        userId,
        point: { latitude: 0, longitude: 0 },
        accuracyMeters: 10,
      });
      expect(result.stored).toBe(false);
      expect(await automaticRows()).toHaveLength(0);
    });

    /**
     * O plano guarda a assinatura da origem. Mudou o ponto de partida, o
     * cálculo anterior descreve outro mundo — e precisa refazer.
     */
    it("mudar o ponto invalida o plano calculado", async () => {
      await enable();
      await recordAutomaticOrigin({
        db,
        userId,
        point: CASA,
        accuracyMeters: 30,
      });
      await recomputeBoth({
        locationProvider: fakeLocationProvider({ durationSeconds: 1800 }),
      });
      const [scheduled] = await db
        .select({ status: departurePlans.status })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]));
      expect(scheduled.status).toBe("SCHEDULED");

      await recordAutomaticOrigin({
        db,
        userId,
        point: { latitude: CASA.latitude + 0.02, longitude: CASA.longitude },
        accuracyMeters: 30,
      });
      const [reset] = await db
        .select({
          status: departurePlans.status,
          departAt: departurePlans.departAt,
        })
        .from(departurePlans)
        .where(eq(departurePlans.assignmentId, assignmentIds[0]));
      expect(reset.status).toBe("PENDING");
      expect(reset.departAt).toBeNull();
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
