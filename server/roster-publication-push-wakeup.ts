import { and, eq, sql } from "drizzle-orm";
import { notifications } from "../drizzle/schema";
import type { getDb } from "./db";
import { monthWindowBrt } from "./local-time";

export const PUSH_PUBLICATION_DEFERRED_MESSAGE =
  "Entrega aguardando publicação da escala";

const TRACKING_VERSION = 1;
const PUBLICATION_RECHECK_MS = 5 * 60_000;

type WakeDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "update">;

export function nextRosterPublicationRecheckAt(
  now: Date,
  operationalDeadline?: Date | null,
): Date {
  const ordinaryRecheck = new Date(now.getTime() + PUBLICATION_RECHECK_MS);
  if (
    !operationalDeadline ||
    !Number.isFinite(operationalDeadline.getTime()) ||
    operationalDeadline.getTime() > ordinaryRecheck.getTime()
  ) {
    return ordinaryRecheck;
  }
  return new Date(Math.max(now.getTime(), operationalDeadline.getTime()));
}

/**
 * Torna imediatamente elegíveis, no próximo tick do worker, apenas intenções
 * QUEUED que foram explicitamente deferidas por falta de publicação. Estados
 * com ticket/receipt e leases SUBMITTING nunca são reabertos.
 */
export async function wakeDeferredPushesAfterRosterPublication(
  db: WakeDb,
  input: Readonly<{
    institutionId: number;
    hospitalId: number;
    yearMonth: string;
    publishedAt: Date;
  }>,
): Promise<number> {
  const window = monthWindowBrt(input.yearMonth);
  const publishedAtIso = input.publishedAt.toISOString();
  const [result] = await db
    .update(notifications)
    .set({
      providerReceipt: sql`JSON_SET(
        ${notifications.providerReceipt},
        '$.revision', CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.revision')) AS UNSIGNED) + 1,
        '$.availableAt', ${publishedAtIso},
        '$.lastError', 'Escala publicada; aguardando revalidação final'
      )`,
      errorMessage: null,
    })
    .where(
      and(
        eq(notifications.institutionId, input.institutionId),
        eq(notifications.status, "PENDING"),
        sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.trackingVersion')) AS UNSIGNED) = ${TRACKING_VERSION}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'QUEUED'`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.lastError')) = ${PUSH_PUBLICATION_DEFERRED_MESSAGE}`,
        sql`JSON_EXTRACT(${notifications.providerReceipt}, '$.revision') IS NOT NULL`,
        sql`EXISTS (
          SELECT 1
          FROM shift_instances publication_shift
          WHERE publication_shift.id = ${notifications.shiftInstanceId}
            AND publication_shift.institution_id = ${input.institutionId}
            AND publication_shift.hospital_id = ${input.hospitalId}
            AND publication_shift.start_at >= ${window.start}
            AND publication_shift.start_at < ${window.end}
        )`,
      ),
    );
  return Number(result.affectedRows ?? 0);
}
