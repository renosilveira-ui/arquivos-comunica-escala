/**
 * Perfil — canais de contato (WhatsApp).
 * Identidade global do usuário; tenant só entra para auditoria.
 */
import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import {
  deactivateUserWhatsAppContact,
  getWhatsAppContactForUser,
  upsertUserWhatsAppContact,
} from "./user-contact-channels";

export const profileRouter = router({
  getWhatsAppContact: protectedProcedure.query(async ({ ctx }) => {
    const contact = await getWhatsAppContactForUser(ctx.user.id);
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

  setWhatsAppContact: protectedProcedure
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
        institutionId: ctx.institutionId!,
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

  deactivateWhatsAppContact: protectedProcedure.mutation(async ({ ctx }) => {
    await deactivateUserWhatsAppContact({
      userId: ctx.user.id,
      institutionId: ctx.institutionId!,
    });
    return {
      status: "missing" as const,
      maskedAddress: null,
      verified: false,
      active: false,
    };
  }),
});
