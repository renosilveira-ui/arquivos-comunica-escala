import { and, eq, isNull } from "drizzle-orm";
import { professionalInstitutions, users } from "../drizzle/schema";
import type { enqueueTrackedPushNotification } from "./push-delivery";

type SignalDb = NonNullable<Parameters<typeof enqueueTrackedPushNotification>[2]>;

export async function resolveInviteAcceptedRecipientUserId(
  db: SignalDb,
  input: {
    institutionId: number;
    createdByUserId: number;
    invitedUserId: number;
  },
): Promise<number | null> {
  if (input.createdByUserId === input.invitedUserId) return null;

  const [row] = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.userId, users.id),
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .where(
      and(
        eq(users.id, input.createdByUserId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

export async function loadInvitedProfessionalName(
  db: SignalDb,
  invitedUserId: number,
): Promise<string> {
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, invitedUserId))
    .limit(1);
  const name = row?.name?.trim();
  return name || "Profissional";
}
