// server/voice-router.ts — endpoint do comando de voz.
//
// voice.interpret: texto → intenção resolvida + texto de confirmação.
// SEM efeitos colaterais: a execução é o app chamando swaps.offer
// (direcionada) com os IDs resolvidos, após o usuário confirmar.

import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getTenantActorFromContext } from "./_core/policy";
import { parseVoiceCommand, resolveSwapCommand } from "./voice/interpret";

export const voiceRouter = router({
  interpret: protectedProcedure
    .input(z.object({
      text: z.string().min(3).max(500),
      /** Desambiguação: o usuário tocou num candidato — usa este
          profissional em vez do nome dito. */
      targetProfessionalId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      if (!actor.professionalId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Profissional não encontrado" });
      }

      const parsed = parseVoiceCommand(input.text);
      if (parsed.kind === "FALHA") {
        return { ok: false as const, error: parsed.reason };
      }

      return resolveSwapCommand(parsed, {
        userId: ctx.user.id,
        professionalId: actor.professionalId,
        institutionId: actor.institutionId,
        targetProfessionalId: input.targetProfessionalId,
      });
    }),
});
