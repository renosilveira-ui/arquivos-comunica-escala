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
import { logger } from "../server/_core/logger";
import { addDaysToKey, dayKeyBrt } from "../server/local-time";
import { processWhatsAppReadyForNlInbound } from "../server/integrations/whatsapp/ready-for-nl-consumer";
import {
  parseStoredClarification,
  serializeResolvedSwapIntentV1,
} from "../server/integrations/whatsapp/pending-intent-payloads";
import * as parserMod from "../server/natural-language/swap-intent-parser";
import * as resolverMod from "../server/natural-language/swap-intent-resolver";
import * as cleanupMod from "../server/integrations/whatsapp/ready-for-nl-cleanup";
import * as pendingStore from "../server/integrations/whatsapp/pending-intent-store";
import * as swapCreate from "../server/swap-offer-create";
import { resolveCanonicalOperationalActorForUser } from "../server/_core/canonical-operational-actor";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Person = { userId: number; professionalId: number; name: string };

describe("WhatsApp B2-C READY_FOR_NL — integração", () => {
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
  let twinAnest: Person;
  let twinClinica: Person;

  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const shiftIds: number[] = [];
  const inboundIds: number[] = [];
  const hospitalIds: number[] = [];
  const institutionIds: number[] = [];
  const sectorIds: number[] = [];

  let anestesiaId: number;
  let clinicaId: number;

  const createSwapSpy = vi.spyOn(swapCreate, "createSwapOffer");

  async function makeTenant(label: string) {
    const suffix = `${stamp}${label}`.slice(-14).padStart(14, "0");
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `B2C Tenant ${stamp}${label}`,
        cnpj: suffix,
        legalName: `B2C Tenant ${stamp}${label}`,
        tradeName: `B2C${label}`,
        isActive: true,
      })
      .$returningId();
    institutionIds.push(institution.id);
    const [hospital] = await db
      .insert(hospitals)
      .values({
        institutionId: institution.id,
        name: `B2C Hospital ${stamp}${label}`,
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
    medicalSpecialtyId: number | null,
  ): Promise<Person> {
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `b2c-${label}-${stamp}@example.test`,
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
    ownerId: number | null;
    suffix: string;
    text?: string | null;
    status?: string;
    kind?: "TEXT" | "AUDIO" | "UNSUPPORTED_MEDIA";
    expiresAt?: Date | null;
    mediaUrl?: string | null;
  }): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMb2c${stamp}${input.suffix}`.slice(0, 64),
        userId: input.ownerId,
        contentKind: input.kind ?? "TEXT",
        forwarded: false,
        processingStatus: input.status ?? "READY_FOR_NL",
        operationalText: input.text === undefined ? "texto" : input.text,
        mediaUrl: input.mediaUrl ?? null,
        payloadExpiresAt:
          input.expiresAt === undefined
            ? new Date(Date.now() + 24 * 60 * 60 * 1000)
            : input.expiresAt,
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
    anestesiaId = await specialtyId("ANESTESIOLOGIA", "Anestesiologia", 3);
    clinicaId = await specialtyId("CLINICA_MEDICA", "Clínica médica", 16);
    const tenant = await makeTenant("A");
    tenantA = tenant.institutionId;
    hospitalA = tenant.hospitalId;
    recoveryA = await makeSector(tenantA, hospitalA, "Sala de Recuperação");
    surgeryA = await makeSector(tenantA, hospitalA, "Centro Cirúrgico");
    actor = await makePerson("actor", "Ator Bravo", anestesiaId);
    colleague = await makePerson("col", "Colg Silva", anestesiaId);
    twinAnest = await makePerson("twa", "Homo Bravo", anestesiaId);
    twinClinica = await makePerson("twc", "Homo Bravo", clinicaId);
    await makePerson("tws", "Same Bravo", anestesiaId);
    await makePerson("tws2", "Same Bravo", anestesiaId);

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
    await makeShift({
      owner: twinAnest,
      sectorId: recoveryA,
      date: dayAfter,
      start: "19:00:00",
      end: "07:00:00",
      label: "Noite",
    });
    await makeShift({
      owner: twinClinica,
      sectorId: recoveryA,
      date: addDaysToKey(today, 3),
      start: "19:00:00",
      end: "07:00:00",
      label: "Noite",
    });
  });

  afterEach(async () => {
    expect(createSwapSpy).not.toHaveBeenCalled();
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
    if (sectorIds.length) {
      await db.delete(sectors).where(inArray(sectors.id, sectorIds));
    }
    if (hospitalIds.length) {
      await db.delete(hospitals).where(inArray(hospitals.id, hospitalIds));
    }
    if (institutionIds.length) {
      await db
        .delete(institutions)
        .where(inArray(institutions.id, institutionIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("TEXT READY_FOR_NL resolvido → CONFIRMATION, limpa payload, não executa swap", async () => {
    const parseSpy = vi.spyOn(parserMod, "parseSwapIntent");
    const resolveSpy = vi.spyOn(resolverMod, "resolveSwapIntent");
    const text = `passar meu plantão de amanhã à noite na SR para o Colg Silva`;
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "conf",
      text,
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result).toMatchObject({
      ok: true,
      kind: "ADVANCED",
      stage: "CONFIRMATION",
    });
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy).toHaveBeenCalledWith(text);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    const actorArg = resolveSpy.mock.calls[0]![1];
    expect(actorArg).toEqual({
      userId: actor.userId,
      professionalId: actor.professionalId,
      institutionIds: [tenantA],
    });
    expect(resolveSpy.mock.calls[0]!.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(resolveSpy.mock.calls[0])).not.toContain("WHATSAPP");

    const pending = await loadPendingBySource(sourceId);
    expect(pending?.status).toBe("OPEN");
    expect(pending?.stage).toBe("CONFIRMATION");
    expect(pending?.intentKind).toBe("CESSAO");
    expect(pending?.institutionId).toBe(tenantA);
    expect(pending?.clarificationPayload).toBeNull();
    expect(pending?.userId).toBe(actor.userId);
    expect(pending?.sourceInboundMessageId).toBe(sourceId);

    const inbound = await loadInbound(sourceId);
    expect(inbound?.operationalText).toBeNull();
    expect(inbound?.payloadClearedAt).toBeTruthy();
    parseSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  it("replay do mesmo source não reparsa nem reresolve e não cria segundo pending", async () => {
    const parseSpy = vi.spyOn(parserMod, "parseSwapIntent");
    const resolveSpy = vi.spyOn(resolverMod, "resolveSwapIntent");
    const text = `passar meu plantão de amanhã à noite na SR para o Colg Silva`;
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "replay",
      text,
    });
    const first = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(first.ok).toBe(true);
    parseSpy.mockClear();
    resolveSpy.mockClear();
    const second = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(second).toMatchObject({
      ok: true,
      kind: "REPLAY",
      stage: "CONFIRMATION",
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    const pendings = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.sourceInboundMessageId, sourceId));
    expect(pendings).toHaveLength(1);
    parseSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  it("crash window: advance ok, clear falha, replay só limpa", async () => {
    const parseSpy = vi.spyOn(parserMod, "parseSwapIntent");
    const resolveSpy = vi.spyOn(resolverMod, "resolveSwapIntent");
    const actualClear =
      cleanupMod.clearWhatsAppInboundOperationalPayloadForReadyNl;
    const clearSpy = vi
      .spyOn(cleanupMod, "clearWhatsAppInboundOperationalPayloadForReadyNl")
      .mockImplementationOnce(async () => ({
        ok: false,
        code: "PERSISTENCE_FAILED",
      }))
      .mockImplementation(actualClear);

    const text = `passar meu plantão de amanhã à noite na SR para o Colg Silva`;
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "crash",
      text,
    });
    const first = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(first).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "PERSISTENCE_FAILED",
    });
    const pendingAfterAdvance = await loadPendingBySource(sourceId);
    expect(pendingAfterAdvance?.stage).toBe("CONFIRMATION");
    const inboundStill = await loadInbound(sourceId);
    expect(inboundStill?.operationalText).toBe(text);

    parseSpy.mockClear();
    resolveSpy.mockClear();
    const replay = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(replay).toMatchObject({
      ok: true,
      kind: "REPLAY",
      stage: "CONFIRMATION",
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    const inboundCleared = await loadInbound(sourceId);
    expect(inboundCleared?.operationalText).toBeNull();
    const pendingReplay = await loadPendingBySource(sourceId);
    expect(pendingReplay?.stage).toBe("CONFIRMATION");
    expect(pendingReplay?.id).toBe(pendingAfterAdvance?.id);
    expect(JSON.stringify(pendingReplay?.resolvedPayload)).toBe(
      JSON.stringify(pendingAfterAdvance?.resolvedPayload),
    );
    parseSpy.mockRestore();
    resolveSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("dois consumers simultâneos: uma transição, cleanup idempotente", async () => {
    const text = `passar meu plantão de amanhã à noite na SR para o Colg Silva`;
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "conc",
      text,
    });
    const [a, b] = await Promise.all([
      processWhatsAppReadyForNlInbound({ sourceInboundMessageId: sourceId }),
      processWhatsAppReadyForNlInbound({ sourceInboundMessageId: sourceId }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    for (const result of [a, b]) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(["ADVANCED", "REPLAY"]).toContain(result.kind);
        expect(result.stage).toBe("CONFIRMATION");
      }
    }
    const pendings = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.sourceInboundMessageId, sourceId));
    expect(pendings).toHaveLength(1);
    expect(pendings[0]?.stage).toBe("CONFIRMATION");
    const inbound = await loadInbound(sourceId);
    expect(inbound?.operationalText).toBeNull();
  });

  it("advance durável + owner muda antes do clear → pending permanece; inbound não é destruído", async () => {
    const text = `passar meu plantão de amanhã à noite na SR para o Colg Silva`;
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "ownchg",
      text,
    });
    const actualAdvance = pendingStore.advanceWhatsAppPendingFromParse;
    const advanceSpy = vi
      .spyOn(pendingStore, "advanceWhatsAppPendingFromParse")
      .mockImplementation(async (input) => {
        const result = await actualAdvance(input);
        if (result.ok) {
          await db
            .update(whatsappInboundMessages)
            .set({ userId: colleague.userId })
            .where(eq(whatsappInboundMessages.id, sourceId));
        }
        return result;
      });
    try {
      const processed = await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: sourceId,
      });
      expect(processed).toEqual({
        ok: false,
        kind: "BLOCKED",
        code: "STATE_CHANGED",
      });
      const pending = await loadPendingBySource(sourceId);
      expect(pending?.status).toBe("OPEN");
      expect(pending?.stage).toBe("CONFIRMATION");
      expect(pending?.userId).toBe(actor.userId);
      const inbound = await loadInbound(sourceId);
      expect(inbound?.operationalText).toBe(text);
      expect(inbound?.payloadClearedAt).toBeNull();
      expect(inbound?.userId).toBe(colleague.userId);
    } finally {
      advanceSpy.mockRestore();
    }
  });

  it("advance durável + status muda antes do clear → não destrói payload", async () => {
    const text = `passar meu plantão de amanhã à noite na SR para o Colg Silva`;
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "stchg",
      text,
    });
    const actualAdvance = pendingStore.advanceWhatsAppPendingFromParse;
    const advanceSpy = vi
      .spyOn(pendingStore, "advanceWhatsAppPendingFromParse")
      .mockImplementation(async (input) => {
        const result = await actualAdvance(input);
        if (result.ok) {
          await db
            .update(whatsappInboundMessages)
            .set({ processingStatus: "READY_FOR_TRANSCRIPTION" })
            .where(eq(whatsappInboundMessages.id, sourceId));
        }
        return result;
      });
    try {
      const processed = await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: sourceId,
      });
      expect(processed).toEqual({
        ok: false,
        kind: "BLOCKED",
        code: "STATE_CHANGED",
      });
      const pending = await loadPendingBySource(sourceId);
      expect(pending?.status).toBe("OPEN");
      expect(pending?.stage).toBe("CONFIRMATION");
      const inbound = await loadInbound(sourceId);
      expect(inbound?.operationalText).toBe(text);
      expect(inbound?.payloadClearedAt).toBeNull();
      expect(inbound?.processingStatus).toBe("READY_FOR_TRANSCRIPTION");
    } finally {
      advanceSpy.mockRestore();
    }
  });

  it("ambiguidade de plantão próprio → CLARIFICATION e limpa inbound", async () => {
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "ownamb",
      text: `passar meu plantão de amanhã para o Colg Silva`,
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result).toMatchObject({
      ok: true,
      kind: "ADVANCED",
      stage: "CLARIFICATION",
    });
    const pending = await loadPendingBySource(sourceId);
    expect(pending?.stage).toBe("CLARIFICATION");
    expect(pending?.resolvedPayload).toBeNull();
    const clarification = parseStoredClarification(pending?.clarificationPayload);
    expect(clarification.ok).toBe(true);
    if (clarification.ok) {
      expect(clarification.value.code).toBe("AMBIGUOUS_OWN_SHIFT");
    }
    const inbound = await loadInbound(sourceId);
    expect(inbound?.operationalText).toBeNull();
  });

  it("SWAP sem contrapartida → CLARIFICATION SWAP_TARGET_SHIFT_REQUIRED", async () => {
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "needtgt",
      text: `trocar meu plantão de amanhã à noite na SR com o Colg Silva`,
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result).toMatchObject({
      ok: true,
      stage: "CLARIFICATION",
    });
    const pending = await loadPendingBySource(sourceId);
    const clarification = parseStoredClarification(pending?.clarificationPayload);
    expect(clarification.ok).toBe(true);
    if (clarification.ok) {
      expect(clarification.value.code).toBe("SWAP_TARGET_SHIFT_REQUIRED");
    }
  });

  it("homônimos com qualificação distinta persistem labels seguros", async () => {
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "homo",
      text: `passar meu plantão de amanhã à noite na SR para o Homo Bravo`,
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result).toMatchObject({ ok: true, stage: "CLARIFICATION" });
    const pending = await loadPendingBySource(sourceId);
    const clarification = parseStoredClarification(pending?.clarificationPayload);
    expect(clarification.ok).toBe(true);
    if (!clarification.ok || clarification.value.code !== "AMBIGUOUS_TARGET_PROFESSIONAL") {
      throw new Error("esperava AMBIGUOUS_TARGET_PROFESSIONAL");
    }
    expect(clarification.value.candidates).toHaveLength(2);
    const labels = clarification.value.candidates.map((choice) => choice.label);
    expect(labels.some((label) => label.includes("Anestesiologia"))).toBe(true);
    expect(labels.some((label) => label.includes("Clínica médica"))).toBe(true);
    for (const choice of clarification.value.candidates) {
      expect(choice.label).not.toContain(String(choice.professionalId));
    }
    const serialized = JSON.stringify(clarification.value);
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain('"name"');
    expect(clarification.value.unresolvedGroups).toEqual([]);
  });

  it("homônimos indistinguíveis viram unresolved group", async () => {
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "unres",
      text: `passar meu plantão de amanhã à noite na SR para o Same Bravo`,
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result).toMatchObject({ ok: true, stage: "CLARIFICATION" });
    const pending = await loadPendingBySource(sourceId);
    const clarification = parseStoredClarification(pending?.clarificationPayload);
    expect(clarification.ok).toBe(true);
    if (!clarification.ok || clarification.value.code !== "AMBIGUOUS_TARGET_PROFESSIONAL") {
      throw new Error("esperava AMBIGUOUS_TARGET_PROFESSIONAL");
    }
    expect(clarification.value.candidates).toEqual([]);
    expect(clarification.value.unresolvedGroups[0]?.count).toBeGreaterThanOrEqual(2);
    expect(clarification.value.unresolvedGroups[0]?.code).toBe("UNRESOLVED_HOMONYM");
    expect(clarification.value.candidates).toEqual([]);
  });

  it("payload já limpo + pending materializado é replay no-op", async () => {
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "cleared",
      text: `passar meu plantão de amanhã à noite na SR para o Colg Silva`,
    });
    const first = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(first.ok).toBe(true);
    const parseSpy = vi.spyOn(parserMod, "parseSwapIntent");
    const second = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(second).toMatchObject({ ok: true, kind: "REPLAY" });
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it("already_open de outro source não limpa o novo inbound", async () => {
    const firstId = await insertInbound({
      ownerId: actor.userId,
      suffix: "open1",
      text: `passar meu plantão de amanhã à noite na SR para o Colg Silva`,
    });
    const first = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: firstId,
    });
    expect(first.ok).toBe(true);
    const secondText = `passar meu plantão de amanhã à noite na SR para o Colg Silva`;
    const secondId = await insertInbound({
      ownerId: actor.userId,
      suffix: "open2",
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
    const inbound = await loadInbound(secondId);
    expect(inbound?.operationalText).toBe(secondText);
    expect(await loadPendingBySource(secondId)).toBeUndefined();
  });

  it("resolved payload é o mesmo que outro canal obteria para o mesmo actor/texto", async () => {
    const text = `passar meu plantão de amanhã à noite na SR para o Colg Silva`;
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "chan",
      text,
    });
    const processed = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(processed).toMatchObject({ ok: true, stage: "CONFIRMATION" });
    const pending = await loadPendingBySource(sourceId);
    const parsed = parserMod.parseSwapIntent(text);
    if ("ok" in parsed) throw new Error(parsed.message);
    const actorResolved = await resolveCanonicalOperationalActorForUser({
      userId: actor.userId,
    });
    expect(actorResolved.ok).toBe(true);
    if (!actorResolved.ok) return;
    const direct = await resolverMod.resolveSwapIntent(parsed, actorResolved.actor);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const serialized = serializeResolvedSwapIntentV1(direct);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(pending?.resolvedPayload).toEqual(serialized.value);
  });

  it("logs não incluem texto operacional nem PII fictícia", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation((obj: unknown) => {
      lines.push(typeof obj === "string" ? obj : JSON.stringify(obj));
      return logger;
    });
    const secret =
      "passar meu plantão de amanhã à noite na SR para o Colg Silva CPF 529.982.247-25 tel +5511999887766 ana.secreta@example.test";
    const sourceId = await insertInbound({
      ownerId: actor.userId,
      suffix: "pii",
      text: secret,
    });
    await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    const blob = lines.join("\n");
    expect(blob).not.toContain("529.982.247-25");
    expect(blob).not.toContain("+5511999887766");
    expect(blob).not.toContain("ana.secreta@example.test");
    expect(blob).not.toContain(secret);
    expect(blob).toContain("whatsapp_ready_for_nl_processed");
    spy.mockRestore();
  });
});
