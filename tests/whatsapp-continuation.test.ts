import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
import { processWhatsAppReadyForNlInbound } from "../server/integrations/whatsapp/ready-for-nl-consumer";
import { createWhatsAppPendingIntent } from "../server/integrations/whatsapp/pending-intent-store";
import {
  attachWhatsAppContinuation,
  continuationAttachTestHooks,
} from "../server/integrations/whatsapp/continuation-attach";
import {
  applyWhatsAppContinuation,
  continuationApplyTestHooks,
  type WhatsAppContinuationApplyAction,
} from "../server/integrations/whatsapp/continuation-apply";
import {
  continuationConsumerTestHooks,
} from "../server/integrations/whatsapp/continuation-consumer";
import { interpretWhatsAppContinuation } from "../server/integrations/whatsapp/continuation-interpreter";
import {
  draftFromStoredParsedIntent,
  parseStoredClarification,
  parseStoredParsedIntent,
  serializeParsedSwapIntentV1,
} from "../server/integrations/whatsapp/pending-intent-payloads";
import { clearedOperationalPayload } from "../server/integrations/whatsapp/operational-payload";
import { resolveCanonicalOperationalActorForUser } from "../server/_core/canonical-operational-actor";
import { resolveSwapIntent } from "../server/natural-language/swap-intent-resolver";
import * as swapCreate from "../server/swap-offer-create";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Person = { userId: number; professionalId: number; name: string };

describe("WhatsApp continuation T1–T18", () => {
  let db: Db;
  const stamp = Date.now();
  const today = dayKeyBrt(new Date());
  const tomorrow = addDaysToKey(today, 1);
  const at = (date: string, time: string) => new Date(`${date}T${time}-03:00`);

  let tenantA: number;
  let hospitalA: number;
  let recoveryA: number;
  let surgeryA: number;
  let actor: Person;
  let colleague: Person;
  let stranger: Person;

  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const shiftIds: number[] = [];
  const inboundIds: number[] = [];
  const hospitalIds: number[] = [];
  const institutionIds: number[] = [];
  const sectorIds: number[] = [];
  let seq = 0;

  const createSwapSpy = vi.spyOn(swapCreate, "createSwapOffer");

  async function makeTenant(label: string) {
    const suffix = `${stamp}${label}`.slice(-14).padStart(14, "0");
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Cont Tenant ${stamp}${label}`,
        cnpj: suffix,
        legalName: `Cont Tenant ${stamp}${label}`,
        tradeName: `CT${label}`,
        isActive: true,
      })
      .$returningId();
    institutionIds.push(institution.id);
    const [hospital] = await db
      .insert(hospitals)
      .values({
        institutionId: institution.id,
        name: `Cont Hospital ${stamp}${label}`,
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
        email: `cont-${label}-${stamp}@example.test`,
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
    text: string;
  }): Promise<number> {
    seq += 1;
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMcnt${stamp}${seq}`.slice(0, 64),
        userId: input.ownerId,
        contentKind: "TEXT",
        forwarded: false,
        processingStatus: "READY_FOR_NL",
        operationalText: input.text,
        payloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        receivedAt: new Date(),
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

  async function openClarification() {
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã para o Colg Silva",
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result).toMatchObject({ ok: true, stage: "CLARIFICATION" });
    const pending = await loadPendingBySource(sourceId);
    expect(pending?.stage).toBe("CLARIFICATION");
    return { sourceId, pending: pending! };
  }

  async function openConfirmation() {
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result).toMatchObject({ ok: true, stage: "CONFIRMATION" });
    const pending = await loadPendingBySource(sourceId);
    expect(pending?.stage).toBe("CONFIRMATION");
    return { sourceId, pending: pending! };
  }

  async function clearInboundPayload(id: number) {
    await db
      .update(whatsappInboundMessages)
      .set(clearedOperationalPayload())
      .where(eq(whatsappInboundMessages.id, id));
  }

  async function loadOpenForUser(userId: number) {
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(
        and(
          eq(whatsappPendingIntents.userId, userId),
          eq(whatsappPendingIntents.status, "OPEN"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function openSectorClarification() {
    const recoveryB = await makeSector(tenantA, hospitalA, "Setor Recuperação");
    await makeShift({
      owner: actor,
      sectorId: recoveryA,
      date: tomorrow,
      start: "13:00:00",
      end: "19:00:00",
      label: "Tarde",
    });
    await makeShift({
      owner: actor,
      sectorId: recoveryB,
      date: tomorrow,
      start: "07:00:00",
      end: "13:00:00",
      label: "Manhã",
    });
    await makeShift({
      owner: actor,
      sectorId: recoveryB,
      date: tomorrow,
      start: "13:00:00",
      end: "19:00:00",
      label: "Tarde",
    });
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã na SR para o Colg Silva",
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result).toMatchObject({ ok: true, stage: "CLARIFICATION" });
    const pending = await loadPendingBySource(sourceId);
    expect(pending?.stage).toBe("CLARIFICATION");
    const clarification = parseStoredClarification(pending!.clarificationPayload);
    expect(clarification.ok).toBe(true);
    if (!clarification.ok || clarification.value.code !== "AMBIGUOUS_SECTOR") {
      throw new Error("expected sector clarification");
    }
    expect(clarification.value.candidates.length).toBe(2);
    return { sourceId, pending: pending! };
  }

  async function sectorChoiceClarificationAction(
    pending: NonNullable<Awaited<ReturnType<typeof loadPendingBySource>>>,
    text: string,
  ): Promise<Extract<WhatsAppContinuationApplyAction, { type: "CHOICE_CLARIFICATION" }>> {
    const clarification = parseStoredClarification(pending.clarificationPayload);
    expect(clarification.ok).toBe(true);
    if (!clarification.ok) throw new Error("expected stored clarification");
    const interpretation = interpretWhatsAppContinuation({
      text,
      stage: "CLARIFICATION",
      clarification: clarification.value,
    });
    expect(interpretation.category).toBe("CHOICE");
    if (interpretation.category !== "CHOICE") {
      throw new Error("expected CHOICE");
    }
    expect(interpretation.choice.kind).toBe("SECTOR");
    const storedParsed = parseStoredParsedIntent(pending.parsedPayload);
    expect(storedParsed.ok).toBe(true);
    if (!storedParsed.ok) throw new Error("expected stored parsed intent");
    let draft = draftFromStoredParsedIntent(storedParsed.value);
    if (interpretation.choice.kind === "SECTOR") {
      draft = {
        ...draft,
        ownShift: { ...draft.ownShift, sectorText: interpretation.choice.label },
      };
    }
    const actorResolved = await resolveCanonicalOperationalActorForUser({
      userId: pending.userId,
    });
    expect(actorResolved.ok).toBe(true);
    if (!actorResolved.ok) throw new Error("expected canonical actor");
    const resolved = await resolveSwapIntent(draft, actorResolved.actor);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected still-clarification choice");
    expect(resolved.code).toBe("AMBIGUOUS_OWN_SHIFT");
    const parsedV1 = serializeParsedSwapIntentV1(draft);
    expect(parsedV1.ok).toBe(true);
    if (!parsedV1.ok) throw new Error("expected serialized parsed intent");
    const candidates = (resolved.shiftCandidates ?? []).map((item) => ({
      shiftInstanceId: item.shiftInstanceId,
      label: item.label,
      dayKey: item.dayKey,
      timeRange: item.timeRange,
      sectorName: item.sectorName,
      institutionName: item.institutionName,
    }));
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    return {
      type: "CHOICE_CLARIFICATION",
      parsed: parsedV1.value,
      clarification: {
        version: 1,
        code: "AMBIGUOUS_OWN_SHIFT",
        candidates,
      },
    };
  }

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (url && !/127\.0\.0\.1|localhost/.test(url)) {
      throw new Error("LOCAL_TEST_DB_ONLY");
    }
    if (url && /\/escalas([/?]|$)/.test(url) && !url.includes("escalas_test")) {
      throw new Error("LOCAL_TEST_DB_ONLY");
    }
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    await db
      .insert(medicalSpecialties)
      .values({
        code: "ANESTESIOLOGIA",
        name: "Anestesiologia",
        sourceVersion: "CFM_2380_2024",
        active: true,
        sortOrder: 3,
      })
      .onDuplicateKeyUpdate({ set: { active: true } });
    const [specialty] = await db
      .select({ id: medicalSpecialties.id })
      .from(medicalSpecialties)
      .where(eq(medicalSpecialties.code, "ANESTESIOLOGIA"));
    const tenant = await makeTenant("A");
    tenantA = tenant.institutionId;
    hospitalA = tenant.hospitalId;
    recoveryA = await makeSector(tenantA, hospitalA, "Sala de Recuperação");
    surgeryA = await makeSector(tenantA, hospitalA, "Centro Cirúrgico");
    actor = await makePerson("actor", "Ator Cont", specialty.id);
    colleague = await makePerson("col", "Colg Silva", specialty.id);
    stranger = await makePerson("str", "Stranger Cont", specialty.id);
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
      date: addDaysToKey(today, 2),
      start: "19:00:00",
      end: "07:00:00",
      label: "Noite",
    });
  });

  afterEach(async () => {
    expect(createSwapSpy).not.toHaveBeenCalled();
    continuationAttachTestHooks.throwDuringAttach = undefined;
    continuationApplyTestHooks.afterPendingMutationBeforeCommit = undefined;
    continuationConsumerTestHooks.afterAttachBeforeInterpret = undefined;
    continuationConsumerTestHooks.duringInterpret = undefined;
    continuationConsumerTestHooks.afterCommitBeforeCleanup = undefined;
    if (userIds.length) {
      await db
        .delete(whatsappPendingIntents)
        .where(inArray(whatsappPendingIntents.userId, userIds));
    }
  });

  afterAll(async () => {
    createSwapSpy.mockRestore();
    if (!db) return;
    if (userIds.length) {
      await db
        .delete(whatsappPendingIntents)
        .where(inArray(whatsappPendingIntents.userId, userIds));
    }
    if (inboundIds.length) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
    }
    if (shiftIds.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db
        .delete(shiftInstances)
        .where(inArray(shiftInstances.id, shiftIds));
    }
    if (professionalIds.length) {
      await db
        .delete(professionalInstitutions)
        .where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db
        .delete(professionals)
        .where(inArray(professionals.id, professionalIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (sectorIds.length) {
      await db.delete(sectors).where(inArray(sectors.id, sectorIds));
    }
    if (hospitalIds.length) {
      await db.delete(hospitals).where(inArray(hospitals.id, hospitalIds));
    }
    if (institutionIds.length) {
      await db.delete(institutions).where(inArray(institutions.id, institutionIds));
    }
  });

  it("T1 OPEN/PARSE segundo inbound → ALREADY_OPEN sem attach", async () => {
    const firstId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
    });
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: firstId,
    });
    expect(created).toMatchObject({ ok: true, outcome: "created" });
    const secondText = "2";
    const secondId = await insertInbound({
      ownerId: actor.userId,
      text: secondText,
    });
    const second = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: secondId,
    });
    expect(second).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "ALREADY_OPEN",
    });
    const child = await loadInbound(secondId);
    expect(child?.continuationPendingId).toBeNull();
    expect(child?.continuationOutcome).toBeNull();
    expect(child?.operationalText).toBe(secondText);
  });

  it("T2–T5 attach + CHOICE posição/label; número não é ID interno", async () => {
    const { pending } = await openClarification();
    const clarification = parseStoredClarification(pending.clarificationPayload);
    expect(clarification.ok).toBe(true);
    if (!clarification.ok || clarification.value.code !== "AMBIGUOUS_OWN_SHIFT") {
      throw new Error("expected own-shift clarification");
    }
    const internalId = clarification.value.candidates[0]!.shiftInstanceId;

    const missId = await insertInbound({
      ownerId: actor.userId,
      text: String(internalId > 10 ? internalId : 12345),
    });
    const miss = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: missId,
    });
    expect(miss.ok).toBe(true);
    const missRow = await loadInbound(missId);
    expect(missRow?.continuationPendingId).toBe(pending.id);
    expect(missRow?.continuationOutcome).toBe("NOOP");
    const still = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(still?.stage).toBe("CLARIFICATION");
    expect(still?.status).toBe("OPEN");

    const posId = await insertInbound({
      ownerId: actor.userId,
      text: "1",
    });
    const chosen = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: posId,
    });
    expect(chosen).toMatchObject({ ok: true, stage: "CONFIRMATION" });
    const child = await loadInbound(posId);
    expect(child?.continuationPendingId).toBe(pending.id);
    expect(child?.continuationOutcome).toBe("APPLIED");
    expect(child?.operationalText).toBeNull();
    const advanced = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(advanced?.stage).toBe("CONFIRMATION");
    expect(advanced?.sourceInboundMessageId).toBe(pending.sourceInboundMessageId);
  });

  it("T5 CHOICE por label normalizado do candidate set persistido", async () => {
    const { pending } = await openClarification();
    const clarification = parseStoredClarification(pending.clarificationPayload);
    expect(clarification.ok).toBe(true);
    if (!clarification.ok || clarification.value.code !== "AMBIGUOUS_OWN_SHIFT") {
      throw new Error("expected own-shift clarification");
    }
    const firstLabel = clarification.value.candidates[0]!.label;
    const choiceId = await insertInbound({
      ownerId: actor.userId,
      text: firstLabel,
    });
    const chosen = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: choiceId,
    });
    expect(chosen).toMatchObject({ ok: true, stage: "CONFIRMATION" });
    expect((await loadInbound(choiceId))?.continuationOutcome).toBe("APPLIED");
  });

  it("T8 FRESH_INTENT KEEP_CURRENT_PENDING NOOP", async () => {
    const { pending } = await openConfirmation();
    const childId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result.ok).toBe(true);
    const child = await loadInbound(childId);
    expect(child?.continuationOutcome).toBe("NOOP");
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("OPEN");
    expect(latest?.stage).toBe("CONFIRMATION");
    expect(latest?.sourceInboundMessageId).toBe(pending.sourceInboundMessageId);
    expect(latest?.confirmationDisposition).toBeNull();
  });

  it("T9 CANCEL clarification → CANCELLED APPLIED sem TTL slide", async () => {
    const { pending } = await openClarification();
    const before = pending.expiresAt.getTime();
    const childId = await insertInbound({ ownerId: actor.userId, text: "cancela" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result.ok).toBe(true);
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("CANCELLED");
    expect(latest?.expiresAt.getTime()).toBe(before);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
  });

  it("T10 AFFIRM grava confirmation_disposition e permanece OPEN/CONFIRMATION", async () => {
    const { pending } = await openConfirmation();
    await db
      .update(whatsappPendingIntents)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(whatsappPendingIntents.id, pending.id));
    const before = (await loadPendingBySource(pending.sourceInboundMessageId))!
      .expiresAt.getTime();
    const childId = await insertInbound({ ownerId: actor.userId, text: "sim" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result).toMatchObject({ ok: true, stage: "CONFIRMATION" });
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("OPEN");
    expect(latest?.stage).toBe("CONFIRMATION");
    expect(latest?.confirmationDisposition).toBe("AFFIRMED");
    expect(latest?.expiresAt.getTime()).toBeGreaterThan(before + 60_000);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
  });

  it("T11 DENY e CANCEL em CONFIRMATION → CANCELLED", async () => {
    const first = await openConfirmation();
    const denyId = await insertInbound({ ownerId: actor.userId, text: "nao" });
    await processWhatsAppReadyForNlInbound({ sourceInboundMessageId: denyId });
    expect(
      (await loadPendingBySource(first.pending.sourceInboundMessageId))?.status,
    ).toBe("CANCELLED");

    const second = await openConfirmation();
    const cancelId = await insertInbound({
      ownerId: actor.userId,
      text: "cancela",
    });
    await processWhatsAppReadyForNlInbound({ sourceInboundMessageId: cancelId });
    expect(
      (await loadPendingBySource(second.pending.sourceInboundMessageId))?.status,
    ).toBe("CANCELLED");
  });

  it("T13 expiry before attach libera o child para fundar nova conversa", async () => {
    const { pending } = await openClarification();
    await db
      .update(whatsappPendingIntents)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(whatsappPendingIntents.id, pending.id));
    const childId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result.ok).toBe(true);
    const old = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(old?.status).toBe("EXPIRED");
    const founded = await loadPendingBySource(childId);
    expect(founded?.status).toBe("OPEN");
    expect(founded?.sourceInboundMessageId).toBe(childId);
    expect((await loadInbound(childId))?.continuationPendingId).toBeNull();
  });

  it("T14 expiry after attach before apply reconcilia NOOP e não ressuscita", async () => {
    const { pending } = await openClarification();
    continuationConsumerTestHooks.afterAttachBeforeInterpret = async () => {
      await db
        .update(whatsappPendingIntents)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(whatsappPendingIntents.id, pending.id));
    };
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result.ok).toBe(true);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("NOOP");
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("EXPIRED");
  });

  it("T15–T17 TTL só em CHOICE/AFFIRM novo; replay não reaplica nem desliza", async () => {
    const { pending } = await openClarification();
    await db
      .update(whatsappPendingIntents)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(whatsappPendingIntents.id, pending.id));
    const before = (await loadPendingBySource(pending.sourceInboundMessageId))!
      .expiresAt.getTime();
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const first = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(first.ok).toBe(true);
    const afterApply = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(afterApply?.expiresAt.getTime()).toBeGreaterThan(before + 60_000);
    const slid = afterApply!.expiresAt.getTime();
    const replay = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(replay).toMatchObject({ ok: true, kind: "REPLAY" });
    const afterReplay = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(afterReplay?.expiresAt.getTime()).toBe(slid);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
  });

  it("T7/T18 ownership e attach para outro pending são fail-closed", async () => {
    const { pending } = await openClarification();
    const foreignId = await insertInbound({
      ownerId: stranger.userId,
      text: "1",
    });
    const attached = await attachWhatsAppContinuation({
      pendingId: pending.id,
      childInboundId: foreignId,
      userId: actor.userId,
    });
    expect(attached.ok).toBe(false);
    if (attached.ok) throw new Error("expected attach failure");
    expect(attached.code).toBe("OWNERSHIP_MISMATCH");

    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const first = await attachWhatsAppContinuation({
      pendingId: pending.id,
      childInboundId: childId,
      userId: actor.userId,
    });
    expect(first).toMatchObject({ ok: true });
    const replay = await attachWhatsAppContinuation({
      pendingId: pending.id,
      childInboundId: childId,
      userId: actor.userId,
    });
    expect(replay).toMatchObject({ ok: true, outcome: "already_attached" });
  });

  it("T7 apply recusa user_id divergente sem mutar pending nem outcome", async () => {
    const { pending } = await openClarification();
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const attached = await attachWhatsAppContinuation({
      pendingId: pending.id,
      childInboundId: childId,
      userId: actor.userId,
    });
    expect(attached).toMatchObject({ ok: true });
    const applied = await applyWhatsAppContinuation({
      pendingId: pending.id,
      userId: stranger.userId,
      childInboundId: childId,
      expectedSourceInboundMessageId: pending.sourceInboundMessageId,
      expectedStage: "CLARIFICATION",
      action: { type: "CANCEL" },
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error("expected ownership miss");
    expect(applied.code).toBe("OWNERSHIP_MISMATCH");
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("OPEN");
    expect(latest?.stage).toBe("CLARIFICATION");
    expect((await loadInbound(childId))?.continuationOutcome).toBeNull();
  });

  it("T18 child já apontando a outro pending é ATTACH_CONFLICT", async () => {
    const first = await openClarification();
    const childId = await insertInbound({
      ownerId: actor.userId,
      text: "texto-filho-conflito",
    });
    const attached = await attachWhatsAppContinuation({
      pendingId: first.pending.id,
      childInboundId: childId,
      userId: actor.userId,
    });
    expect(attached).toMatchObject({ ok: true });
    const cancelId = await insertInbound({
      ownerId: actor.userId,
      text: "cancela",
    });
    await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: cancelId,
    });
    const second = await openClarification();
    const conflict = await attachWhatsAppContinuation({
      pendingId: second.pending.id,
      childInboundId: childId,
      userId: actor.userId,
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("expected attach conflict");
    expect(conflict.code).toBe("ATTACH_CONFLICT");
    expect((await loadInbound(childId))?.continuationPendingId).toBe(
      first.pending.id,
    );
  });

  it("stage fence: apply com stage stale não grava NOOP", async () => {
    const { pending } = await openConfirmation();
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const attached = await attachWhatsAppContinuation({
      pendingId: pending.id,
      childInboundId: childId,
      userId: actor.userId,
    });
    expect(attached).toMatchObject({ ok: true });
    const applied = await applyWhatsAppContinuation({
      pendingId: pending.id,
      userId: actor.userId,
      childInboundId: childId,
      expectedSourceInboundMessageId: pending.sourceInboundMessageId,
      expectedStage: "CLARIFICATION",
      action: { type: "NOOP", reason: "UNRESOLVED" },
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error("expected stale stage");
    expect(applied.code).toBe("STATE_CHANGED");
    expect((await loadInbound(childId))?.continuationOutcome).toBeNull();
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("OPEN");
    expect(latest?.stage).toBe("CONFIRMATION");
  });

  it("T6/T12/T19 concorrência: um vence o stage; STATE_CHANGED não grava NOOP prematuro", async () => {
    const { pending } = await openClarification();
    const m2 = await insertInbound({ ownerId: actor.userId, text: "1" });
    const m3 = await insertInbound({ ownerId: actor.userId, text: "2" });
    const [r2, r3] = await Promise.all([
      processWhatsAppReadyForNlInbound({ sourceInboundMessageId: m2 }),
      processWhatsAppReadyForNlInbound({ sourceInboundMessageId: m3 }),
    ]);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.stage).toBe("CONFIRMATION");
    expect(latest?.status).toBe("OPEN");
    const o2 = (await loadInbound(m2))?.continuationOutcome;
    const o3 = (await loadInbound(m3))?.continuationOutcome;
    expect(["APPLIED", "NOOP"]).toContain(o2);
    expect(["APPLIED", "NOOP"]).toContain(o3);
    expect([o2, o3].filter((value) => value === "APPLIED")).toHaveLength(1);
  });

  it("T19 STATE_CHANGED_TRANSIENT_DOES_NOT_PREMATURELY_WRITE_NOOP", async () => {
    const { pending } = await openClarification();
    let releaseM2 = () => {};
    const holdM2 = new Promise<void>((resolve) => {
      releaseM2 = resolve;
    });
    let m2ReachedInterpret = false;
    continuationConsumerTestHooks.duringInterpret = async () => {
      continuationConsumerTestHooks.duringInterpret = undefined;
      m2ReachedInterpret = true;
      await holdM2;
    };
    const m2 = await insertInbound({ ownerId: actor.userId, text: "sim" });
    const m3 = await insertInbound({ ownerId: actor.userId, text: "1" });
    const p2 = processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: m2,
    });
    const started = Date.now();
    while (!m2ReachedInterpret) {
      if (Date.now() - started > 8_000) {
        releaseM2();
        throw new Error("M2 did not reach interpret");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const r3 = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: m3,
    });
    expect(r3).toMatchObject({ ok: true, stage: "CONFIRMATION" });
    expect((await loadInbound(m3))?.continuationOutcome).toBe("APPLIED");
    releaseM2();
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect((await loadInbound(m2))?.continuationOutcome).toBe("APPLIED");
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.stage).toBe("CONFIRMATION");
    expect(latest?.status).toBe("OPEN");
    expect(latest?.confirmationDisposition).toBe("AFFIRMED");
  });

  it("failure injection: throw no attach não deixa outcome; throw após commit ainda reconcilia no replay", async () => {
    const { pending } = await openClarification();
    continuationAttachTestHooks.throwDuringAttach = () => {
      throw new Error("attach boom");
    };
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const failed = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(failed).toMatchObject({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "PERSISTENCE_FAILED",
    });
    expect((await loadInbound(childId))?.continuationPendingId).toBeNull();
    continuationAttachTestHooks.throwDuringAttach = undefined;

    continuationApplyTestHooks.afterPendingMutationBeforeCommit = () => {
      throw new Error("before commit");
    };
    const rolled = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(rolled).toMatchObject({ ok: false, kind: "RETRYABLE_INFRA" });
    expect((await loadInbound(childId))?.continuationOutcome).toBeNull();
    const stillOpen = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(stillOpen?.stage).toBe("CLARIFICATION");
    continuationApplyTestHooks.afterPendingMutationBeforeCommit = undefined;

    const ok = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(ok.ok).toBe(true);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
  });

  it("throw após attach antes de interpret: child anexado, outcome null, replay aplica", async () => {
    const { pending } = await openClarification();
    continuationConsumerTestHooks.afterAttachBeforeInterpret = () => {
      throw new Error("after attach");
    };
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const failed = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(failed).toMatchObject({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "INTERNAL_FAILURE",
    });
    expect((await loadInbound(childId))?.continuationPendingId).toBe(pending.id);
    expect((await loadInbound(childId))?.continuationOutcome).toBeNull();
    continuationConsumerTestHooks.afterAttachBeforeInterpret = undefined;
    const ok = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(ok.ok).toBe(true);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
  });

  it("throw during interpret: outcome permanece null e replay aplica", async () => {
    await openClarification();
    continuationConsumerTestHooks.duringInterpret = () => {
      throw new Error("interpret boom");
    };
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const failed = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(failed).toMatchObject({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "INTERNAL_FAILURE",
    });
    expect((await loadInbound(childId))?.continuationOutcome).toBeNull();
    continuationConsumerTestHooks.duringInterpret = undefined;
    const ok = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(ok.ok).toBe(true);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
  });

  it("throw after commit before cleanup: replay só limpa payload", async () => {
    await openConfirmation();
    let throws = true;
    continuationConsumerTestHooks.afterCommitBeforeCleanup = () => {
      if (throws) throw new Error("cleanup boom");
    };
    const childId = await insertInbound({ ownerId: actor.userId, text: "sim" });
    const first = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(first).toMatchObject({ ok: false, kind: "RETRYABLE_INFRA" });
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
    expect((await loadInbound(childId))?.operationalText).toBe("sim");
    throws = false;
    const replay = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(replay).toMatchObject({ ok: true, kind: "REPLAY" });
    expect((await loadInbound(childId))?.operationalText).toBeNull();
  });

  it("F1-T1 cleared child pointer NULL outcome NULL OPEN/CLARIFICATION does not attach", async () => {
    const { pending } = await openClarification();
    const before = {
      status: pending.status,
      stage: pending.stage,
      expiresAt: pending.expiresAt.getTime(),
      parsed: JSON.stringify(pending.parsedPayload),
      clarification: JSON.stringify(pending.clarificationPayload),
    };
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    await clearInboundPayload(childId);
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE",
    });
    const child = await loadInbound(childId);
    expect(child?.continuationPendingId).toBeNull();
    expect(child?.continuationOutcome).toBeNull();
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe(before.status);
    expect(latest?.stage).toBe(before.stage);
    expect(latest?.expiresAt.getTime()).toBe(before.expiresAt);
    expect(JSON.stringify(latest?.parsedPayload)).toBe(before.parsed);
    expect(JSON.stringify(latest?.clarificationPayload)).toBe(before.clarification);
  });

  it("F1-T2 cleared child pointer NULL outcome NULL OPEN/CONFIRMATION does not attach", async () => {
    const { pending } = await openConfirmation();
    const before = pending.expiresAt.getTime();
    const childId = await insertInbound({ ownerId: actor.userId, text: "sim" });
    await clearInboundPayload(childId);
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE",
    });
    const child = await loadInbound(childId);
    expect(child?.continuationPendingId).toBeNull();
    expect(child?.continuationOutcome).toBeNull();
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("OPEN");
    expect(latest?.stage).toBe("CONFIRMATION");
    expect(latest?.confirmationDisposition).toBeNull();
    expect(latest?.expiresAt.getTime()).toBe(before);
  });

  it("F1-T3 cleared child already attached outcome APPLIED remains REPLAY", async () => {
    const { pending } = await openClarification();
    await db
      .update(whatsappPendingIntents)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(whatsappPendingIntents.id, pending.id));
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    const first = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(first.ok).toBe(true);
    const afterApply = await loadPendingBySource(pending.sourceInboundMessageId);
    const slid = afterApply!.expiresAt.getTime();
    expect((await loadInbound(childId))?.operationalText).toBeNull();
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
    const replay = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(replay).toMatchObject({ ok: true, kind: "REPLAY" });
    const afterReplay = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(afterReplay?.expiresAt.getTime()).toBe(slid);
    expect(afterReplay?.stage).toBe("CONFIRMATION");
    expect((await loadInbound(childId))?.continuationOutcome).toBe("APPLIED");
  });

  it("F1-T4 cleared child already attached outcome NOOP remains REPLAY", async () => {
    const { pending } = await openConfirmation();
    const before = pending.expiresAt.getTime();
    const childId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
    });
    const first = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(first.ok).toBe(true);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("NOOP");
    expect((await loadInbound(childId))?.operationalText).toBeNull();
    const replay = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(replay).toMatchObject({ ok: true, kind: "REPLAY" });
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("OPEN");
    expect(latest?.stage).toBe("CONFIRMATION");
    expect(latest?.expiresAt.getTime()).toBe(before);
    expect((await loadInbound(childId))?.continuationOutcome).toBe("NOOP");
  });

  it("F1-T5 cleared child attached to another pending fail-closed", async () => {
    const first = await openClarification();
    const childId = await insertInbound({
      ownerId: actor.userId,
      text: "texto-filho-f1t5",
    });
    const attached = await attachWhatsAppContinuation({
      pendingId: first.pending.id,
      childInboundId: childId,
      userId: actor.userId,
    });
    expect(attached).toMatchObject({ ok: true });
    await clearInboundPayload(childId);
    const cancelId = await insertInbound({
      ownerId: actor.userId,
      text: "cancela",
    });
    await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: cancelId,
    });
    const second = await openClarification();
    const conflict = await attachWhatsAppContinuation({
      pendingId: second.pending.id,
      childInboundId: childId,
      userId: actor.userId,
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("expected attach conflict");
    expect(conflict.code).toBe("ATTACH_CONFLICT");
    expect((await loadInbound(childId))?.continuationPendingId).toBe(
      first.pending.id,
    );
    expect((await loadInbound(childId))?.continuationOutcome).toBeNull();
  });

  it("F2-T1 expired pending + child payload usable may found", async () => {
    const { pending } = await openClarification();
    await db
      .update(whatsappPendingIntents)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(whatsappPendingIntents.id, pending.id));
    const childId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result.ok).toBe(true);
    const old = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(old?.status).toBe("EXPIRED");
    const founded = await loadPendingBySource(childId);
    expect(founded?.status).toBe("OPEN");
    expect(founded?.sourceInboundMessageId).toBe(childId);
    expect((await loadInbound(childId))?.continuationPendingId).toBeNull();
    expect(await loadOpenForUser(actor.userId)).toMatchObject({
      id: founded!.id,
    });
  });

  it("F2-T2 expired pending + child payload cleared does not found or occupy open_slot", async () => {
    const { pending } = await openClarification();
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    await clearInboundPayload(childId);
    continuationAttachTestHooks.throwDuringAttach = async () => {
      await db
        .update(whatsappPendingIntents)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(whatsappPendingIntents.id, pending.id));
    };
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE",
    });
    const old = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(old?.status).toBe("EXPIRED");
    expect(await loadPendingBySource(childId)).toBeUndefined();
    expect(await loadOpenForUser(actor.userId)).toBeNull();
    const child = await loadInbound(childId);
    expect(child?.continuationPendingId).toBeNull();
    expect(child?.continuationOutcome).toBeNull();
  });

  it("F2-T3 replay after F2-T2 remains convergent", async () => {
    const { pending } = await openClarification();
    const childId = await insertInbound({ ownerId: actor.userId, text: "1" });
    await clearInboundPayload(childId);
    continuationAttachTestHooks.throwDuringAttach = async () => {
      await db
        .update(whatsappPendingIntents)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(whatsappPendingIntents.id, pending.id));
    };
    await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    continuationAttachTestHooks.throwDuringAttach = undefined;
    const replay = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: childId,
    });
    expect(replay).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE",
    });
    expect(await loadPendingBySource(childId)).toBeUndefined();
    expect(await loadOpenForUser(actor.userId)).toBeNull();
    expect((await loadInbound(childId))?.continuationPendingId).toBeNull();
  });

  it("F2-T4 valid inbound after F2-T2 can found; no zombie OPEN slot", async () => {
    const { pending } = await openClarification();
    const clearedId = await insertInbound({ ownerId: actor.userId, text: "1" });
    await clearInboundPayload(clearedId);
    continuationAttachTestHooks.throwDuringAttach = async () => {
      await db
        .update(whatsappPendingIntents)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(whatsappPendingIntents.id, pending.id));
    };
    await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: clearedId,
    });
    continuationAttachTestHooks.throwDuringAttach = undefined;
    expect(await loadOpenForUser(actor.userId)).toBeNull();
    const nextId = await insertInbound({
      ownerId: actor.userId,
      text: "passar meu plantão de amanhã à noite na SR para o Colg Silva",
    });
    const founded = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: nextId,
    });
    expect(founded.ok).toBe(true);
    const next = await loadPendingBySource(nextId);
    expect(next?.status).toBe("OPEN");
    expect(next?.sourceInboundMessageId).toBe(nextId);
    expect(await loadOpenForUser(actor.userId)).toMatchObject({ id: next!.id });
  });

  it("F3 same-stage CHOICE generation CAS: at most one G0 winner", async () => {
    const { pending } = await openSectorClarification();
    const generation = {
      parsedPayload: pending.parsedPayload,
      clarificationPayload: pending.clarificationPayload,
    };
    const actionA = await sectorChoiceClarificationAction(pending, "1");
    const actionB = await sectorChoiceClarificationAction(pending, "2");
    expect(JSON.stringify(actionA.clarification)).not.toBe(
      JSON.stringify(actionB.clarification),
    );
    expect(actionA.clarification.code).toBe("AMBIGUOUS_OWN_SHIFT");
    expect(actionB.clarification.code).toBe("AMBIGUOUS_OWN_SHIFT");

    const childA = await insertInbound({ ownerId: actor.userId, text: "1" });
    const childB = await insertInbound({ ownerId: actor.userId, text: "2" });
    const attachedA = await attachWhatsAppContinuation({
      pendingId: pending.id,
      childInboundId: childA,
      userId: actor.userId,
    });
    const attachedB = await attachWhatsAppContinuation({
      pendingId: pending.id,
      childInboundId: childB,
      userId: actor.userId,
    });
    expect(attachedA).toMatchObject({ ok: true });
    expect(attachedB).toMatchObject({ ok: true });

    const [rA, rB] = await Promise.all([
      applyWhatsAppContinuation({
        pendingId: pending.id,
        userId: actor.userId,
        childInboundId: childA,
        expectedSourceInboundMessageId: pending.sourceInboundMessageId,
        expectedStage: "CLARIFICATION",
        action: actionA,
        generation,
      }),
      applyWhatsAppContinuation({
        pendingId: pending.id,
        userId: actor.userId,
        childInboundId: childB,
        expectedSourceInboundMessageId: pending.sourceInboundMessageId,
        expectedStage: "CLARIFICATION",
        action: actionB,
        generation,
      }),
    ]);
    const applied = [rA, rB].filter((row) => row.ok && row.outcome === "APPLIED");
    const changed = [rA, rB].filter(
      (row) => !row.ok && row.code === "STATE_CHANGED",
    );
    expect(applied).toHaveLength(1);
    expect(changed).toHaveLength(1);
    const latest = await loadPendingBySource(pending.sourceInboundMessageId);
    expect(latest?.status).toBe("OPEN");
    expect(latest?.stage).toBe("CLARIFICATION");
    const winner = applied[0]!;
    if (!winner.ok) throw new Error("expected winner");
    expect(JSON.stringify(latest?.clarificationPayload)).toBe(
      JSON.stringify(winner.row.clarificationPayload),
    );
    const oA = (await loadInbound(childA))?.continuationOutcome;
    const oB = (await loadInbound(childB))?.continuationOutcome;
    expect([oA, oB].filter((value) => value === "APPLIED")).toHaveLength(1);
    expect([oA, oB].filter((value) => value == null)).toHaveLength(1);
  });
});
