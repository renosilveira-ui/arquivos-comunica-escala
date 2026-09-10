/**
 * Perfil — canais de contato (WhatsApp).
 * Identidade global do titular, sem autorização ou auditoria institucional.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, sessionProcedure } from "./_core/trpc";
import {
  deactivateUserWhatsAppContact,
  getWhatsAppContactForUser,
  upsertUserWhatsAppContact,
} from "./user-contact-channels";
import {
  checkWhatsAppVerification,
  startWhatsAppVerification,
} from "./whatsapp-verification";

const accountProfileProcedure = sessionProcedure.use(({ ctx, next }) => {
  if (ctx.user.deletedAt || ctx.user.approvalStatus !== "APPROVED") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Conta indisponível para WhatsApp.",
    });
  }
  if (
    !Number.isSafeInteger(ctx.user.sessionVersion) ||
    ctx.user.sessionVersion <= 0
  ) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sessão inválida." });
  }
  return next({ ctx });
});

export const profileRouter = router({
  getWhatsAppContact: accountProfileProcedure.query(async ({ ctx }) => {
    const contact = await getWhatsAppContactForUser(
      ctx.user.id,
      ctx.user.sessionVersion,
    );
    if (!contact) {
      return {
        status: "missing" as const,
        maskedAddress: null,
        verified: false,
        active: false,
      };
    }
    return {
      status: contact.verified
        ? ("verified" as const)
        : ("unverified" as const),
      maskedAddress: contact.maskedAddress,
      verified: contact.verified,
      active: contact.active,
    };
  }),

  setWhatsAppContact: accountProfileProcedure
    .input(
      z.object({
        phone: z.string().min(1).max(40),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // userId e verifiedAt NUNCA vêm do cliente.
      const contact = await upsertUserWhatsAppContact({
        userId: ctx.user.id,
        rawPhone: input.phone,
        sessionVersion: ctx.user.sessionVersion,
      });
      return {
        status: contact.verified
          ? ("verified" as const)
          : ("unverified" as const),
        maskedAddress: contact.maskedAddress,
        verified: contact.verified,
        active: contact.active,
      };
    }),

  deactivateWhatsAppContact: accountProfileProcedure.mutation(
    async ({ ctx }) => {
      await deactivateUserWhatsAppContact({
        userId: ctx.user.id,
        sessionVersion: ctx.user.sessionVersion,
      });
      return {
        status: "missing" as const,
        maskedAddress: null,
        verified: false,
        active: false,
      };
    },
  ),

  startWhatsAppVerification: accountProfileProcedure
    .input(
      z.object({
        phone: z.string().min(1).max(40).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return startWhatsAppVerification({
        userId: ctx.user.id,
        sessionVersion: ctx.user.sessionVersion,
        phone: input.phone,
        req: ctx.req,
      });
    }),

  checkWhatsAppVerification: accountProfileProcedure
    .input(
      z.object({
        code: z.string().min(4).max(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return checkWhatsAppVerification({
        userId: ctx.user.id,
        code: input.code,
        sessionVersion: ctx.user.sessionVersion,
        req: ctx.req,
      });
    }),
});
