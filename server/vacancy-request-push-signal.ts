import { and, eq, isNull } from "drizzle-orm";
import {
  hospitals,
  professionalInstitutions,
  professionals,
  sectors,
  users,
} from "../drizzle/schema";
import {
  formatHospitalDate,
  formatHospitalTimeRange,
} from "../lib/hospital-time";
import { enqueueTrackedPushNotification } from "./push-delivery";
import {
  listResponsibleVacancyManagerUserIds,
  VACANCY_REQUEST_PUSH_POLICY,
  type VacancyRequestPushAuthority,
  type VacancyRequestPushPurpose,
} from "./vacancy-request-push-authority";

type SignalDb = NonNullable<
  Parameters<typeof enqueueTrackedPushNotification>[2]
>;

export type VacancyRequestSignalShift = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  startAt: Date;
  endAt: Date;
};

type Place = {
  hospitalName: string | null;
  sectorName: string | null;
};

async function loadPlace(
  db: SignalDb,
  shift: VacancyRequestSignalShift,
): Promise<Place> {
  const [hospital] = await db
    .select({ name: hospitals.name })
    .from(hospitals)
    .where(
      and(
        eq(hospitals.id, shift.hospitalId),
        eq(hospitals.institutionId, shift.institutionId),
      ),
    )
    .limit(1);
  const [sector] = await db
    .select({ name: sectors.name })
    .from(sectors)
    .where(
      and(
        eq(sectors.id, shift.sectorId),
        eq(sectors.institutionId, shift.institutionId),
        eq(sectors.hospitalId, shift.hospitalId),
      ),
    )
    .limit(1);
  return {
    hospitalName: hospital?.name?.trim() || null,
    sectorName: sector?.name?.trim() || null,
  };
}

async function resolveRequester(
  db: SignalDb,
  input: { institutionId: number; professionalId: number },
): Promise<{ userId: number; name: string } | null> {
  const [requester] = await db
    .select({ userId: professionals.userId, name: professionals.name })
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .innerJoin(
      users,
      and(
        eq(users.id, professionals.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(eq(professionals.id, input.professionalId))
    .limit(1);
  return requester
    ? { userId: requester.userId, name: requester.name.trim() }
    : null;
}

function placeSummary(place: Place, shift: VacancyRequestSignalShift): string {
  const location = [place.hospitalName, place.sectorName]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const date = formatHospitalDate(shift.startAt);
  const hours = formatHospitalTimeRange(shift.startAt, shift.endAt);
  return `${location || "Plantão"}, ${date}, ${hours}`;
}

function authority(
  purpose: VacancyRequestPushPurpose,
  input: {
    assignmentId: number;
    userId: number;
    shift: VacancyRequestSignalShift;
  },
): VacancyRequestPushAuthority {
  return {
    kind: "VACANCY_REQUEST",
    purpose,
    assignmentId: input.assignmentId,
    expectedUserId: input.userId,
    institutionId: input.shift.institutionId,
    hospitalId: input.shift.hospitalId,
    sectorId: input.shift.sectorId,
    shiftInstanceId: input.shift.id,
  };
}

export async function enqueueVacancyRequestManagerPushes(input: {
  db: SignalDb;
  assignmentId: number;
  requesterProfessionalId: number;
  shift: VacancyRequestSignalShift;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const [requester, place, managerUserIds] = await Promise.all([
    resolveRequester(input.db, {
      institutionId: input.shift.institutionId,
      professionalId: input.requesterProfessionalId,
    }),
    loadPlace(input.db, input.shift),
    listResponsibleVacancyManagerUserIds(input.db, input.shift),
  ]);
  if (!requester) {
    throw new Error("Solicitante canônico indisponível para notificação");
  }

  const policy = VACANCY_REQUEST_PUSH_POLICY.MANAGER_ACTION_REQUIRED;
  let persisted = 0;
  for (const managerUserId of managerUserIds) {
    await enqueueTrackedPushNotification(
      {
        institutionId: input.shift.institutionId,
        userId: managerUserId,
        shiftInstanceId: input.shift.id,
        dedupKey: `vacancy-request:${input.assignmentId}:manager:${managerUserId}`,
        deepLink: "/(tabs)/pending",
        authority: authority("MANAGER_ACTION_REQUIRED", {
          assignmentId: input.assignmentId,
          userId: managerUserId,
          shift: input.shift,
        }),
        payload: {
          title: "Nova solicitação de plantão",
          body: `${requester.name} solicitou ${placeSummary(place, input.shift)}.`,
          data: {
            type: policy.payloadType,
            institutionId: input.shift.institutionId,
            hospitalId: input.shift.hospitalId,
            sectorId: input.shift.sectorId,
            shiftInstanceId: input.shift.id,
            assignmentId: input.assignmentId,
          },
        },
      },
      now,
      input.db,
    );
    persisted += 1;
  }
  return persisted;
}

export async function enqueueVacancyRequestDecisionPush(input: {
  db: SignalDb;
  purpose: "REQUEST_APPROVED" | "REQUEST_REJECTED";
  assignmentId: number;
  requesterProfessionalId: number;
  shift: VacancyRequestSignalShift;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const requester = await resolveRequester(input.db, {
    institutionId: input.shift.institutionId,
    professionalId: input.requesterProfessionalId,
  });
  if (!requester) {
    // Rejeitar é também a operação que limpa uma pendência inválida. Se o
    // solicitante já perdeu vínculo/conta, não há destinatário autorizado,
    // mas a decisão gerencial precisa ser concluída e auditada. Aprovar segue
    // fail-closed porque cria uma alocação efetiva para esse profissional.
    if (input.purpose === "REQUEST_REJECTED") return 0;
    throw new Error("Solicitante canônico indisponível para notificação");
  }

  const place = await loadPlace(input.db, input.shift);
  const approved = input.purpose === "REQUEST_APPROVED";
  const policy = VACANCY_REQUEST_PUSH_POLICY[input.purpose];
  await enqueueTrackedPushNotification(
    {
      institutionId: input.shift.institutionId,
      userId: requester.userId,
      shiftInstanceId: input.shift.id,
      dedupKey: `vacancy-request:${input.assignmentId}:${approved ? "approved" : "rejected"}:${requester.userId}`,
      deepLink: `/shift-details?id=${input.shift.id}`,
      authority: authority(input.purpose, {
        assignmentId: input.assignmentId,
        userId: requester.userId,
        shift: input.shift,
      }),
      payload: {
        title: approved
          ? "Solicitação de plantão aprovada"
          : "Solicitação de plantão não aprovada",
        body: `Sua solicitação para ${placeSummary(place, input.shift)} foi ${approved ? "aprovada" : "recusada"}.`,
        data: {
          type: policy.payloadType,
          institutionId: input.shift.institutionId,
          hospitalId: input.shift.hospitalId,
          sectorId: input.shift.sectorId,
          shiftInstanceId: input.shift.id,
          assignmentId: input.assignmentId,
        },
      },
    },
    now,
    input.db,
  );
  return 1;
}
