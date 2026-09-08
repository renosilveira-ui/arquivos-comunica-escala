import { and, eq } from "drizzle-orm";
import { shiftInstances } from "../drizzle/schema";
import type { getDb } from "./db";
import { isProfessionalUserEligibleForVacantShift } from "./plantonista-shift-eligibility";
import { PersistedPushAuthorityBindingError } from "./push-authority-rejection";

export type VacancyBroadcastPushAuthority = {
  kind: "VACANCY_BROADCAST";
  purpose: "VACANCY_AVAILABLE";
  expectedUserId: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  shiftInstanceId: number;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AuthorityDb = Pick<Db, "execute" | "select">;

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseVacancyBroadcastPushAuthority(
  value: Readonly<Record<string, unknown>>,
): VacancyBroadcastPushAuthority | null {
  if (
    value.kind !== "VACANCY_BROADCAST" ||
    value.purpose !== "VACANCY_AVAILABLE" ||
    !positiveId(value.expectedUserId) ||
    !positiveId(value.institutionId) ||
    !positiveId(value.hospitalId) ||
    !positiveId(value.sectorId) ||
    !positiveId(value.shiftInstanceId)
  ) {
    return null;
  }
  return value as VacancyBroadcastPushAuthority;
}

export function vacancyBroadcastAuthorityMatchesPayload(
  authority: VacancyBroadcastPushAuthority,
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  return (
    payloadData.type === "vacancy_available" &&
    payloadData.institutionId === authority.institutionId &&
    payloadData.hospitalId === authority.hospitalId &&
    payloadData.sectorId === authority.sectorId &&
    payloadData.shiftInstanceId === authority.shiftInstanceId &&
    payloadData.userId === authority.expectedUserId
  );
}

export function isVacancyBroadcastPushPayload(
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  return payloadData.type === "vacancy_available";
}

export async function requireAuthorizedVacancyBroadcastRecipient(
  db: AuthorityDb,
  authority: VacancyBroadcastPushAuthority,
  lockForShare = false,
): Promise<void> {
  const eligible = await isProfessionalUserEligibleForVacantShift(db, {
    id: authority.shiftInstanceId,
    institutionId: authority.institutionId,
    hospitalId: authority.hospitalId,
    sectorId: authority.sectorId,
    expectedUserId: authority.expectedUserId,
    lockForShare,
  });
  if (!eligible) {
    throw new PersistedPushAuthorityBindingError(
      "Destinatário não está mais elegível para o plantão vago",
    );
  }
}

/**
 * Converte somente uma intenção legada ainda não submetida. A topologia é
 * reconstruída do turno e a elegibilidade atual é comprovada sob lock antes
 * de o outbox ganhar autoridade e voltar ao fluxo normal de submissão.
 */
export async function requireAuthorizedLegacyVacancyBroadcastAuthority(
  db: AuthorityDb,
  input: Readonly<{
    expectedUserId: number;
    institutionId: number;
    shiftInstanceId: number;
    payloadData: Readonly<Record<string, unknown>>;
  }>,
): Promise<VacancyBroadcastPushAuthority> {
  const [shift] = await db
    .select({
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.id, input.shiftInstanceId),
        eq(shiftInstances.institutionId, input.institutionId),
      ),
    )
    .limit(1)
    .for("share");
  if (
    !shift ||
    !positiveId(shift.hospitalId) ||
    !positiveId(shift.sectorId) ||
    (input.payloadData.hospitalId !== undefined &&
      input.payloadData.hospitalId !== shift.hospitalId) ||
    (input.payloadData.sectorId !== undefined &&
      input.payloadData.sectorId !== shift.sectorId)
  ) {
    throw new PersistedPushAuthorityBindingError(
      "Outbox legado não corresponde à topologia canônica do plantão",
    );
  }
  const authority: VacancyBroadcastPushAuthority = {
    kind: "VACANCY_BROADCAST",
    purpose: "VACANCY_AVAILABLE",
    expectedUserId: input.expectedUserId,
    institutionId: input.institutionId,
    hospitalId: shift.hospitalId,
    sectorId: shift.sectorId,
    shiftInstanceId: input.shiftInstanceId,
  };
  await requireAuthorizedVacancyBroadcastRecipient(db, authority, true);
  return authority;
}
