import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { router, sessionProcedure } from "./_core/trpc";
import { getDb } from "./db";
import {
  PersonalCalendarValidationError,
  personalCalendarAlertOffsetsSchema,
  personalCalendarItemDraftSchema,
  personalCalendarOccurrenceWindowSchema,
  personalCalendarRecurrenceSchema,
  validatePersonalCalendarSeries,
} from "./personal-calendar-domain";
import {
  checkPersonalCalendarDraftConflicts,
  createPersonalCalendarItem,
  deletePersonalCalendarItem,
  listPersonalCalendarWindow,
  loadPersonalCalendarItem,
  updatePersonalCalendarItem,
} from "./personal-calendar-service";

const itemIdSchema = z.number().int().positive();
const versionSchema = z.number().int().positive();
const clientMutationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, "Identificador de operação inválido.");

const conflictDateInputSchema = z.string().min(1).max(10);
const conflictTimeInputSchema = z.string().min(1).max(8);
const conflictTimeZoneInputSchema = z.string().trim().min(1).max(64);
const conflictAvailabilityInputSchema = z
  .enum(["BUSY", "FREE"])
  .default("BUSY");

/**
 * Prévia de conflito aceita somente os campos temporais necessários. Título,
 * local e anotações privadas não trafegam em query string nem em logs HTTP.
 */
const conflictItemInputSchema = z
  .union([
    z
      .object({
        kind: z.literal("APPOINTMENT"),
        allDay: z.literal(false),
        availability: conflictAvailabilityInputSchema,
        startLocalDate: conflictDateInputSchema,
        startLocalTime: conflictTimeInputSchema,
        endLocalDate: conflictDateInputSchema,
        endLocalTime: conflictTimeInputSchema,
        timeZone: conflictTimeZoneInputSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("APPOINTMENT"),
        allDay: z.literal(true),
        availability: conflictAvailabilityInputSchema,
        startLocalDate: conflictDateInputSchema,
        endLocalDate: conflictDateInputSchema,
        timeZone: conflictTimeZoneInputSchema,
      })
      .strict(),
  ])
  .transform((item, context) => {
    const parsed = personalCalendarItemDraftSchema.safeParse({
      ...item,
      title: "Prévia de conflito",
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: [...issue.path],
        });
      }
      return z.NEVER;
    }
    return parsed.data;
  });

const seriesInputShape = {
  item: personalCalendarItemDraftSchema,
  recurrence: personalCalendarRecurrenceSchema.nullable().default(null),
};

const itemWriteShape = {
  ...seriesInputShape,
  alertOffsets: personalCalendarAlertOffsetsSchema.default([]),
};

function refineSeriesInput(
  input: { item: unknown; recurrence: unknown | null },
  context: {
    addIssue(issue: {
      code: "custom";
      message: string;
      path: (string | number)[];
    }): void;
  },
): void {
  try {
    validatePersonalCalendarSeries(input.item, input.recurrence);
  } catch (error) {
    if (!(error instanceof PersonalCalendarValidationError)) throw error;
    context.addIssue({
      code: "custom",
      message: error.message,
      path: ["recurrence"],
    });
  }
}

const checkConflictsInputSchema = z
  .object({
    item: conflictItemInputSchema,
    recurrence: personalCalendarRecurrenceSchema.nullable().default(null),
    window: personalCalendarOccurrenceWindowSchema,
    excludeItemId: itemIdSchema.optional(),
  })
  .strict()
  .superRefine(refineSeriesInput);

const createItemInputSchema = z
  .object({
    clientMutationId: clientMutationIdSchema,
    ...itemWriteShape,
  })
  .strict()
  .superRefine(refineSeriesInput);

const updateItemInputSchema = z
  .object({
    itemId: itemIdSchema,
    expectedVersion: versionSchema,
    ...itemWriteShape,
  })
  .strict()
  .superRefine(refineSeriesInput);

const personalCalendarReadTransactionConfig = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Agenda pessoal indisponível.",
    });
  }
  return db;
}

/**
 * Toda violação de invariante do domínio é erro do pedido, não do servidor.
 *
 * O mapa é exaustivo por tipo: um código novo em
 * `PersonalCalendarValidationError` quebra o typecheck aqui, em vez de
 * escorregar silenciosamente para 500 em produção.
 */
const VALIDATION_TRPC_CODES: Record<
  PersonalCalendarValidationError["code"],
  "BAD_REQUEST"
> = {
  INVALID_DATE: "BAD_REQUEST",
  INVALID_TIME: "BAD_REQUEST",
  INVALID_TIME_ZONE: "BAD_REQUEST",
  INVALID_LOCAL_TIME: "BAD_REQUEST",
  INVALID_RANGE: "BAD_REQUEST",
  INVALID_RECURRENCE: "BAD_REQUEST",
  QUERY_WINDOW_TOO_LARGE: "BAD_REQUEST",
};

/**
 * Rede de segurança de saída.
 *
 * A validação de entrada já recusa janela e série inválidas, mas a expansão
 * de ocorrências também valida em runtime (fuso inexistente na transição de
 * horário de verão, série que gera ocorrências demais). Sem esta captura,
 * esses casos atravessam o tRPC como INTERNAL_SERVER_ERROR: o cliente vê
 * "erro no servidor" onde deveria ler o motivo e corrigir o pedido.
 */
async function mappingValidationErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PersonalCalendarValidationError) {
      throw new TRPCError({
        code: VALIDATION_TRPC_CODES[error.code],
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Recurso privado da conta. Nenhum endpoint aceita owner, profissional ou
 * tenant do cliente; `sessionProcedure` é a única fronteira de autoridade.
 */
export const personalCalendarRouter = router({
  getItem: sessionProcedure
    .input(z.object({ itemId: itemIdSchema }).strict())
    .query(async ({ ctx, input }) =>
      mappingValidationErrors(async () => {
        const db = await requireDb();
        const item = await db.transaction(
          (tx) => loadPersonalCalendarItem(tx, ctx.user.id, input.itemId),
          personalCalendarReadTransactionConfig,
        );
        if (!item) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Compromisso não encontrado.",
          });
        }
        return item;
      }),
    ),

  listWindow: sessionProcedure
    .input(personalCalendarOccurrenceWindowSchema)
    .query(async ({ ctx, input }) =>
      mappingValidationErrors(async () => {
        const db = await requireDb();
        return db.transaction(
          (tx) =>
            listPersonalCalendarWindow({
              db: tx,
              ownerUserId: ctx.user.id,
              window: input,
            }),
          personalCalendarReadTransactionConfig,
        );
      }),
    ),

  checkConflicts: sessionProcedure
    .input(checkConflictsInputSchema)
    // Mutation deliberadamente read-only: força POST e evita datas/horários
    // pessoais na URL, no histórico e em access logs de proxies.
    .mutation(async ({ ctx, input }) =>
      mappingValidationErrors(async () => {
        const db = await requireDb();
        return db.transaction(
          (tx) =>
            checkPersonalCalendarDraftConflicts({
              db: tx,
              ownerUserId: ctx.user.id,
              item: input.item,
              recurrence: input.recurrence,
              window: input.window,
              excludeItemId: input.excludeItemId,
            }),
          personalCalendarReadTransactionConfig,
        );
      }),
    ),

  createItem: sessionProcedure
    .input(createItemInputSchema)
    .mutation(async ({ ctx, input }) =>
      mappingValidationErrors(async () =>
        createPersonalCalendarItem({
          db: await requireDb(),
          ownerUserId: ctx.user.id,
          expectedSessionVersion: ctx.user.sessionVersion,
          clientMutationId: input.clientMutationId,
          item: input.item,
          recurrence: input.recurrence,
          alertOffsets: input.alertOffsets,
        }),
      ),
    ),

  updateItem: sessionProcedure
    .input(updateItemInputSchema)
    .mutation(async ({ ctx, input }) =>
      mappingValidationErrors(async () =>
        updatePersonalCalendarItem({
          db: await requireDb(),
          ownerUserId: ctx.user.id,
          expectedSessionVersion: ctx.user.sessionVersion,
          itemId: input.itemId,
          expectedVersion: input.expectedVersion,
          item: input.item,
          recurrence: input.recurrence,
          alertOffsets: input.alertOffsets,
        }),
      ),
    ),

  deleteItem: sessionProcedure
    .input(
      z
        .object({
          itemId: itemIdSchema,
          expectedVersion: versionSchema,
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) =>
      mappingValidationErrors(async () =>
        deletePersonalCalendarItem({
          db: await requireDb(),
          ownerUserId: ctx.user.id,
          expectedSessionVersion: ctx.user.sessionVersion,
          itemId: input.itemId,
          expectedVersion: input.expectedVersion,
        }),
      ),
    ),
});
