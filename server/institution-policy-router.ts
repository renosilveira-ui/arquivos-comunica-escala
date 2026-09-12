import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { institutions } from "../drizzle/schema";
import {
  assertCanManageInstitutionSchedule,
  getTenantActorFromContext,
} from "./_core/policy";
import { protectedProcedure, router } from "./_core/trpc";
import { recordAudit } from "./audit-trail";
import { getDb } from "./db";

/**
 * Políticas da instituição que são escolha do grupo de trabalho.
 *
 * Decisão do PO (12/09/2026): "plantão não confirmado deve ser notificado
 * ao gestor da escala. Mas deve ter uma chave na aba Perfil para cancelar
 * isso. Isso deve ser uma decisão do grupo de trabalho, não imposição do
 * sistema. Nós oferecemos a ferramenta, apenas."
 *
 * Escopo: o tenant ativo (`ctx.institutionId`), nunca um id vindo do
 * cliente. Ler é para qualquer membro; mudar é para quem gerencia a escala
 * da instituição (`assertCanManageInstitutionSchedule`). Toda mudança fica
 * na auditoria como INSTITUTION_FEATURE_UPDATED.
 */

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Banco indisponível no momento.",
    });
  }
  return db;
}

export const institutionPolicyRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const [row] = await db
      .select({
        notifyManagerOnUnconfirmed: institutions.notifyManagerOnUnconfirmed,
      })
      .from(institutions)
      .where(eq(institutions.id, ctx.institutionId))
      .limit(1);
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Instituição não encontrada.",
      });
    }
    const actor = await getTenantActorFromContext(ctx);
    let canManage = true;
    try {
      assertCanManageInstitutionSchedule(actor);
    } catch {
      canManage = false;
    }
    return {
      notifyManagerOnUnconfirmed: row.notifyManagerOnUnconfirmed,
      canManage,
    };
  }),

  setConfirmationEscalation: protectedProcedure
    .input(z.object({ notifyManagerOnUnconfirmed: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      const db = await requireDb();

      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: institutions.id,
            notifyManagerOnUnconfirmed:
              institutions.notifyManagerOnUnconfirmed,
          })
          .from(institutions)
          .where(eq(institutions.id, ctx.institutionId))
          .limit(1)
          .for("update");
        if (!current) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Instituição não encontrada.",
          });
        }
        if (current.notifyManagerOnUnconfirmed === input.notifyManagerOnUnconfirmed) {
          return;
        }
        await tx
          .update(institutions)
          .set({ notifyManagerOnUnconfirmed: input.notifyManagerOnUnconfirmed })
          .where(eq(institutions.id, ctx.institutionId));
        await recordAudit(
          {
            institutionId: ctx.institutionId,
            action: "INSTITUTION_FEATURE_UPDATED",
            entityType: "INSTITUTION",
            entityId: ctx.institutionId,
            actorUserId: ctx.user.id,
            actorRole: actor.roleInInstitution,
            actorName: ctx.user.name ?? undefined,
            description: input.notifyManagerOnUnconfirmed
              ? "Aviso ao gestor de plantão não confirmado: ligado"
              : "Aviso ao gestor de plantão não confirmado: desligado",
            metadata: {
              policy: "notifyManagerOnUnconfirmed",
              from: current.notifyManagerOnUnconfirmed,
              to: input.notifyManagerOnUnconfirmed,
            },
          },
          { db: tx },
        );
      });

      return { notifyManagerOnUnconfirmed: input.notifyManagerOnUnconfirmed };
    }),
});
