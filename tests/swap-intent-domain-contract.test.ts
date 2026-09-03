// tests/swap-intent-domain-contract.test.ts — cadeia resolver → domínio.
//
// A tese: o resolver LOCALIZA e `createSwapOffer` DECIDE. Por isso as
// regras de elegibilidade (#317, hospital-wide legado, dupla qualificação)
// são provadas aqui, na cadeia, e não duplicadas nos testes do resolver —
// duplicá-las ossificaria uma cópia da política e criaria drift com #317.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { createSwapOffer } from "../server/swap-offer-create";
import { parseSwapIntent } from "../server/natural-language/swap-intent-parser";
import { resolveSwapIntent } from "../server/natural-language/swap-intent-resolver";
import {
  toCreateSwapOfferInput,
  type ResolvedSwapIntent,
} from "../server/natural-language/swap-intent-types";
import { yearMonthBrt } from "../server/local-time";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Person = { userId: number; professionalId: number; name: string };

describe("intenção resolvida → createSwapOffer", () => {
  let db: Db;
  const stamp = Date.now();
  // Segunda 01/03/2027, 12:00 BRT — bem longe do seed.
  const now = new Date("2027-03-01T15:00:00Z");
  const at = (date: string, time: string) => new Date(`${date}T${time}-03:00`);

  let tenant: number;
  let otherTenant: number;
  let hospital: number;
  let otherHospital: number;
  let allowlistSector: number;
  let legacySector: number;
  let otherSector: number;
  let allowlistContext: number;
  let legacyContext: number;
  let otherContext: number;

  let actor: Person;
  /** Acesso setorial exato na SR: elegível sob allowlist. */
  let peerExact: Person;
  /** Acesso hospital-wide (sector_id NULL): reprovado pela allowlist. */
  let peerHospitalWide: Person;

  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const shiftIds: number[] = [];

  async function makeTenant(label: string) {
    const suffix = `${stamp}${label}`;
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `NLD Tenant ${suffix}`,
        cnpj: suffix.slice(-14).padStart(14, "0"),
        legalName: `NLD Tenant ${suffix}`,
        tradeName: `NLD${label}`,
        isActive: true,
      })
      .$returningId();
    const [hospitalRow] = await db
      .insert(hospitals)
      .values({ institutionId: institution.id, name: `NLD Hospital ${suffix}` })
      .$returningId();
    return { institutionId: institution.id, hospitalId: hospitalRow.id };
  }

  async function makeSectorWithScale(input: {
    institutionId: number;
    hospitalId: number;
    name: string;
    admissionPolicy: "QUALIFICATION_ALLOWLIST" | "ALL_CFM_SPECIALTIES";
  }) {
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        name: input.name,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    const [context] = await db
      .insert(scheduleContexts)
      .values({
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        sectorId: sector.id,
        admissionPolicy: input.admissionPolicy,
        medicalSpecialtyId: null,
        operationalProfileCode: null,
        active: true,
      })
      .$returningId();
    return { sectorId: sector.id, scheduleContextId: context.id };
  }

  async function makePerson(
    label: string,
    name: string,
    input: {
      institutionId: number;
      /** `null` = hospital-wide (a brecha que a allowlist #317 fecha). */
      accessSectorIds: (number | null)[];
      hospitalId: number;
    },
  ): Promise<Person> {
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `nld-${label}-${stamp}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    const [professional] = await db
      .insert(professionals)
      .values({ userId: user.id, name, role: "Médico", specialty: "Anestesiologia", userRole: "USER" })
      .$returningId();
    professionalIds.push(professional.id);
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: user.id,
      institutionId: input.institutionId,
      roleInInstitution: "USER",
      active: true,
    });
    for (const sectorId of input.accessSectorIds) {
      await db.insert(professionalAccess).values({
        institutionId: input.institutionId,
        professionalId: professional.id,
        hospitalId: input.hospitalId,
        sectorId,
        canAccess: true,
      });
    }
    return { userId: user.id, professionalId: professional.id, name };
  }

  async function publishMonth(institutionId: number, hospitalId: number, date: Date) {
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(date),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
  }

  async function makeShift(input: {
    owner: Person;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    scheduleContextId: number;
    date: string;
    start: string;
    end: string;
    label: string;
  }) {
    const startAt = at(input.date, input.start);
    const endAt = at(input.date, input.end);
    if (endAt <= startAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
    await publishMonth(input.institutionId, input.hospitalId, startAt);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        scheduleContextId: input.scheduleContextId,
        label: input.label,
        specialty: "Anestesiologia",
        startAt,
        endAt,
        status: "OCUPADO",
      })
      .$returningId();
    shiftIds.push(shift.id);
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        professionalId: input.owner.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    return { shiftInstanceId: shift.id, assignmentId: assignment.id };
  }

  async function resolved(text: string, institutionIds = [tenant]): Promise<ResolvedSwapIntent> {
    const parsed = parseSwapIntent(text);
    if ("ok" in parsed) throw new Error(`parser falhou: ${parsed.code} ${parsed.message}`);
    const result = await resolveSwapIntent(
      parsed,
      { userId: actor.userId, professionalId: actor.professionalId, institutionIds },
      { now },
    );
    if (!result.ok) throw new Error(`resolver falhou: ${result.code} ${result.message}`);
    return result;
  }

  const domainActor = (intent: ResolvedSwapIntent) => ({
    userId: intent.actorUserId,
    professionalId: intent.actorProfessionalId,
    expectedSessionVersion: 1,
    institutionId: intent.institutionId,
  });

  beforeAll(async () => {
    db = (await getDb())!;
    if (!db) throw new Error("Database not available");

    const main = await makeTenant("A");
    const other = await makeTenant("B");
    tenant = main.institutionId;
    hospital = main.hospitalId;
    otherTenant = other.institutionId;
    otherHospital = other.hospitalId;

    const allowlist = await makeSectorWithScale({
      institutionId: tenant,
      hospitalId: hospital,
      name: "Sala de Recuperação",
      admissionPolicy: "QUALIFICATION_ALLOWLIST",
    });
    allowlistSector = allowlist.sectorId;
    allowlistContext = allowlist.scheduleContextId;

    const legacy = await makeSectorWithScale({
      institutionId: tenant,
      hospitalId: hospital,
      name: "Centro Cirúrgico",
      admissionPolicy: "ALL_CFM_SPECIALTIES",
    });
    legacySector = legacy.sectorId;
    legacyContext = legacy.scheduleContextId;

    const foreign = await makeSectorWithScale({
      institutionId: otherTenant,
      hospitalId: otherHospital,
      name: "Sala de Recuperação",
      admissionPolicy: "ALL_CFM_SPECIALTIES",
    });
    otherSector = foreign.sectorId;
    otherContext = foreign.scheduleContextId;

    // Dupla qualificação: acesso setorial exato nos dois setores.
    actor = await makePerson("actor", `NLD Ator ${stamp}`, {
      institutionId: tenant,
      hospitalId: hospital,
      accessSectorIds: [allowlistSector, legacySector],
    });
    peerExact = await makePerson("exact", `Danilo Souza ${stamp}`, {
      institutionId: tenant,
      hospitalId: hospital,
      accessSectorIds: [allowlistSector, legacySector],
    });
    peerHospitalWide = await makePerson("wide", `Germana Medeiros ${stamp}`, {
      institutionId: tenant,
      hospitalId: hospital,
      accessSectorIds: [null],
    });
  });

  afterAll(async () => {
    if (!db) return;
    if (shiftIds.length) {
      await db.delete(notifications).where(inArray(notifications.shiftInstanceId, shiftIds));
      await db.delete(swapRequests).where(inArray(swapRequests.fromShiftInstanceId, shiftIds));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    if (userIds.length) {
      await db.delete(notifications).where(inArray(notifications.userId, userIds));
    }
    if (professionalIds.length) {
      await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, professionalIds));
      await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    }
    // createSwapOffer grava auditoria: sem limpar, a instituição não sai.
    await db.delete(auditTrail).where(inArray(auditTrail.institutionId, [tenant, otherTenant]));
    await db.delete(scheduleContexts).where(inArray(scheduleContexts.id, [allowlistContext, legacyContext, otherContext]));
    await db.delete(sectors).where(inArray(sectors.id, [allowlistSector, legacySector, otherSector]));
    await db.delete(monthlyRosters).where(inArray(monthlyRosters.institutionId, [tenant, otherTenant]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospital, otherHospital]));
    await db.delete(institutions).where(inArray(institutions.id, [tenant, otherTenant]));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  });

  it("CESSAO resolvida alimenta o domínio sem transformação semântica", async () => {
    const source = await makeShift({
      owner: actor,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: allowlistSector,
      scheduleContextId: allowlistContext,
      date: "2027-03-02",
      start: "19:00:00",
      end: "07:00:00",
      label: `cessao-${stamp}`,
    });

    const intent = await resolved("passo meu plantão de amanhã à noite na SR pro Danilo Souza");
    expect(intent.kind).toBe("CESSAO");
    expect(intent.ownShift.shiftInstanceId).toBe(source.shiftInstanceId);

    const created = await createSwapOffer(
      toCreateSwapOfferInput(intent, { reason: `nl-cessao-${stamp}` }),
      domainActor(intent),
    );
    expect(created.type).toBe("CESSAO");
    expect(created.status).toBe("PENDING");
    expect(created.fromShiftInstanceId).toBe(source.shiftInstanceId);
    expect(created.fromAssignmentId).toBe(source.assignmentId);
    expect(created.toProfessionalId).toBe(peerExact.professionalId);
    expect(created.toUserId).toBe(peerExact.userId);
    // Cessão jamais ganha contrapartida no caminho da linguagem natural.
    expect(created.toShiftInstanceId).toBeNull();
    expect(created.institutionId).toBe(tenant);
    expect(created.sectorId).toBe(allowlistSector);
  });

  it("SWAP resolvida cria troca bidirecional com a contrapartida certa", async () => {
    const source = await makeShift({
      owner: actor,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: allowlistSector,
      scheduleContextId: allowlistContext,
      date: "2027-03-05",
      start: "19:00:00",
      end: "07:00:00",
      label: `swap-src-${stamp}`,
    });
    const counterpart = await makeShift({
      owner: peerExact,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: allowlistSector,
      scheduleContextId: allowlistContext,
      date: "2027-03-06",
      start: "19:00:00",
      end: "07:00:00",
      label: `swap-dst-${stamp}`,
    });

    const intent = await resolved(
      "troco meu plantão de 05/03 à noite na SR com o plantão do Danilo Souza dia 06/03 à noite",
    );
    expect(intent.kind).toBe("SWAP");
    if (intent.kind !== "SWAP") return;
    expect(intent.ownShift.shiftInstanceId).toBe(source.shiftInstanceId);
    expect(intent.targetShift.shiftInstanceId).toBe(counterpart.shiftInstanceId);

    const created = await createSwapOffer(
      toCreateSwapOfferInput(intent, { reason: `nl-swap-${stamp}` }),
      domainActor(intent),
    );
    expect(created.type).toBe("SWAP");
    expect(created.fromShiftInstanceId).toBe(source.shiftInstanceId);
    expect(created.toShiftInstanceId).toBe(counterpart.shiftInstanceId);
    expect(created.toProfessionalId).toBe(peerExact.professionalId);
  });

  // #317: allowlist exige setor exato; hospital-wide não basta.
  it("o resolver acha o colega, mas a allowlist #317 é o domínio que aplica", async () => {
    const source = await makeShift({
      owner: actor,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: allowlistSector,
      scheduleContextId: allowlistContext,
      date: "2027-03-09",
      start: "19:00:00",
      end: "07:00:00",
      label: `allowlist-${stamp}`,
    });

    // Localização funciona: o resolver não é camada de compliance.
    const intent = await resolved("passo meu plantão de 09/03 à noite na SR pra Germana Medeiros");
    expect(intent.targetProfessional.professionalId).toBe(peerHospitalWide.professionalId);
    expect(intent.ownShift.shiftInstanceId).toBe(source.shiftInstanceId);

    // Decisão é do domínio, e ele recusa.
    await expect(
      createSwapOffer(toCreateSwapOfferInput(intent), domainActor(intent)),
    ).rejects.toThrow(/acesso para esta escala|sem acesso/i);

    const [leaked] = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(eq(swapRequests.fromShiftInstanceId, source.shiftInstanceId))
      .limit(1);
    expect(leaked).toBeUndefined();
  });

  it("hospital-wide legado continua válido fora da allowlist", async () => {
    const source = await makeShift({
      owner: actor,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: legacySector,
      scheduleContextId: legacyContext,
      date: "2027-03-12",
      start: "19:00:00",
      end: "07:00:00",
      label: `legacy-${stamp}`,
    });

    const intent = await resolved(
      "passo meu plantão de 12/03 à noite no Centro Cirúrgico pra Germana Medeiros",
    );
    expect(intent.ownShift.shiftInstanceId).toBe(source.shiftInstanceId);
    const created = await createSwapOffer(toCreateSwapOfferInput(intent), domainActor(intent));
    expect(created.type).toBe("CESSAO");
    expect(created.toProfessionalId).toBe(peerHospitalWide.professionalId);
  });

  it("dupla qualificação: o setor dito escolhe a escala, e as duas passam", async () => {
    const inAllowlist = await makeShift({
      owner: actor,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: allowlistSector,
      scheduleContextId: allowlistContext,
      date: "2027-03-15",
      start: "07:00:00",
      end: "13:00:00",
      label: `dual-sr-${stamp}`,
    });
    const inLegacy = await makeShift({
      owner: actor,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: legacySector,
      scheduleContextId: legacyContext,
      date: "2027-03-15",
      start: "13:00:00",
      end: "19:00:00",
      label: `dual-cc-${stamp}`,
    });

    const viaSector = await resolved("passo meu plantão de 15/03 de manhã na SR pro Danilo Souza");
    expect(viaSector.ownShift.shiftInstanceId).toBe(inAllowlist.shiftInstanceId);
    const first = await createSwapOffer(toCreateSwapOfferInput(viaSector), domainActor(viaSector));
    expect(first.sectorId).toBe(allowlistSector);

    const viaOther = await resolved(
      "passo meu plantão de 15/03 à tarde no Centro Cirúrgico pro Danilo Souza",
    );
    expect(viaOther.ownShift.shiftInstanceId).toBe(inLegacy.shiftInstanceId);
    const second = await createSwapOffer(toCreateSwapOfferInput(viaOther), domainActor(viaOther));
    expect(second.sectorId).toBe(legacySector);
  });

  it("o domínio ainda rejeita estado que mudou depois da resolução", async () => {
    const source = await makeShift({
      owner: actor,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: allowlistSector,
      scheduleContextId: allowlistContext,
      date: "2027-03-18",
      start: "19:00:00",
      end: "07:00:00",
      label: `stale-${stamp}`,
    });

    const intent = await resolved("passo meu plantão de 18/03 à noite na SR pro Danilo Souza");
    // A alocação sai de baixo dos pés entre resolver e materializar.
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, source.assignmentId));

    await expect(
      createSwapOffer(toCreateSwapOfferInput(intent), domainActor(intent)),
    ).rejects.toThrow();
  });

  it("cross-tenant continua fail-closed nas duas pontas", async () => {
    const foreign = await makeShift({
      owner: actor,
      institutionId: otherTenant,
      hospitalId: otherHospital,
      sectorId: otherSector,
      scheduleContextId: otherContext,
      date: "2027-03-20",
      start: "19:00:00",
      end: "07:00:00",
      label: `foreign-${stamp}`,
    });

    // O ator não tem vínculo no outro tenant: o resolver nem enxerga.
    const parsed = parseSwapIntent("passo meu plantão de 20/03 à noite pro Danilo Souza");
    if ("ok" in parsed) throw new Error("parser falhou");
    const scoped = await resolveSwapIntent(
      parsed,
      { userId: actor.userId, professionalId: actor.professionalId, institutionIds: [tenant] },
      { now },
    );
    expect(scoped.ok).toBe(false);
    if (!scoped.ok) expect(scoped.code).toBe("OWN_SHIFT_NOT_FOUND");

    // E se alguém forjar a tupla, o domínio recusa pelo tenant do ator.
    await expect(
      createSwapOffer(
        {
          type: "CESSAO",
          fromShiftInstanceId: foreign.shiftInstanceId,
          fromAssignmentId: foreign.assignmentId,
          toProfessionalId: peerExact.professionalId,
        },
        {
          userId: actor.userId,
          professionalId: actor.professionalId,
          expectedSessionVersion: 1,
          institutionId: tenant,
        },
      ),
    ).rejects.toThrow();
  });

  it("resolver não escreve nada: só o domínio materializa", async () => {
    await makeShift({
      owner: actor,
      institutionId: tenant,
      hospitalId: hospital,
      sectorId: allowlistSector,
      scheduleContextId: allowlistContext,
      date: "2027-03-23",
      start: "19:00:00",
      end: "07:00:00",
      label: `readonly-${stamp}`,
    });

    const before = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(and(eq(swapRequests.institutionId, tenant), eq(swapRequests.fromUserId, actor.userId)));

    await resolved("passo meu plantão de 23/03 à noite na SR pro Danilo Souza");
    await resolved("troco meu plantão de 23/03 à noite na SR com o Danilo Souza").catch(() => undefined);

    const after = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(and(eq(swapRequests.institutionId, tenant), eq(swapRequests.fromUserId, actor.userId)));
    expect(after.length).toBe(before.length);
  });
});
