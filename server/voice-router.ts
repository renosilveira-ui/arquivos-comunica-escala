// server/voice-router.ts — endpoint do comando de voz.
//
// voice.interpret: texto → intenção resolvida + texto de confirmação.
// SEM efeitos colaterais: a execução é o app chamando swaps.offer com os
// IDs e o TIPO resolvidos aqui, depois de o usuário confirmar.
//
// O tipo da oferta (SWAP ou CESSAO) é autoridade do servidor. Clientes que
// não anunciam suportar troca recebem erro explícito em vez de uma cessão
// silenciosa — ver `supportedOfferTypes`.

import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getTenantActorFromContext } from "./_core/policy";
import { interpretVoiceSwapCommand } from "./voice/interpret";

export const voiceRouter = router({
  interpret: protectedProcedure
    .input(
      z.object({
        text: z.string().min(3).max(500),
        /** Desambiguação: o usuário tocou num colega candidato. */
        targetProfessionalId: z.number().optional(),
        /** Desambiguação: o usuário tocou num dos seus plantões. */
        ownShiftInstanceId: z.number().optional(),
        /** Desambiguação: o usuário tocou na contrapartida da troca. */
        targetShiftInstanceId: z.number().optional(),
        /**
         * Tipos de oferta que este build do app sabe materializar. Ausente
         * = cliente antigo, que só executa CESSAO.
         */
        supportedOfferTypes: z.array(z.enum(["SWAP", "CESSAO"])).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      if (!actor.professionalId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Profissional não encontrado",
        });
      }

      return interpretVoiceSwapCommand({
        text: input.text,
        actor: {
          userId: actor.userId,
          professionalId: actor.professionalId,
          institutionId: actor.institutionId,
        },
        supportedOfferTypes: input.supportedOfferTypes,
        targetProfessionalId: input.targetProfessionalId,
        ownShiftInstanceId: input.ownShiftInstanceId,
        targetShiftInstanceId: input.targetShiftInstanceId,
      });
    }),
});
