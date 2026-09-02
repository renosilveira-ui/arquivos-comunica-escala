import { router, sessionProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import {
  countUnreadAccountBadgeNotifications,
  acknowledgeUnreadAccountBadgeNotifications,
} from "./account-wide-notification-badge";
import { dispatchAccountWideNativeBadgeSnapshot } from "./notifications-service";

/**
 * Leituras e acknowledgements de badge são deliberadamente account-scoped.
 * Não aceitam nem resolvem um tenant; cada instituição é revalidada pelo
 * selector canônico antes de entrar na contagem ou sofrer write.
 */
export const notificationsRouter = router({
  getUnreadAccountBadgeCount: sessionProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
    return {
      count: await countUnreadAccountBadgeNotifications(db, {
        userId: ctx.user.id,
        sessionVersion: ctx.user.sessionVersion,
      }),
    };
  }),

  acknowledgeAccountBadge: sessionProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
    const subject = {
      userId: ctx.user.id,
      sessionVersion: ctx.user.sessionVersion,
    } as const;
    const acknowledged = await acknowledgeUnreadAccountBadgeNotifications(
      db,
      subject,
    );
    const count = await countUnreadAccountBadgeNotifications(db, subject);
    // Atualiza os demais aparelhos iOS da mesma conta sem manter a resposta
    // da mutação presa à rede do Expo. O sender revalida este tenant e cada
    // token sob mutex imediatamente antes de submeter o snapshot.
    if (ctx.institutionId !== null) {
      dispatchAccountWideNativeBadgeSnapshot(ctx.user.id, ctx.institutionId);
    }
    return {
      // Não expõe rows nem IDs: devolve somente a verdade reconstruída da
      // conta atual, para o cliente reconciliar o ícone localmente.
      count,
      acknowledged,
    };
  }),
});
