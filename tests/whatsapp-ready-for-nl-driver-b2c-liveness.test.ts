import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  medicalSpecialties,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { addDaysToKey, dayKeyBrt } from "../server/local-time";
import * as swapCreate from "../server/swap-offer-create";
import { processWhatsAppReadyForNlInbound } from "../server/integrations/whatsapp/ready-for-nl-consumer";
import {
  listWhatsAppReadyForNlEligibleIds,
  runWhatsAppNlDriverTick,
} from "../server/integrations/whatsapp/ready-for-nl-driver";
import {
  WHATSAPP_NL_DRIVER_PARK_PREFIX,
  WHATSAPP_NL_DRIVER_WAIT_PREFIX,
  whatsAppNlDriverWaitDelayMs,
} from "../server/integrations/whatsapp/ready-for-nl-driver-occupancy";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Person = { userId: number; professionalId: number; name: string };

describe("WhatsApp B2-D — WAIT liveness e A→B com B2-C real", () => {
  let db: Db;
  const stamp = Date.now();
  const today = dayKeyBrt(new Date());
  const tomorrow = addDaysToKey(today, 1);
  const dayAfter = addDaysToKey(today, 2);
  const at = (date: string, time: string) => new Date(`${date}T${time}-03:00`);

  let tenantA: number;
  let hospitalA: number;
  let recoveryA: number;
  let surgeryA: number;
  let actor: Person;
  let colleague: Person;

  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const shiftIds: number[] = [];
  const inboundIds: number[] = [];
  const hospitalIds: number[] = [];
  const institutionIds: number[] = [];
  const sectorIds: number[] = [];

  const createSwapSpy = vi.spyOn(swapCreate, "createSwapOffer");

  async function makeTenant(label: string) {
    const suffix = `${stamp}${label}`.slice(-14).padStart(14, "0");
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `B2D Live ${stamp}${label}`,
        cnpj: suffix,
        legalName: `B2D Live ${stamp}${label}`,
        tradeName: `B2DL${label}`,
        isActive: true,
      })
      .$returningId();
    institutionIds.push(institution.id);
    const [hospital] = await db
      .insert(hospitals)
      .values({
        institutionId: institution.id,
        name: `B2D Hospital ${stamp}${label}`,
      })
      .$returningId();
    hospitalIds.push(hospital.id);
    return { institutionId: institution.id, hospitalId: hospital.id };
  }

  async function makeSector(
    institutionId: number,
    hospitalId: number,
    name: string,
  ) {
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorIds.push(sector.id);
    return sector.id;
  }

  async function makePerson(
    label: string,
    name: string,
    medicalSpecialtyId: number,
  ): Promise<Person> {
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `b2dlive-${label}-${stamp}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name,
        role: "Médico",
        specialty: "Anestesiologia",
        userRole: "USER",
        medicalSpecialtyId,
      })
      .$returningId();
    professionalIds.push(professional.id);
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: user.id,
      institutionId: tenantA,
      roleInInstitution: "USER",
      active: true,
    });
    return { userId: user.id, professionalId: professional.id, name };
  }

  async function makeShift(input: {
    owner: Person;
    sectorId: number;
    date: string;
    start: string;
    end: string;
    label: string;
  }) {
    const startAt = at(input.date, input.start);
    const endAt = at(input.date, input.end);
    if (endAt <= startAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: tenantA,
        hospitalId: hospitalA,
        sectorId: input.sectorId,
        label: input.label,
        specialty: "Anestesiologia",
        startAt,
        endAt,
        status: "OCUPADO",
      })
      .$returningId();
    shiftIds.push(shift.id);
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shift.id,
      institutionId: tenantA,
      hospitalId: hospitalA,
      sectorId: input.sectorId,
      professionalId: input.owner.professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    return shift.id;
  }

  async function insertInbound(input: {
    ownerId: number;
    suffix: string;
    text: string;
    receivedAt?: Date;
  }): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMb2dlv${stamp}${input.suffix}`.slice(0, 64),
        userId: input.ownerId,
        contentKind: "TEXT",
        forwarded: false,
        processingStatus: "READY_FOR_NL",
        operationalText: input.text,
        payloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        receivedAt: input.receivedAt ?? new Date(),
        processedAt: new Date(),
      })
      .$returningId();
    inboundIds.push(row.id);
    return row.id;
  }

  async function loadInbound(id: number) {
    const [row] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.id, id))
      .limit(1);
    return row;
  }

  async function loadPendingBySource(sourceId: number) {
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.sourceInboundMessageId, sourceId))
      .limit(1);
    return row;
  }

  async function specialtyId(code: string, name: string, sortOrder: number) {
    await db
      .insert(medicalSpecialties)
      .values({
        code,
        name,
        sourceVersion: "CFM_2380_2024",
        active: true,
        sortOrder,
      })
      .onDuplicateKeyUpdate({ set: { active: true } });
    const [row] = await db
      .select({ id: medicalSpecialties.id })
      .from(medicalSpecialties)
      .where(eq(medicalSpecialties.code, code));
    return row.id;
  }

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    const anestesiaId = await specialtyId(
      "ANESTESIOLOGIA",
      "Anestesiologia",
      3,
    );
    const tenant = await makeTenant("A");
    tenantA = tenant.institutionId;
    hospitalA = tenant.hospitalId;
    recoveryA = await makeSector(tenantA, hospitalA, "Sala de Recuperação");
    surgeryA = await makeSector(tenantA, hospitalA, "Centro Cirúrgico");
    actor = await makePerson("actor", "Ator Delta", anestesiaId);
    colleague = await makePerson("col", "Colg Silva", anestesiaId);
    await makeShift({
      owner: actor,
      sectorId: recoveryA,
      date: tomorrow,
      start: "19:00:00",
      end: "07:00:00",
      label: "Noite",
    });
    await makeShift({
      owner: actor,
      sectorId: surgeryA,
      date: tomorrow,
      start: "07:00:00",
      end: "13:00:00",
      label: "Manhã",
    });
    await makeShift({
      owner: colleague,
      sectorId: recoveryA,
      date: dayAfter,
      start: "19:00:00",
      end: "07:00:00",
      label: "Noite",
    });
  });

  afterEach(async () => {
    expect(createSwapSpy).not.toHaveBeenCalled();
    if (inboundIds.length) {
      await db
        .delete(whatsappPendingIntents)
        .where(
          inArray(whatsappPendingIntents.sourceInboundMessageId, inboundIds),
        );
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
      inboundIds.length = 0;
    }
  });

  afterAll(async () => {
    createSwapSpy.mockRestore();
    if (!db) return;
    if (inboundIds.length) {
      await db
        .delete(whatsappPendingIntents)
        .where(
          inArray(whatsappPendingIntents.sourceInboundMessageId, inboundIds),
        );
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
    }
    if (shiftIds.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    if (sectorIds.length) {
      await db.delete(sectors).where(inArray(sectors.id, sectorIds));
    }
    if (professionalIds.length) {
      await db
        .delete(professionalInstitutions)
        .where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db
        .delete(professionals)
        .where(inArray(professionals.id, professionalIds));
    }
    if (hospitalIds.length) {
      await db.delete(hospitals).where(inArray(hospitals.id, hospitalIds));
    }
    if (institutionIds.length) {
      await db.delete(institutions).where(inArray(institutions.id, institutionIds));
    }
    if (userIds.length) {
      await db
        .delete(whatsappPendingIntents)
        .where(inArray(whatsappPendingIntents.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  async function waitThenProgress(input: {
    textA: string;
    suffixA: string;
    expectedA: "CLARIFICATION" | "CONFIRMATION";
    suffixB: string;
  }) {
    const inboundA = await insertInbound({
      ownerId: actor.userId,
      suffix: input.suffixA,
      text: input.textA,
      receivedAt: new Date(Date.now() - 4_000),
    });
    const inboundB = await insertInbound({
      ownerId: actor.userId,
      suffix: input.suffixB,
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
      receivedAt: new Date(Date.now() - 2_000),
    });
    const now = new Date();
    const first = await runWhatsAppNlDriverTick({ now, batchSize: 20 });
    const itemA = first.items.find(
      (item) => item.sourceInboundMessageId === inboundA,
    );
    const itemB = first.items.find(
      (item) => item.sourceInboundMessageId === inboundB,
    );
    expect(itemA).toMatchObject({
      action: "complete",
      b2cKind: "ADVANCED",
      b2cCode: input.expectedA,
    });
    expect(itemB).toMatchObject({
      action: "wait",
      b2cKind: "BLOCKED",
      b2cCode: "ALREADY_OPEN",
    });
    expect((await loadInbound(inboundB))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    );
    const pendingA = await loadPendingBySource(inboundA);
    expect(pendingA?.status).toBe("OPEN");
    expect(pendingA?.stage).toBe(input.expectedA);

    const hot = await runWhatsAppNlDriverTick({
      now: new Date(now.getTime() + 5_000),
      batchSize: 5,
    });
    expect(
      hot.items.some((item) => item.sourceInboundMessageId === inboundB),
    ).toBe(false);

    await db
      .update(whatsappPendingIntents)
      .set({ status: "CANCELLED" })
      .where(eq(whatsappPendingIntents.id, pendingA!.id));

    const due = new Date(now.getTime() + whatsAppNlDriverWaitDelayMs(1) + 2_000);
    expect(
      await listWhatsAppReadyForNlEligibleIds({ now: due, batchSize: 20 }),
    ).toContain(inboundB);

    const recovered = await runWhatsAppNlDriverTick({ now: due, batchSize: 5 });
    expect(
      recovered.items.find((item) => item.sourceInboundMessageId === inboundB),
    ).toMatchObject({
      action: "complete",
      b2cKind: "ADVANCED",
    });
    const pendingB = await loadPendingBySource(inboundB);
    expect(pendingB?.status).toBe("OPEN");
    expect(["CLARIFICATION", "CONFIRMATION"]).toContain(pendingB?.stage);
    expect((await loadInbound(inboundB))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(inboundB))?.errorCode).toBeNull();
  }

  it("W1: OPEN/CLARIFICATION → B WAIT → slot livre → B progride", async () => {
    await waitThenProgress({
      textA: "passar meu plantão de amanhã para o Colg Silva",
      suffixA: "w1a",
      expectedA: "CLARIFICATION",
      suffixB: "w1b",
    });
  }, 30_000);

  it("W2: OPEN/CONFIRMATION → B WAIT → slot livre → B progride", async () => {
    await waitThenProgress({
      textA: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
      suffixA: "w2a",
      expectedA: "CONFIRMATION",
      suffixB: "w2b",
    });
  }, 30_000);

  it("W3: PARSE transitório legítimo → B WAIT → A terminaliza → B progride", async () => {
    const inboundA = await insertInbound({
      ownerId: actor.userId,
      suffix: "w3a",
      text: "placeholder parse aberto",
      receivedAt: new Date(Date.now() - 4_000),
    });
    await db
      .update(whatsappInboundMessages)
      .set({
        operationalText: null,
        payloadClearedAt: new Date(),
      })
      .where(eq(whatsappInboundMessages.id, inboundA));
    const [pending] = await db
      .insert(whatsappPendingIntents)
      .values({
        userId: actor.userId,
        sourceInboundMessageId: inboundA,
        status: "OPEN",
        stage: "PARSE",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      })
      .$returningId();
    const inboundB = await insertInbound({
      ownerId: actor.userId,
      suffix: "w3b",
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
      receivedAt: new Date(Date.now() - 2_000),
    });
    const now = new Date();
    const first = await runWhatsAppNlDriverTick({ now, batchSize: 5 });
    expect(
      first.items.find((item) => item.sourceInboundMessageId === inboundB),
    ).toMatchObject({
      action: "wait",
      b2cCode: "ALREADY_OPEN",
    });
    await db
      .update(whatsappPendingIntents)
      .set({ status: "CANCELLED" })
      .where(eq(whatsappPendingIntents.id, pending.id));
    const due = new Date(now.getTime() + whatsAppNlDriverWaitDelayMs(1) + 2_000);
    const recovered = await runWhatsAppNlDriverTick({ now: due, batchSize: 5 });
    expect(
      recovered.items.find((item) => item.sourceInboundMessageId === inboundB),
    ).toMatchObject({ action: "complete" });
    const pendingB = await loadPendingBySource(inboundB);
    expect(pendingB?.status).toBe("OPEN");
    expect(pendingB?.sourceInboundMessageId).toBe(inboundB);
  }, 30_000);

  it("R1–R3: garbage PARK + slot livre; B válido progride; replay A não recria OPEN", async () => {
    const garbage = "asdfgh qwerty zxcvbn";
    const sourceA = await insertInbound({
      ownerId: actor.userId,
      suffix: "r1a",
      text: garbage,
      receivedAt: new Date(Date.now() - 3_000),
    });
    const first = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(
      first.items.find((item) => item.sourceInboundMessageId === sourceA),
    ).toMatchObject({
      action: "park",
      b2cCode: "NEEDS_REFORMULATION",
    });
    const pendingA = await loadPendingBySource(sourceA);
    expect(pendingA?.status).toBe("CANCELLED");
    expect((await loadInbound(sourceA))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:NEEDS_REFORMULATION`,
    );
    expect((await loadInbound(sourceA))?.operationalText).toBe(garbage);
    expect((await loadInbound(sourceA))?.payloadClearedAt).toBeNull();

    const sourceB = await insertInbound({
      ownerId: actor.userId,
      suffix: "r2b",
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
    });
    const second = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(
      second.items.find((item) => item.sourceInboundMessageId === sourceB),
    ).toMatchObject({
      action: "complete",
      b2cKind: "ADVANCED",
    });
    const pendingB = await loadPendingBySource(sourceB);
    expect(pendingB?.status).toBe("OPEN");
    expect(pendingB?.stage).toBe("CONFIRMATION");
    expect(pendingB?.id).not.toBe(pendingA?.id);

    const replay = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceA,
    });
    expect(replay).toMatchObject({
      ok: false,
      kind: "BLOCKED",
      code: "PENDING_TERMINAL",
    });
    const pendingsA = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.sourceInboundMessageId, sourceA));
    expect(pendingsA).toHaveLength(1);
    expect(pendingsA[0]?.status).toBe("CANCELLED");
    const driverReplay = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(
      driverReplay.items.some((item) => item.sourceInboundMessageId === sourceA),
    ).toBe(false);
  }, 30_000);
});
