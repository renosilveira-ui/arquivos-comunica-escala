import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { shiftInstances } from "../drizzle/schema";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Campos de negócio que podem mudar uma instância de turno. A revisão não é
 * recebida do caller: ela sempre avança no mesmo UPDATE condicional.
 */
export type ShiftInstanceRevisionPatch = Partial<
  Pick<
    typeof shiftInstances.$inferInsert,
    | "status"
    | "startAt"
    | "endAt"
    | "modality"
    | "coverageType"
    | "paymentModel"
    | "productivityCapBrl"
  >
>;

export type LockedShiftInstanceRevision = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  operationalRevision: number;
};

export type ShiftInstanceRevisionTx = Pick<Db, "update">;

/**
 * Atualiza a instância sob CAS. Toda escrita que altera o turno deve passar
 * aqui para que o futuro ledger use uma versão que representa exatamente o
 * commit da mutação, sem aceitar versão informada pelo cliente.
 */
export async function advanceShiftInstanceRevision(
  tx: ShiftInstanceRevisionTx,
  target: LockedShiftInstanceRevision,
  patch: ShiftInstanceRevisionPatch,
): Promise<number> {
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "advanceShiftInstanceRevision requer uma alteração efetiva do turno.",
    );
  }
  if (
    !Number.isSafeInteger(target.operationalRevision) ||
    target.operationalRevision < 0
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A revisão operacional do turno é inválida.",
    });
  }

  const [updated] = await tx
    .update(shiftInstances)
    .set({
      ...patch,
      operationalRevision: sql`${shiftInstances.operationalRevision} + 1`,
    })
    .where(
      and(
        eq(shiftInstances.id, target.id),
        eq(shiftInstances.institutionId, target.institutionId),
        eq(shiftInstances.hospitalId, target.hospitalId),
        eq(shiftInstances.sectorId, target.sectorId),
        eq(shiftInstances.operationalRevision, target.operationalRevision),
      ),
    );

  if (updated.affectedRows !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "O turno mudou enquanto a atualização era processada.",
    });
  }

  return target.operationalRevision + 1;
}
