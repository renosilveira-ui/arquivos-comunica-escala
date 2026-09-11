import { and, asc, eq, gt, isNotNull } from "drizzle-orm";

import {
  hospitals,
  institutions,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
} from "../drizzle/schema";
import { PROVIDER_CONFIGURATION_STATES } from "../lib/integration-providers";
import { router, sessionProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { readDeparturePreferences, readTravelOrigin } from "./departure-engine";
import { resolveScheduleTimeZone } from "./institution-time-zone";
import {
  createWeatherKitProvider,
  readWeatherKitConfig,
} from "./integrations/apple/weatherkit-client";
import { weatherKitConfiguration } from "./integrations/providers/configuration";
import {
  coarsenGeoPoint,
  isValidGeoPoint,
  type GeoPoint,
} from "./integrations/providers/types";
import type { WeatherCondition } from "./integrations/providers/weather-provider";

/**
 * Clima de onde o médico está, para a saudação do topo do app.
 *
 * ## Por que o servidor, e não o aparelho
 *
 * A chave ES256 da Apple fica no servidor e o app nunca a vê. Pedir do
 * aparelho exigiria expor credencial no bundle — que é exatamente o que a
 * restrição de segurança deste projeto proíbe.
 *
 * ## De onde sai a localização
 *
 * Nesta ordem, e sem pedir permissão de GPS a ninguém:
 *
 * 1. **O endereço que o médico já cadastrou** para o aviso de plantão. Ele já
 *    consentiu, já está selado, e é onde ele de fato está na maior parte do
 *    tempo em que abre o app.
 * 2. **O hospital do próximo plantão dele**, em qualquer instituição. Quem
 *    não cadastrou endereço ainda tem escala, e o hospital é uma aproximação
 *    honesta de "a cidade onde isso importa".
 * 3. **Qualquer hospital localizado das instituições dele.** Médico entre
 *    escalas — de férias, recém-cadastrado, sem plantão marcado — continua
 *    sendo de algum lugar.
 *
 * Sem nenhum dos dois, não há clima — e a saudação vai sozinha, que é o
 * comportamento correto, não um erro.
 *
 * A coordenada é **arredondada** (~110 m) antes de sair para a Apple: não é
 * preciso saber onde alguém mora para dizer se vai chover.
 */

/** Janela de cache por coordenada arredondada. */
const CACHE_TTL_MS = 15 * 60 * 1000;

type CachedForecast = {
  at: number;
  condition: WeatherCondition;
  temperatureCelsius: number;
  attribution: { providerName: string; legalPageUrl: string };
};

/**
 * Cache em memória, por coordenada arredondada.
 *
 * O clima de um bairro não muda a cada abertura de tela, e a saudação aparece
 * em toda navegação para a aba principal. Sem isto, um médico que alterna
 * entre abas dispararia dezenas de consultas por minuto — cota paga para
 * repetir o mesmo número.
 *
 * Morre com o processo de propósito: é conveniência, não estado.
 */
const cache = new Map<string, CachedForecast>();

function cacheKey(point: GeoPoint): string {
  return `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`;
}

/** Somente para teste: limpa o cache entre cenários. */
export function resetWeatherGreetingCache(): void {
  cache.clear();
}

type ResolvedLocation = {
  point: GeoPoint;
  timeZone: string;
};

async function resolveUserLocation(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  now: Date,
): Promise<ResolvedLocation | null> {
  // 1. Endereço já consentido e selado.
  const preferences = await readDeparturePreferences(db, userId);
  const origin = await readTravelOrigin(db, userId, preferences.travelOriginId);
  if (origin && isValidGeoPoint(origin.location)) {
    return {
      point: origin.location,
      timeZone: resolveScheduleTimeZone({}),
    };
  }

  // 2. Hospital do próximo plantão, em qualquer vínculo do usuário. O WHERE
  //    é preso ao user_id: plantão de terceiro nunca entra.
  const [next] = await db
    .select({
      latitude: hospitals.latitude,
      longitude: hospitals.longitude,
      hospitalTimeZone: hospitals.timeZone,
      institutionTimeZone: institutions.timeZone,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(
      shiftInstances,
      eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
    )
    .innerJoin(
      professionals,
      eq(professionals.id, shiftAssignmentsV2.professionalId),
    )
    .innerJoin(sectors, eq(sectors.id, shiftInstances.sectorId))
    .innerJoin(hospitals, eq(hospitals.id, sectors.hospitalId))
    .innerJoin(institutions, eq(institutions.id, hospitals.institutionId))
    .where(
      and(eq(professionals.userId, userId), gt(shiftInstances.startAt, now)),
    )
    .orderBy(asc(shiftInstances.startAt))
    .limit(1);

  if (next?.latitude && next?.longitude) {
    const point = {
      latitude: Number(next.latitude),
      longitude: Number(next.longitude),
    };
    if (isValidGeoPoint(point)) {
      return {
        point,
        timeZone: resolveScheduleTimeZone({
          hospitalTimeZone: next.hospitalTimeZone,
          institutionTimeZone: next.institutionTimeZone,
        }),
      };
    }
  }

  // 3. Qualquer hospital localizado de uma instituição à qual o usuário está
  //    vinculado.
  //
  //    Médico entre escalas — de férias, recém-cadastrado, ou simplesmente
  //    sem plantão marcado — continua sendo de algum lugar. Sem este degrau,
  //    a saudação ficaria sem clima exatamente para quem ainda não tem nada
  //    no sistema, que é quem mais precisa achar que o app funciona.
  const [anyHospital] = await db
    .select({
      latitude: hospitals.latitude,
      longitude: hospitals.longitude,
      hospitalTimeZone: hospitals.timeZone,
      institutionTimeZone: institutions.timeZone,
    })
    .from(professionalInstitutions)
    .innerJoin(
      hospitals,
      eq(hospitals.institutionId, professionalInstitutions.institutionId),
    )
    .innerJoin(institutions, eq(institutions.id, hospitals.institutionId))
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        isNotNull(hospitals.latitude),
        isNotNull(hospitals.longitude),
      ),
    )
    .orderBy(asc(hospitals.id))
    .limit(1);

  if (!anyHospital?.latitude || !anyHospital?.longitude) return null;
  const fallbackPoint = {
    latitude: Number(anyHospital.latitude),
    longitude: Number(anyHospital.longitude),
  };
  if (!isValidGeoPoint(fallbackPoint)) return null;
  return {
    point: fallbackPoint,
    timeZone: resolveScheduleTimeZone({
      hospitalTimeZone: anyHospital.hospitalTimeZone,
      institutionTimeZone: anyHospital.institutionTimeZone,
    }),
  };
}

export const weatherRouter = router({
  /**
   * Clima local para a saudação.
   *
   * Nunca lança: toda falha vira `available: false`, e a tela mostra só a
   * saudação. Clima é ornamento — derrubar o cabeçalho do app por causa de um
   * provedor externo seria trocar uma informação opcional por um defeito
   * visível.
   */
  localConditions: sessionProcedure.query(async ({ ctx }) => {
    const unavailable = {
      available: false as const,
      configured:
        weatherKitConfiguration().state ===
        PROVIDER_CONFIGURATION_STATES.configured,
    };

    try {
      const db = await getDb();
      if (!db) return unavailable;

      const config = readWeatherKitConfig();
      if (!config) return unavailable;

      const now = new Date();
      const location = await resolveUserLocation(db, ctx.user.id, now);
      if (!location) return unavailable;

      const coarse = coarsenGeoPoint(location.point);
      const key = cacheKey(coarse);
      const hit = cache.get(key);
      if (hit && now.getTime() - hit.at < CACHE_TTL_MS) {
        return {
          available: true as const,
          configured: true,
          condition: hit.condition,
          temperatureCelsius: hit.temperatureCelsius,
          attribution: hit.attribution,
        };
      }

      const provider = createWeatherKitProvider(config);
      const forecast = await provider.forecastAt({
        coarseLocation: coarse,
        atUtc: now,
        timeZone: location.timeZone,
      });
      if (!forecast.ok) return unavailable;

      cache.set(key, {
        at: now.getTime(),
        condition: forecast.value.condition,
        temperatureCelsius: forecast.value.temperatureCelsius,
        attribution: forecast.value.attribution,
      });

      return {
        available: true as const,
        configured: true,
        condition: forecast.value.condition,
        temperatureCelsius: forecast.value.temperatureCelsius,
        attribution: forecast.value.attribution,
      };
    } catch {
      // Nenhuma falha de clima chega à tela como erro.
      return unavailable;
    }
  }),
});
