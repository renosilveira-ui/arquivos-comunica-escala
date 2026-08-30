import { and, desc, eq, like } from "drizzle-orm";
import { notifications } from "../../drizzle/schema";
import { getDb } from "../db";
import { DUTY_SYNC_VERSION } from "./duty-sync";

export const DUTY_SYNC_NOTIFICATION_TITLE = "Duty roster sync";

/** Escopo explícito: outbox local do Escala+; não implica efeito semântico no Comunica+. */
export const DUTY_SYNC_LOCAL_STATUS_SCOPE = "escala_outbox" as const;

export type DutySyncLocalDeliveryStatus =
  | "pending"
  | "outbox_processed"
  | "failed"
  | "none";

export type DutySyncLocalStatus = {
  scope: typeof DUTY_SYNC_LOCAL_STATUS_SCOPE;
  status: DutySyncLocalDeliveryStatus;
  action: "CONFIRM" | "WITHDRAW" | null;
  confirmationId: number | null;
  notificationId: number | null;
  updatedAt: string | null;
  errorMessage: string | null;
};

type DutySyncNotificationRow = {
  id: number;
  title: string;
  status: typeof notifications.$inferSelect.status;
  body: string | null;
  errorMessage: string | null;
  sentAt: Date | null;
  createdAt: Date;
  providerReceipt: unknown;
};

const EMPTY_STATUS: DutySyncLocalStatus = {
  scope: DUTY_SYNC_LOCAL_STATUS_SCOPE,
  status: "none",
  action: null,
  confirmationId: null,
  notificationId: null,
  updatedAt: null,
  errorMessage: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isDutySyncReceipt(receipt: Record<string, unknown> | null): boolean {
  return receipt?.dutySyncVersion === DUTY_SYNC_VERSION;
}

export function mapDutySyncNotificationRow(
  row: DutySyncNotificationRow | undefined,
): DutySyncLocalStatus {
  if (!row || row.title !== DUTY_SYNC_NOTIFICATION_TITLE) {
    return EMPTY_STATUS;
  }

  const receipt = asRecord(row.providerReceipt);
  if (!receipt || !isDutySyncReceipt(receipt)) {
    return EMPTY_STATUS;
  }

  const confirmationId =
    typeof receipt.confirmationId === "number" &&
    Number.isSafeInteger(receipt.confirmationId) &&
    receipt.confirmationId > 0
      ? receipt.confirmationId
      : null;
  const action =
    row.body === "CONFIRM" || row.body === "WITHDRAW" ? row.body : null;
  const status: DutySyncLocalDeliveryStatus =
    row.status === "SENT"
      ? "outbox_processed"
      : row.status === "FAILED"
        ? "failed"
        : "pending";
  const terminalAt =
    typeof receipt.terminalAt === "string" ? receipt.terminalAt : null;
  const updatedAtSource = row.sentAt ?? terminalAt ?? row.createdAt;
  const updatedAt =
    updatedAtSource instanceof Date
      ? updatedAtSource.toISOString()
      : typeof updatedAtSource === "string"
        ? updatedAtSource
        : null;

  return {
    scope: DUTY_SYNC_LOCAL_STATUS_SCOPE,
    status,
    action,
    confirmationId,
    notificationId: row.id,
    updatedAt,
    errorMessage: row.errorMessage ?? null,
  };
}

export function dutySyncDedupKeyPrefix(confirmationId: number): string {
  return `duty-confirmation:${confirmationId}:duty-sync:`;
}

type DutySyncLocalLookupDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

export async function getDutySyncLocalStatusForConfirmation(
  db: DutySyncLocalLookupDb,
  input: {
    confirmationId: number;
    institutionId: number;
    userId: number;
  },
): Promise<DutySyncLocalStatus> {
  const [row] = await db
    .select({
      id: notifications.id,
      status: notifications.status,
      body: notifications.body,
      title: notifications.title,
      errorMessage: notifications.errorMessage,
      sentAt: notifications.sentAt,
      createdAt: notifications.createdAt,
      providerReceipt: notifications.providerReceipt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.institutionId, input.institutionId),
        eq(notifications.userId, input.userId),
        eq(notifications.title, DUTY_SYNC_NOTIFICATION_TITLE),
        like(
          notifications.dedupKey,
          `${dutySyncDedupKeyPrefix(input.confirmationId)}%`,
        ),
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(1);

  return mapDutySyncNotificationRow(row);
}
