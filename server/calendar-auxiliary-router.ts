import { z } from "zod";

import { router, sessionProcedure } from "./_core/trpc";
import { listBrazilCearaHolidays } from "./calendar-holidays";

const supportedYearSchema = z.number().int().min(2000).max(2100);

/**
 * Dados auxiliares account-wide da Agenda. Este leitor não recebe nem deriva
 * tenant: feriados não concedem acesso a nenhuma escala institucional.
 */
export const calendarAuxiliaryRouter = router({
  listHolidays: sessionProcedure
    .input(
      z
        .object({
          year: supportedYearSchema,
          countryCode: z.literal("BR").default("BR"),
          stateCode: z.literal("CE").default("CE"),
        })
        .strict(),
    )
    .query(({ input }) => ({
      countryCode: input.countryCode,
      stateCode: input.stateCode,
      year: input.year,
      holidays: listBrazilCearaHolidays(input.year),
    })),
});
