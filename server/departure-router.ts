import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  hospitals,
  userDeparturePreferences,
  userTravelOrigins,
} from "../drizzle/schema";
import {
  PROVIDER_CONFIGURATION_STATES,
  TRAVEL_ORIGIN_SEAL_SCOPE,
} from "../lib/integration-providers";
import {
  getTenantActorFromContext,
  assertCanCreateHospital,
} from "./_core/policy";
import { router, sessionProcedure, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import {
  readDeparturePreferences,
  syncDeparturePlans,
} from "./departure-engine";
import { sealExternalCredential } from "./external-credentials-crypto";
import { googleMapsConfiguration } from "./integrations/providers/configuration";
import { createGoogleLocationProvider } from "./integrations/google/places-client";
import { isValidPlaceId } from "./integrations/providers/location-provider";

/**
 * Aviso de "hora de sair": preferências, origem de deslocamento e destino
 * hospitalar.
 *
 * Três autoridades distintas convivem aqui, e a separação é o ponto do
 * arquivo:
 *
 * - **preferências e origem**: da CONTA. `sessionProcedure`, nenhum papel
 *   institucional autoriza ler ou escrever a origem de outra pessoa.
 * - **destino hospitalar**: do TENANT. Exige gestão da instituição do
 *   hospital, via `server/_core/policy.ts`.
 * - **busca de lugares**: proxy da nossa chave; o app nunca fala com o Google.
 */

const CONSENT_VERSION = "origem-v1";

const labelSchema = z.string().trim().min(1).max(60);
const placeIdSchema = z
  .string()
  .trim()
  .refine(isValidPlaceId, "Identificador de lugar inválido.");
const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Serviço indisponível no momento.",
    });
  }
  return db;
}

function requireMapsProvider() {
  const report = googleMapsConfiguration();
  if (report.state !== PROVIDER_CONFIGURATION_STATES.configured) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "A busca de endereços ainda não está disponível nesta instalação.",
    });
  }
  const apiKey = (process.env.GOOGLE_MAPS_API_KEY ?? "").trim();
  return createGoogleLocationProvider(apiKey);
}

export const departureRouter = router({
  /**
   * Estado do aviso para a tela de preferências.
   *
   * Devolve o rótulo da origem, nunca o endereço: a lista não é lugar para o
   * endereço residencial de ninguém, nem mesmo do próprio dono.
   */
  status: sessionProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const preferences = await readDeparturePreferences(db, ctx.user.id);
    const origins = await db
      .select({
        id: userTravelOrigins.id,
        label: userTravelOrigins.label,
        isDefault: userTravelOrigins.isDefault,
        consentGrantedAt: userTravelOrigins.consentGrantedAt,
      })
      .from(userTravelOrigins)
      .where(eq(userTravelOrigins.userId, ctx.user.id))
      .limit(10);

    return {
      mapsAvailable:
        googleMapsConfiguration().state ===
        PROVIDER_CONFIGURATION_STATES.configured,
      enabled: preferences.enabled,
      travelMode: preferences.travelMode,
      travelOriginId: preferences.travelOriginId,
      origins,
    };
  }),

  savePreferences: sessionProcedure
    .input(
      z
        .object({
          enabled: z.boolean(),
          travelMode: z
            .enum(["DRIVING", "WALKING", "TRANSIT"])
            .default("DRIVING"),
          travelOriginId: z.number().int().positive().nullable().default(null),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();

      if (input.travelOriginId !== null) {
        // A origem precisa ser do próprio usuário. Sem esta checagem, um id
        // adivinhado apontaria o cálculo para a casa de outra pessoa.
        const [owned] = await db
          .select({ id: userTravelOrigins.id })
          .from(userTravelOrigins)
          .where(
            and(
              eq(userTravelOrigins.id, input.travelOriginId),
              eq(userTravelOrigins.userId, ctx.user.id),
            ),
          )
          .limit(1);
        if (!owned) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Esta origem não existe na sua conta.",
          });
        }
      }

      await db
        .insert(userDeparturePreferences)
        .values({
          userId: ctx.user.id,
          enabled: input.enabled,
          travelMode: input.travelMode,
          travelOriginId: input.travelOriginId,
        })
        .onDuplicateKeyUpdate({
          set: {
            enabled: input.enabled,
            travelMode: input.travelMode,
            travelOriginId: input.travelOriginId,
            version: sql`${userDeparturePreferences.version} + 1`,
          },
        });

      // Reconcilia já: desligar precisa apagar os planos abertos na hora, não
      // no próximo tick do worker.
      const summary = await syncDeparturePlans({ db, userId: ctx.user.id });
      return { planned: summary.created, cancelled: summary.cancelled };
    }),

  /**
   * Busca de endereço. Proxy da nossa chave: o app nunca fala com o Google.
   *
   * `sessionToken` agrupa as teclas de uma busca numa cobrança só — sem ele,
   * cada letra digitada vira uma requisição faturada.
   */
  searchPlaces: sessionProcedure
    .input(
      z
        .object({
          query: z.string().trim().min(3).max(120),
          sessionToken: z.string().uuid(),
        })
        .strict(),
    )
    .query(async ({ input }) => {
      const provider = requireMapsProvider();
      const result = await provider.autocomplete({
        query: input.query,
        sessionToken: input.sessionToken,
      });
      if (!result.ok) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Não foi possível buscar endereços agora. Tente de novo.",
        });
      }
      return { suggestions: result.value };
    }),

  newSearchSession: sessionProcedure.query(() => ({
    sessionToken: randomUUID(),
  })),

  /**
   * Grava a origem de deslocamento.
   *
   * Consentimento é obrigatório e datado. O endereço é selado com escopo
   * próprio (`TRAVEL_ORIGIN`) — não com o escopo de um provedor, porque ele
   * não pertence a provedor nenhum.
   */
  saveTravelOrigin: sessionProcedure
    .input(
      z
        .object({
          label: labelSchema,
          placeId: placeIdSchema,
          consent: z.literal(true),
          makeDefault: z.boolean().default(true),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const provider = requireMapsProvider();
      const details = await provider.placeDetails({ placeId: input.placeId });
      if (!details.ok) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Não foi possível confirmar este endereço. Tente de novo.",
        });
      }

      const db = await requireDb();
      const sealed = sealExternalCredential(
        JSON.stringify({
          placeId: details.value.placeId,
          latitude: details.value.location.latitude,
          longitude: details.value.location.longitude,
          formattedAddress: details.value.formattedAddress,
        }),
        { userId: ctx.user.id, scope: TRAVEL_ORIGIN_SEAL_SCOPE },
      );

      const now = new Date();
      await db.transaction(async (tx) => {
        if (input.makeDefault) {
          // A coluna gerada + UNIQUE garante uma padrão por conta; limpar
          // antes evita colidir com a própria trava.
          await tx
            .update(userTravelOrigins)
            .set({ isDefault: false })
            .where(eq(userTravelOrigins.userId, ctx.user.id));
        }
        await tx
          .insert(userTravelOrigins)
          .values({
            userId: ctx.user.id,
            label: input.label,
            sealedLocation: sealed,
            encryptionKid: "current",
            consentGrantedAt: now,
            consentVersion: CONSENT_VERSION,
            isDefault: input.makeDefault,
          })
          .onDuplicateKeyUpdate({
            set: {
              sealedLocation: sealed,
              encryptionKid: "current",
              consentGrantedAt: now,
              consentVersion: CONSENT_VERSION,
              isDefault: input.makeDefault,
              version: sql`${userTravelOrigins.version} + 1`,
            },
          });
      });

      await syncDeparturePlans({ db, userId: ctx.user.id });
      return { saved: true };
    }),

  /**
   * Apaga a origem. LGPD: o usuário precisa poder remover o dado, e remover
   * de verdade — não marcar como inativo.
   */
  deleteTravelOrigin: sessionProcedure
    .input(z.object({ originId: z.number().int().positive() }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const [deleted] = await db
        .delete(userTravelOrigins)
        .where(
          and(
            eq(userTravelOrigins.id, input.originId),
            eq(userTravelOrigins.userId, ctx.user.id),
          ),
        );
      if (!deleted || deleted.affectedRows !== 1) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Esta origem não existe na sua conta.",
        });
      }
      await syncDeparturePlans({ db, userId: ctx.user.id });
      return { deleted: true };
    }),

  /**
   * Destino hospitalar. Autoridade do TENANT, não da conta.
   *
   * `assertCanCreateHospital` é a mesma porta que governa criar hospital:
   * quem pode criar a topologia pode dizer onde ela fica. O `WHERE` carrega
   * `institution_id` — um gestor de A não configura hospital de B.
   */
  saveHospitalLocation: protectedProcedure
    .input(
      z
        .object({
          hospitalId: z.number().int().positive(),
          placeId: placeIdSchema.nullable().default(null),
          latitude: latitudeSchema,
          longitude: longitudeSchema,
          timeZone: z.string().trim().max(64).nullable().default(null),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanCreateHospital(actor);
      const db = await requireDb();

      const [updated] = await db
        .update(hospitals)
        .set({
          googlePlaceId: input.placeId,
          latitude: String(input.latitude),
          longitude: String(input.longitude),
          ...(input.timeZone ? { timeZone: input.timeZone } : {}),
          locationUpdatedAt: new Date(),
          locationUpdatedByUserId: ctx.user.id,
        })
        .where(
          and(
            eq(hospitals.id, input.hospitalId),
            eq(hospitals.institutionId, actor.institutionId),
          ),
        );

      if (!updated || updated.affectedRows !== 1) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Este hospital não pertence à instituição ativa.",
        });
      }
      return { saved: true };
    }),

  listHospitalLocations: protectedProcedure.query(async ({ ctx }) => {
    const actor = await getTenantActorFromContext(ctx);
    const db = await requireDb();
    const rows = await db
      .select({
        id: hospitals.id,
        name: hospitals.name,
        latitude: hospitals.latitude,
        longitude: hospitals.longitude,
        timeZone: hospitals.timeZone,
        locationUpdatedAt: hospitals.locationUpdatedAt,
      })
      .from(hospitals)
      .where(eq(hospitals.institutionId, actor.institutionId))
      .limit(100);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      configured: Boolean(row.latitude && row.longitude),
      timeZone: row.timeZone,
      locationUpdatedAt: row.locationUpdatedAt,
    }));
  }),
});
