import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import {
  hospitals,
  institutions,
  personalCalendarAlertRules,
  personalCalendarItems,
  personalCalendarOccurrences,
  personalCalendarOccurrenceExceptions,
  personalCalendarRecurrences,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const FORTALEZA = "America/Fortaleza";

function appointment(
  date: string,
  startLocalTime: string,
  endLocalTime: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    kind: "APPOINTMENT" as const,
    title: "Compromisso",
    allDay: false as const,
    availability: "BUSY" as const,
    startLocalDate: date,
    startLocalTime,
    endLocalDate: date,
    endLocalTime,
    timeZone: FORTALEZA,
    ...overrides,
  };
}

function conflictAppointment(
  date: string,
  startLocalTime: string,
  endLocalTime: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    kind: "APPOINTMENT" as const,
    allDay: false as const,
    availability: "BUSY" as const,
    startLocalDate: date,
    startLocalTime,
    endLocalDate: date,
    endLocalTime,
    timeZone: FORTALEZA,
    ...overrides,
  };
}

const noRecurrence = null;
const noAlerts: number[] = [];

describe("Agenda pessoal — API account-wide e conflitos próprios", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let ownerUserId: number;
  let otherUserId: number;
  let standaloneUserId: number;
  let ownerProfessionalAId: number;
  let ownerProfessionalBId: number;
  let otherProfessionalId: number;
  let institutionAId: number;
  let institutionBId: number;
  let hospitalA1Id: number;
  let hospitalA2Id: number;
  let hospitalBId: number;
  let sectorA1Id: number;
  let sectorA2Id: number;
  let sectorBId: number;
  const shiftIds: number[] = [];

  const callerFor = (userId: number, sessionVersion = 1) =>
    appRouter.createCaller({
      user: {
        id: userId,
        name: `Calendar ${userId}`,
        email: `calendar-${userId}@test.local`,
        role: "doctor",
        sessionVersion,
      },
      institutionId: null,
      allowedInstitutionIds: [],
      tenantProfessionalId: null,
      tenantResolutionError: null,
      req: {} as never,
      res: {} as never,
    } as never);

  async function createShift(input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    professionalId: number;
    startsAtUtc: string;
    endsAtUtc: string;
    label: string;
    assignmentTopology?: { hospitalId: number; sectorId: number };
  }) {
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        label: input.label,
        startAt: new Date(input.startsAtUtc),
        endAt: new Date(input.endsAtUtc),
        status: "OCUPADO",
      })
      .$returningId();
    shiftIds.push(shift.id);
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId: input.institutionId,
        hospitalId: input.assignmentTopology?.hospitalId ?? input.hospitalId,
        sectorId: input.assignmentTopology?.sectorId ?? input.sectorId,
        professionalId: input.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    return { shiftInstanceId: shift.id, assignmentId: assignment.id };
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institutionA] = await db
      .insert(institutions)
      .values({
        name: `Calendar tenant A ${stamp}`,
        cnpj: `${stamp}11`.slice(-14).padStart(14, "0"),
        legalName: `Calendar tenant A ${stamp}`,
        tradeName: `PCA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionAId = institutionA.id;
    const [institutionB] = await db
      .insert(institutions)
      .values({
        name: `Calendar tenant B ${stamp}`,
        cnpj: `${stamp}12`.slice(-14).padStart(14, "0"),
        legalName: `Calendar tenant B ${stamp}`,
        tradeName: `PCB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = institutionB.id;

    const [hospitalA1] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `Hospital A1 ${stamp}` })
      .$returningId();
    hospitalA1Id = hospitalA1.id;
    const [hospitalA2] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `Hospital A2 ${stamp}` })
      .$returningId();
    hospitalA2Id = hospitalA2.id;
    const [hospitalB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionBId, name: `Hospital B ${stamp}` })
      .$returningId();
    hospitalBId = hospitalB.id;

    const [sectorA1] = await db
      .insert(sectors)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalA1Id,
        name: `Setor A1 ${stamp}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    sectorA1Id = sectorA1.id;
    const [sectorA2] = await db
      .insert(sectors)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalA2Id,
        name: `Setor A2 ${stamp}`,
        category: "servico",
        color: "#16A34A",
      })
      .$returningId();
    sectorA2Id = sectorA2.id;
    const [sectorB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        name: `Setor B ${stamp}`,
        category: "servico",
        color: "#7C3AED",
      })
      .$returningId();
    sectorBId = sectorB.id;

    const [owner] = await db
      .insert(users)
      .values({
        name: `Calendar owner ${stamp}`,
        email: `calendar-owner-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    ownerUserId = owner.id;
    const [other] = await db
      .insert(users)
      .values({
        name: `Calendar other ${stamp}`,
        email: `calendar-other-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    otherUserId = other.id;
    const [standalone] = await db
      .insert(users)
      .values({
        name: `Calendar standalone ${stamp}`,
        email: `calendar-standalone-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    standaloneUserId = standalone.id;

    const [ownerProfessionalA] = await db
      .insert(professionals)
      .values({
        userId: ownerUserId,
        name: `Calendar owner A ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    ownerProfessionalAId = ownerProfessionalA.id;
    const [ownerProfessionalB] = await db
      .insert(professionals)
      .values({
        userId: ownerUserId,
        name: `Calendar owner B ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    ownerProfessionalBId = ownerProfessionalB.id;
    const [otherProfessional] = await db
      .insert(professionals)
      .values({
        userId: otherUserId,
        name: `Calendar other ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    otherProfessionalId = otherProfessional.id;

    await db.insert(professionalInstitutions).values([
      {
        professionalId: ownerProfessionalAId,
        userId: ownerUserId,
        institutionId: institutionAId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: ownerProfessionalBId,
        userId: ownerUserId,
        institutionId: institutionBId,
        roleInInstitution: "USER",
        isPrimary: false,
        active: true,
      },
      {
        professionalId: otherProfessionalId,
        userId: otherUserId,
        institutionId: institutionAId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      },
    ]);

    await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalA1Id,
      sectorId: sectorA1Id,
      professionalId: ownerProfessionalAId,
      startsAtUtc: "2026-09-10T12:30:00.000Z",
      endsAtUtc: "2026-09-10T15:00:00.000Z",
      label: "Plantão próprio A1",
    });
    await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalA2Id,
      sectorId: sectorA2Id,
      professionalId: ownerProfessionalAId,
      startsAtUtc: "2026-09-11T12:00:00.000Z",
      endsAtUtc: "2026-09-11T13:00:00.000Z",
      label: "Plantão próprio A2",
    });
    await createShift({
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      professionalId: ownerProfessionalBId,
      startsAtUtc: "2026-09-12T12:00:00.000Z",
      endsAtUtc: "2026-09-12T13:00:00.000Z",
      label: "Plantão próprio B",
    });
    await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalA1Id,
      sectorId: sectorA1Id,
      professionalId: ownerProfessionalAId,
      startsAtUtc: "2026-09-13T12:00:00.000Z",
      endsAtUtc: "2026-09-13T13:00:00.000Z",
      label: "Plantão contaminado",
      assignmentTopology: { hospitalId: hospitalA2Id, sectorId: sectorA2Id },
    });
    await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalA1Id,
      sectorId: sectorA1Id,
      professionalId: otherProfessionalId,
      startsAtUtc: "2026-09-14T12:00:00.000Z",
      endsAtUtc: "2026-09-14T13:00:00.000Z",
      label: "Plantão de outra conta",
    });
  });

  beforeEach(async () => {
    await db
      .delete(personalCalendarItems)
      .where(
        inArray(personalCalendarItems.ownerUserId, [
          ownerUserId,
          otherUserId,
          standaloneUserId,
        ]),
      );
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(
        and(
          eq(professionalInstitutions.userId, ownerUserId),
          eq(professionalInstitutions.institutionId, institutionBId),
        ),
      );
  });

  afterEach(async () => {
    await db
      .update(users)
      .set({ sessionVersion: 1 })
      .where(eq(users.id, ownerUserId));
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(personalCalendarItems)
      .where(
        inArray(personalCalendarItems.ownerUserId, [
          ownerUserId,
          otherUserId,
          standaloneUserId,
        ]),
      );
    if (shiftIds.length > 0) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db
        .delete(shiftInstances)
        .where(inArray(shiftInstances.id, shiftIds));
    }
    const professionalIds = [
      ownerProfessionalAId,
      ownerProfessionalBId,
      otherProfessionalId,
    ];
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.professionalId, professionalIds));
    await db
      .delete(professionals)
      .where(inArray(professionals.id, professionalIds));
    await db
      .delete(users)
      .where(inArray(users.id, [ownerUserId, otherUserId, standaloneUserId]));
    await db
      .delete(sectors)
      .where(inArray(sectors.id, [sectorA1Id, sectorA2Id, sectorBId]));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.id, [hospitalA1Id, hospitalA2Id, hospitalBId]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [institutionAId, institutionBId]));
  });

  it("cria sem tenant, deriva owner da sessão e repete a mesma operação sem duplicar", async () => {
    const caller = callerFor(ownerUserId);
    const input = {
      clientMutationId: `create:${stamp}:1`,
      item: appointment("2026-09-10", "10:00", "11:00", {
        title: "  Consulta  ",
        notes: "Anotação privada",
      }),
      recurrence: {
        frequency: "WEEKLY" as const,
        interval: 1,
        weekdaysMask: 1 << 4,
        invalidDatePolicy: "SKIP" as const,
        termination: "COUNT" as const,
        untilLocalDate: null,
        occurrenceCount: 3,
      },
      alertOffsets: [60, 10_080],
    };

    const first = await caller.personalCalendar.createItem(input);
    const replay = await caller.personalCalendar.createItem({
      ...input,
      item: { ...input.item, title: "Payload repetido divergente" },
    });

    expect(first.replayed).toBe(false);
    expect(first.item).toMatchObject({
      clientMutationId: input.clientMutationId,
      version: 1,
      item: { title: "Consulta", notes: "Anotação privada" },
      recurrence: { frequency: "WEEKLY", occurrenceCount: 3 },
      alertOffsets: [10_080, 60],
    });
    expect(replay.replayed).toBe(true);
    expect(replay.item.id).toBe(first.item.id);
    expect(replay.item.item.title).toBe("Consulta");
    await expect(
      db
        .select({ ownerUserId: personalCalendarItems.ownerUserId })
        .from(personalCalendarItems)
        .where(
          eq(personalCalendarItems.clientMutationId, input.clientMutationId),
        ),
    ).resolves.toEqual([{ ownerUserId }]);
  });

  it("funciona para uma conta aprovada mesmo sem perfil profissional ou instituição", async () => {
    const caller = callerFor(standaloneUserId);
    const created = await caller.personalCalendar.createItem({
      clientMutationId: `standalone:${stamp}`,
      item: appointment("2026-09-10", "16:00", "17:00"),
      recurrence: noRecurrence,
      alertOffsets: noAlerts,
    });

    await expect(
      caller.personalCalendar.listWindow({
        fromDate: "2026-09-10",
        toDate: "2026-09-10",
      }),
    ).resolves.toMatchObject({
      sourceItemCount: 1,
      occurrences: [expect.objectContaining({ itemId: created.item.id })],
    });
  });

  it("rejeita séries semanticamente impossíveis antes de gravar qualquer linha", async () => {
    const caller = callerFor(ownerUserId);
    const mutationIds = [`invalid-birthday:${stamp}`, `invalid-until:${stamp}`];

    await expect(
      caller.personalCalendar.createItem({
        clientMutationId: mutationIds[0],
        item: {
          kind: "BIRTHDAY",
          title: "Aniversário",
          allDay: true,
          availability: "FREE",
          birthdayMonth: 9,
          birthdayDay: 10,
          timeZone: FORTALEZA,
        },
        recurrence: {
          frequency: "YEARLY",
          interval: 1,
          weekdaysMask: null,
          invalidDatePolicy: "SKIP",
          termination: "NEVER",
          untilLocalDate: null,
          occurrenceCount: null,
        },
        alertOffsets: noAlerts,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.personalCalendar.createItem({
        clientMutationId: mutationIds[1],
        item: appointment("2026-09-10", "09:00", "10:00"),
        recurrence: {
          frequency: "DAILY",
          interval: 1,
          weekdaysMask: null,
          invalidDatePolicy: "SKIP",
          termination: "UNTIL",
          untilLocalDate: "2026-09-09",
          occurrenceCount: null,
        },
        alertOffsets: noAlerts,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      db
        .select({ id: personalCalendarItems.id })
        .from(personalCalendarItems)
        .where(inArray(personalCalendarItems.clientMutationId, mutationIds)),
    ).resolves.toHaveLength(0);
  });

  it("falha fechado ao encontrar uma série persistida com combinação impossível", async () => {
    const [item] = await db
      .insert(personalCalendarItems)
      .values({
        ownerUserId,
        clientMutationId: `corrupted-series:${stamp}`,
        kind: "BIRTHDAY",
        title: "Estado inválido",
        birthdayMonth: 9,
        birthdayDay: 10,
        allDay: true,
        availability: "FREE",
        timeZone: FORTALEZA,
      })
      .$returningId();
    await db.insert(personalCalendarRecurrences).values({
      itemId: item.id,
      ownerUserId,
      frequency: "YEARLY",
      interval: 1,
      weekdaysMask: null,
      invalidDatePolicy: "SKIP",
      termination: "NEVER",
      untilLocalDate: null,
      occurrenceCount: null,
    });

    await expect(
      callerFor(ownerUserId).personalCalendar.getItem({ itemId: item.id }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "A Agenda pessoal contém dados inconsistentes.",
    });
  });

  it("falha fechado se o banco contiver avisos além do limite do contrato", async () => {
    const created = await callerFor(ownerUserId).personalCalendar.createItem({
      clientMutationId: `corrupted-alerts:${stamp}`,
      item: appointment("2026-09-10", "16:00", "17:00"),
      recurrence: noRecurrence,
      alertOffsets: noAlerts,
    });
    await db.insert(personalCalendarAlertRules).values(
      Array.from({ length: 9 }, (_, minutesBefore) => ({
        itemId: created.item.id,
        ownerUserId,
        minutesBefore,
      })),
    );

    await expect(
      callerFor(ownerUserId).personalCalendar.getItem({
        itemId: created.item.id,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("não ignora silenciosamente exceções de recorrência ainda não suportadas", async () => {
    const created = await callerFor(ownerUserId).personalCalendar.createItem({
      clientMutationId: `exception-series:${stamp}`,
      item: appointment("2026-09-10", "09:00", "10:00"),
      recurrence: {
        frequency: "DAILY",
        interval: 1,
        weekdaysMask: null,
        invalidDatePolicy: "SKIP",
        termination: "COUNT",
        untilLocalDate: null,
        occurrenceCount: 2,
      },
      alertOffsets: noAlerts,
    });
    await db.insert(personalCalendarOccurrenceExceptions).values({
      seriesItemId: created.item.id,
      ownerUserId,
      occurrenceKey: "2026-09-11T09:00:00",
      action: "CANCELLED",
      replacementItemId: null,
    });

    await expect(
      callerFor(ownerUserId).personalCalendar.listWindow({
        fromDate: "2026-09-10",
        toDate: "2026-09-12",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("isola get/update por conta, rejeita owner injetado e aplica CAS de versão", async () => {
    const owner = callerFor(ownerUserId);
    const other = callerFor(otherUserId);
    const created = await owner.personalCalendar.createItem({
      clientMutationId: `owner:${stamp}`,
      item: appointment("2026-09-15", "09:00", "10:00"),
      recurrence: noRecurrence,
      alertOffsets: noAlerts,
    });

    await expect(
      other.personalCalendar.getItem({ itemId: created.item.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      other.personalCalendar.updateItem({
        itemId: created.item.id,
        expectedVersion: 1,
        item: appointment("2026-09-15", "10:00", "11:00"),
        recurrence: noRecurrence,
        alertOffsets: noAlerts,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      owner.personalCalendar.createItem({
        clientMutationId: `strict:${stamp}`,
        item: appointment("2026-09-15", "09:00", "10:00"),
        recurrence: noRecurrence,
        alertOffsets: noAlerts,
        ownerUserId: otherUserId,
      } as never),
    ).rejects.toBeDefined();

    const updated = await owner.personalCalendar.updateItem({
      itemId: created.item.id,
      expectedVersion: 1,
      item: appointment("2026-09-15", "10:00", "11:00", {
        title: "Atualizado",
      }),
      recurrence: noRecurrence,
      alertOffsets: [30],
    });
    expect(updated).toMatchObject({
      id: created.item.id,
      version: 2,
      item: { title: "Atualizado" },
      alertOffsets: [30],
    });
    await expect(
      owner.personalCalendar.updateItem({
        itemId: created.item.id,
        expectedVersion: 1,
        item: appointment("2026-09-15", "11:00", "12:00"),
        recurrence: noRecurrence,
        alertOffsets: noAlerts,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("soft-delete é idempotente e a chave de criação nunca ressuscita o item", async () => {
    const caller = callerFor(ownerUserId);
    const input = {
      clientMutationId: `delete:${stamp}`,
      item: appointment("2026-09-16", "09:00", "10:00"),
      recurrence: noRecurrence,
      alertOffsets: noAlerts,
    };
    const created = await caller.personalCalendar.createItem(input);
    const occurrenceValues = {
      itemId: created.item.id,
      ownerUserId,
      occurrenceKey: `delete:${stamp}`,
      originalLocalDate: "2026-09-16",
      originalLocalTime: "09:00:00",
      startsAtUtc: new Date("2026-09-16T12:00:00.000Z"),
      endsAtUtc: new Date("2026-09-16T13:00:00.000Z"),
      sourceVersion: 1,
    };
    await db.insert(personalCalendarOccurrences).values(occurrenceValues);
    await expect(
      caller.personalCalendar.deleteItem({
        itemId: created.item.id,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ version: 2, deleted: true, replayed: false });
    await expect(
      db
        .select({ id: personalCalendarOccurrences.id })
        .from(personalCalendarOccurrences)
        .where(eq(personalCalendarOccurrences.itemId, created.item.id)),
    ).resolves.toHaveLength(0);

    await db
      .insert(personalCalendarOccurrences)
      .values({ ...occurrenceValues, sourceVersion: 2 });
    await expect(
      caller.personalCalendar.deleteItem({
        itemId: created.item.id,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ version: 2, deleted: true, replayed: true });
    await expect(
      db
        .select({ id: personalCalendarOccurrences.id })
        .from(personalCalendarOccurrences)
        .where(eq(personalCalendarOccurrences.itemId, created.item.id)),
    ).resolves.toHaveLength(0);
    await expect(
      caller.personalCalendar.getItem({ itemId: created.item.id }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const replay = await caller.personalCalendar.createItem(input);
    expect(replay).toMatchObject({
      replayed: true,
      item: { id: created.item.id, version: 2 },
    });
    expect(replay.item.deletedAt).not.toBeNull();
  });

  it("revalida sessionVersion sob lock antes de qualquer escrita", async () => {
    await db
      .update(users)
      .set({ sessionVersion: 2 })
      .where(eq(users.id, ownerUserId));
    await expect(
      callerFor(ownerUserId, 1).personalCalendar.createItem({
        clientMutationId: `revoked:${stamp}`,
        item: appointment("2026-09-17", "09:00", "10:00"),
        recurrence: noRecurrence,
        alertOffsets: noAlerts,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      db
        .select({ id: personalCalendarItems.id })
        .from(personalCalendarItems)
        .where(eq(personalCalendarItems.clientMutationId, `revoked:${stamp}`)),
    ).resolves.toHaveLength(0);
  });

  it("detecta compromisso e plantões próprios em dois hospitais e duas instituições", async () => {
    const caller = callerFor(ownerUserId);
    await expect(
      caller.personalCalendar.checkConflicts({
        item: {
          ...conflictAppointment("2026-09-10", "09:00", "11:00"),
          notes: "não deve trafegar na prévia",
        },
        recurrence: noRecurrence,
        window: { fromDate: "2026-09-10", toDate: "2026-09-10" },
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const existing = await caller.personalCalendar.createItem({
      clientMutationId: `conflict-existing:${stamp}`,
      item: appointment("2026-09-10", "10:30", "11:30", {
        title: "Outro compromisso",
      }),
      recurrence: noRecurrence,
      alertOffsets: noAlerts,
    });
    const check = await caller.personalCalendar.checkConflicts({
      item: conflictAppointment("2026-09-10", "09:00", "11:00"),
      recurrence: noRecurrence,
      window: { fromDate: "2026-09-10", toDate: "2026-09-10" },
    });
    expect(check.occurrences).toHaveLength(1);
    expect(check.occurrences[0].conflict.hasConflict).toBe(true);
    expect(check.occurrences[0].conflict.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "PERSONAL_ITEM",
          itemId: existing.item.id,
          title: "Outro compromisso",
        }),
        expect.objectContaining({
          kind: "SHIFT",
          institutionId: institutionAId,
          hospitalId: hospitalA1Id,
          sectorId: sectorA1Id,
          label: "Plantão próprio A1",
        }),
      ]),
    );

    const sibling = await caller.personalCalendar.checkConflicts({
      item: conflictAppointment("2026-09-11", "09:00", "10:00"),
      recurrence: noRecurrence,
      window: { fromDate: "2026-09-11", toDate: "2026-09-11" },
    });
    expect(sibling.occurrences[0].conflict.conflicts).toEqual([
      expect.objectContaining({
        kind: "SHIFT",
        hospitalId: hospitalA2Id,
        label: "Plantão próprio A2",
      }),
    ]);

    const otherTenant = await caller.personalCalendar.checkConflicts({
      item: conflictAppointment("2026-09-12", "09:00", "10:00"),
      recurrence: noRecurrence,
      window: { fromDate: "2026-09-12", toDate: "2026-09-12" },
    });
    expect(otherTenant.occurrences[0].conflict.conflicts).toEqual([
      expect.objectContaining({
        kind: "SHIFT",
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        label: "Plantão próprio B",
      }),
    ]);
  });

  it("falha fechado para topologia contaminada, outra conta e vínculo revogado", async () => {
    const caller = callerFor(ownerUserId);
    for (const date of ["2026-09-13", "2026-09-14"]) {
      const check = await caller.personalCalendar.checkConflicts({
        item: conflictAppointment(date, "09:00", "10:00"),
        recurrence: noRecurrence,
        window: { fromDate: date, toDate: date },
      });
      expect(check.occurrences[0].conflict).toMatchObject({
        hasConflict: false,
        total: 0,
      });
    }

    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.userId, ownerUserId),
          eq(professionalInstitutions.institutionId, institutionBId),
        ),
      );
    const revoked = await caller.personalCalendar.checkConflicts({
      item: conflictAppointment("2026-09-12", "09:00", "10:00"),
      recurrence: noRecurrence,
      window: { fromDate: "2026-09-12", toDate: "2026-09-12" },
    });
    expect(revoked.occurrences[0].conflict.hasConflict).toBe(false);

    const free = await caller.personalCalendar.checkConflicts({
      item: conflictAppointment("2026-09-10", "09:00", "11:00", {
        availability: "FREE",
      }),
      recurrence: noRecurrence,
      window: { fromDate: "2026-09-10", toDate: "2026-09-10" },
    });
    expect(free.occurrences[0].conflict.hasConflict).toBe(false);
  });

  it("marca conflito entre ocorrências sobrepostas da própria série", async () => {
    const check = await callerFor(ownerUserId).personalCalendar.checkConflicts({
      item: {
        ...conflictAppointment("2026-09-20", "09:00", "10:00"),
        endLocalDate: "2026-09-21",
      },
      recurrence: {
        frequency: "DAILY",
        interval: 1,
        weekdaysMask: null,
        invalidDatePolicy: "SKIP",
        termination: "COUNT",
        untilLocalDate: null,
        occurrenceCount: 2,
      },
      window: { fromDate: "2026-09-20", toDate: "2026-09-22" },
    });
    expect(check.occurrences).toHaveLength(2);
    expect(check.occurrences.every((row) => row.conflict.hasConflict)).toBe(
      true,
    );
    expect(
      check.occurrences.every((row) =>
        row.conflict.conflicts.some(
          (conflict) =>
            conflict.kind === "PERSONAL_ITEM" && conflict.itemId === 0,
        ),
      ),
    ).toBe(true);
  });

  it("não deixa itens pontuais históricos degradarem uma janela atual", async () => {
    await db.insert(personalCalendarItems).values(
      Array.from({ length: 1_001 }, (_, index) => ({
        ownerUserId,
        clientMutationId: `historical:${stamp}:${index}`,
        kind: "REMINDER" as const,
        title: `Histórico ${index}`,
        startLocalDate: "2020-01-01",
        allDay: true,
        availability: "FREE" as const,
        timeZone: FORTALEZA,
      })),
    );
    const current = await callerFor(ownerUserId).personalCalendar.createItem({
      clientMutationId: `current:${stamp}`,
      item: appointment("2026-09-10", "16:00", "17:00"),
      recurrence: noRecurrence,
      alertOffsets: noAlerts,
    });

    const window = await callerFor(ownerUserId).personalCalendar.listWindow({
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
    });
    expect(window.sourceItemCount).toBe(1);
    expect(window.occurrences).toEqual([
      expect.objectContaining({ itemId: current.item.id }),
    ]);
  });

  it("recusa a janela inteira quando a expansão excede o limite global", async () => {
    const sourceRows = Array.from({ length: 28 }, (_, index) => ({
      ownerUserId,
      clientMutationId: `window-limit:${stamp}:${index}`,
      kind: "APPOINTMENT" as const,
      title: `Recorrente ${index}`,
      startLocalDate: "2026-01-01",
      startLocalTime: "09:00:00",
      endLocalDate: "2026-01-01",
      endLocalTime: "10:00:00",
      allDay: false,
      availability: "BUSY" as const,
      timeZone: FORTALEZA,
    }));
    const inserted = await db
      .insert(personalCalendarItems)
      .values(sourceRows)
      .$returningId();
    await db.insert(personalCalendarRecurrences).values(
      inserted.map(({ id }) => ({
        itemId: id,
        ownerUserId,
        frequency: "DAILY" as const,
        interval: 1,
        weekdaysMask: null,
        invalidDatePolicy: "SKIP" as const,
        termination: "NEVER" as const,
        untilLocalDate: null,
        occurrenceCount: null,
      })),
    );

    await expect(
      callerFor(ownerUserId).personalCalendar.listWindow({
        fromDate: "2026-01-01",
        toDate: "2026-12-31",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("interrompe fail-closed uma análise de conflitos combinatoriamente excessiva", async () => {
    await db.insert(personalCalendarItems).values(
      Array.from({ length: 450 }, (_, index) => ({
        ownerUserId,
        clientMutationId: `conflict-limit:${stamp}:${index}`,
        kind: "APPOINTMENT" as const,
        title: `Simultâneo ${index}`,
        startLocalDate: "2026-09-10",
        startLocalTime: "09:00:00",
        endLocalDate: "2026-09-10",
        endLocalTime: "10:00:00",
        allDay: false,
        availability: "BUSY" as const,
        timeZone: FORTALEZA,
      })),
    );

    await expect(
      callerFor(ownerUserId).personalCalendar.listWindow({
        fromDate: "2026-09-10",
        toDate: "2026-09-10",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("listWindow devolve apenas dados privados do owner e anota conflitos", async () => {
    const owner = callerFor(ownerUserId);
    const mine = await owner.personalCalendar.createItem({
      clientMutationId: `list-owner:${stamp}`,
      item: appointment("2026-09-10", "09:00", "10:00", {
        title: "Meu compromisso",
        notes: "Anotação exibida somente no detalhe",
      }),
      recurrence: noRecurrence,
      alertOffsets: [60],
    });
    await callerFor(otherUserId).personalCalendar.createItem({
      clientMutationId: `list-other:${stamp}`,
      item: appointment("2026-09-10", "09:00", "10:00", {
        title: "Segredo alheio",
      }),
      recurrence: noRecurrence,
      alertOffsets: noAlerts,
    });

    const window = await owner.personalCalendar.listWindow({
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
    });
    expect(window.sourceItemCount).toBe(1);
    expect(window.occurrences).toHaveLength(1);
    expect(window.occurrences[0]).toMatchObject({
      itemId: mine.item.id,
      title: "Meu compromisso",
      alertOffsets: [60],
      conflict: { hasConflict: true },
    });
    expect(JSON.stringify(window)).not.toContain("Segredo alheio");
    expect(JSON.stringify(window)).not.toContain(
      "Anotação exibida somente no detalhe",
    );
  });
});
