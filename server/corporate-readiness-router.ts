import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  getTenantActorFromContext,
} from "./_core/policy";
import { protectedProcedure, router } from "./_core/trpc";
import { getCorporateReadinessReport } from "./corporate-readiness-v1";
import { getDb } from "./db";

const readinessInput = z.object({
  hospitalId: z.number().int().positive(),
  sectorId: z.number().int().positive().optional(),
  yearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
});

/**
 * Diagnóstico administrativo somente de leitura. O tenant é sempre derivado
 * do vínculo autenticado; o cliente não informa institutionId.
 */
export const corporateReadinessRouter = router({
  get: protectedProcedure
    .input(readinessInput)
    .query(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      // Sem sectorId, o policy exige manager_scope hospitalar. Com sectorId,
      // o gestor setorial recebe somente o relatório daquele setor.
      await assertManagerScopeAccess(actor, input.hospitalId, input.sectorId);
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Banco de dados indisponível",
        });
      }
      return getCorporateReadinessReport(db, {
        institutionId: actor.institutionId,
        hospitalId: input.hospitalId,
        ...(input.sectorId === undefined ? {} : { sectorId: input.sectorId }),
        yearMonth: input.yearMonth,
      });
    }),
});
