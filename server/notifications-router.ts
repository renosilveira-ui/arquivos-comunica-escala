import { router, sessionProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import {
  countUnreadAccountBadgeNotifications,
  acknowledgeUnreadAccountBadgeNotifications,
} from "./account-wide-notification-badge";

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
    return {
      // Não expõe rows nem IDs: devolve somente a verdade reconstruída da
      // conta atual, para o cliente reconciliar o ícone localmente.
      count: await countUnreadAccountBadgeNotifications(db, subject),
      acknowledged,
    };
  }),
});
