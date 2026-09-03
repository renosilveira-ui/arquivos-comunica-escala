// tests/swap-intent-resolver.test.ts — camada 2: slots → entidades reais.
//
// O que estes testes provam é LOCALIZAÇÃO, não compliance: zero é "não
// encontrei", mais de um é "qual deles?" e nunca se escolhe o primeiro
// resultado. Qualificação, professional_access e allowlist #317 são
// autoridade de createSwapOffer e estão provados em
// tests/swap-intent-domain-contract.test.ts, na cadeia resolver → domínio.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { parseSwapIntent } from "../server/natural-language/swap-intent-parser";
import {
  resolveSwapIntent,
  type ResolveSwapIntentOptions,
  type SwapIntentActor,
} from "../server/natural-language/swap-intent-resolver";
import type {
  SwapIntentDraft,
  SwapIntentError,
} from "../server/natural-language/swap-intent-types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Person = { userId: number; professionalId: number; name: string };

const slots = (text: string): SwapIntentDraft => {
  const parsed = parseSwapIntent(text);
  if ("ok" in parsed) throw new Error(`parser falhou: ${parsed.code} ${parsed.message}`);
  return parsed;
};

describe("resolveSwapIntent — localização escopada ao ator e ao tenant", () => {
  let db: Db;
  const stamp = Date.now();
  // Quarta 09/09/2026, 12:00 BRT.
  const now = new Date("2026-09-09T15:00:00Z");
  const at = (date: string, time: string) => new Date(`${date}T${time}-03:00`);

  let tenantA: number;
  let tenantB: number;
  let hospitalA: number;
  let hospitalB: number;
  let recoveryA: number;
  let pinkRoomA: number;
  let surgeryA: number;
  let recoveryB: number;

  let actor: Person;
  let daniloSouza: Person;
  let daniloPereira: Person;
  let germana: Person;

  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const shiftIds: number[] = [];

  async function makeTenant(label: string) {
    const suffix = `${stamp}${label}`;
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `NL Tenant ${suffix}`,
        cnpj: suffix.slice(-14).padStart(14, "0"),
        legalName: `NL Tenant ${suffix}`,
        tradeName: `NL${label}`,
        isActive: true,
      })
      .$returningId();
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId: institution.id, name: `NL Hospital ${suffix}` })
      .$returningId();
    return { institutionId: institution.id, hospitalId: hospital.id };
  }

  async function makeSector(
    institutionId: number,
    hospitalId: number,
    name: string,
  ) {
    const [sector] = await db
      .insert(sectors)
      .values({ institutionId, hospitalId, name, category: "cirurgico", color: "#2563EB" })
      .$returningId();
    return sector.id;
  }

  async function makePerson(
    label: string,
    name: string,
    institutionIds: number[],
  ): Promise<Person> {
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `nl-${label}-${stamp}@example.test`,
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
    for (const institutionId of institutionIds) {
      await db.insert(professionalInstitutions).values({
        professionalId: professional.id,
        userId: user.id,
        institutionId,
        roleInInstitution: "USER",
        active: true,
      });
    }
    return { userId: user.id, professionalId: professional.id, name };
  }

  async function makeShift(input: {
    owner: Person;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    date: string;
    start: string;
    end: string;
    label: string;
    isActive?: boolean;
    status?: string;
  }) {
    const startAt = at(input.date, input.start);
    const endAt = at(input.date, input.end);
    if (endAt <= startAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
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
        status: input.status ?? "OCUPADO",
        isActive: input.isActive ?? true,
      })
      .$returningId();
    return { shiftInstanceId: shift.id, assignmentId: assignment.id };
  }

  const actorScope = (institutionIds: number[]): SwapIntentActor => ({
    userId: actor.userId,
    professionalId: actor.professionalId,
    institutionIds,
  });

  const resolve = (
    text: string,
    institutionIds: number[],
    options: ResolveSwapIntentOptions = {},
  ) => resolveSwapIntent(slots(text), actorScope(institutionIds), { now, ...options });

  const expectError = async (
    text: string,
    institutionIds: number[],
    options: ResolveSwapIntentOptions = {},
  ): Promise<SwapIntentError> => {
    const result = await resolve(text, institutionIds, options);
    if (result.ok) throw new Error("esperava erro, veio intenção resolvida");
    return result;
  };

  let ownTomorrowNight: { shiftInstanceId: number; assignmentId: number };
  let daniloDayAfterNight: { shiftInstanceId: number };

  beforeAll(async () => {
    db = (await getDb())!;
    if (!db) throw new Error("Database not available");

    const a = await makeTenant("A");
    const b = await makeTenant("B");
    tenantA = a.institutionId;
    hospitalA = a.hospitalId;
    tenantB = b.institutionId;
    hospitalB = b.hospitalId;

    recoveryA = await makeSector(tenantA, hospitalA, "Sala de Recuperação");
    pinkRoomA = await makeSector(tenantA, hospitalA, "Sala Rosa");
    surgeryA = await makeSector(tenantA, hospitalA, "Centro Cirúrgico");
    recoveryB = await makeSector(tenantB, hospitalB, "Sala de Recuperação");

    actor = await makePerson("actor", `NL Ator ${stamp}`, [tenantA, tenantB]);
    daniloSouza = await makePerson("danilo1", `Danilo Souza ${stamp}`, [tenantA]);
    daniloPereira = await makePerson("danilo2", `Danilo Pereira ${stamp}`, [tenantA]);
    germana = await makePerson("germana", `Germana Medeiros ${stamp}`, [tenantA]);

    const inA = { institutionId: tenantA, hospitalId: hospitalA };

    // Amanhã (10/09): noite na Recuperação + manhã no Centro Cirúrgico.
    ownTomorrowNight = await makeShift({ owner: actor, ...inA, sectorId: recoveryA, date: "2026-09-10", start: "19:00:00", end: "07:00:00", label: "Noite" });
    await makeShift({ owner: actor, ...inA, sectorId: surgeryA, date: "2026-09-10", start: "07:00:00", end: "13:00:00", label: "Manhã" });

    // Hoje de manhã já começou (agora é 12:00 BRT).
    await makeShift({ owner: actor, ...inA, sectorId: recoveryA, date: "2026-09-09", start: "07:00:00", end: "13:00:00", label: "Manhã" });

    // Dois setores "SR-like" no mesmo dia e turno → ambiguidade de setor.
    await makeShift({ owner: actor, ...inA, sectorId: recoveryA, date: "2026-09-14", start: "19:00:00", end: "07:00:00", label: "Noite" });
    await makeShift({ owner: actor, ...inA, sectorId: pinkRoomA, date: "2026-09-14", start: "19:00:00", end: "07:00:00", label: "Noite" });

    // Alocação inativa: existe a linha, mas não conta.
    await makeShift({ owner: actor, ...inA, sectorId: recoveryA, date: "2026-09-15", start: "19:00:00", end: "07:00:00", label: "Noite", isActive: false });

    // Alocação ainda PENDENTE: o domínio exige OCUPADO, então também não conta.
    await makeShift({ owner: actor, ...inA, sectorId: recoveryA, date: "2026-09-16", start: "19:00:00", end: "07:00:00", label: "Noite", status: "PENDENTE" });

    // Multi-instituição: 17/09 só no tenant B; 18/09 nos dois.
    await makeShift({ owner: actor, institutionId: tenantB, hospitalId: hospitalB, sectorId: recoveryB, date: "2026-09-17", start: "19:00:00", end: "07:00:00", label: "Noite" });
    await makeShift({ owner: actor, ...inA, sectorId: recoveryA, date: "2026-09-18", start: "19:00:00", end: "07:00:00", label: "Noite" });
    await makeShift({ owner: actor, institutionId: tenantB, hospitalId: hospitalB, sectorId: recoveryB, date: "2026-09-18", start: "19:00:00", end: "07:00:00", label: "Noite" });

    // Contrapartidas do Danilo Souza no tenant A.
    daniloDayAfterNight = await makeShift({ owner: daniloSouza, ...inA, sectorId: recoveryA, date: "2026-09-11", start: "19:00:00", end: "07:00:00", label: "Noite" });
    await makeShift({ owner: daniloSouza, ...inA, sectorId: recoveryA, date: "2026-09-19", start: "19:00:00", end: "07:00:00", label: "Noite" });
    await makeShift({ owner: daniloSouza, ...inA, sectorId: surgeryA, date: "2026-09-19", start: "19:00:00", end: "07:00:00", label: "Noite" });
  });

  afterAll(async () => {
    if (!db) return;
    if (shiftIds.length) {
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    if (professionalIds.length) {
      await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    }
    await db.delete(sectors).where(inArray(sectors.id, [recoveryA, pinkRoomA, surgeryA, recoveryB]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalA, hospitalB]));
    await db.delete(institutions).where(inArray(institutions.id, [tenantA, tenantB]));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  });

  describe("plantão próprio", () => {
    it("dia + turno + setor resolvem um único plantão", async () => {
      const result = await resolve(
        "passo meu plantão de amanhã à noite na SR pro Danilo Souza",
        [tenantA],
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.ownShift.shiftInstanceId).toBe(ownTomorrowNight.shiftInstanceId);
      expect(result.ownShift.assignmentId).toBe(ownTomorrowNight.assignmentId);
      expect(result.ownShift.sectorName).toBe("Sala de Recuperação");
      expect(result.ownShift.dayKey).toBe("2026-09-10");
      expect(result.ownShift.timeRange).toBe("19:00–07:00");
      expect(result.institutionId).toBe(tenantA);
    });

    it("nenhum plantão no dia", async () => {
      const error = await expectError("passo meu plantão de 25/09 pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("OWN_SHIFT_NOT_FOUND");
    });

    it("dois plantões no dia sem turno dito → pergunta qual", async () => {
      const error = await expectError("passo meu plantão de amanhã pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("AMBIGUOUS_OWN_SHIFT");
      expect(error.message).toContain("Qual deles?");
      expect(error.shiftCandidates).toHaveLength(2);
      expect(error.shiftCandidates?.map((c) => c.label).sort()).toEqual(["Manhã", "Noite"]);
    });

    it("escolha explícita depois da pergunta resolve", async () => {
      const result = await resolve("passo meu plantão de amanhã pro Danilo Souza", [tenantA], {
        chosenOwnShiftInstanceId: ownTomorrowNight.shiftInstanceId,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.ownShift.shiftInstanceId).toBe(ownTomorrowNight.shiftInstanceId);
    });

    it("plantão já iniciado não é cedível nem trocável", async () => {
      const error = await expectError("passo meu plantão de hoje de manhã pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("OWN_SHIFT_NOT_FOUND");
      expect(error.message).toContain("já começou");
    });

    it("alocação inativa não conta", async () => {
      const error = await expectError("passo meu plantão de 15/09 à noite pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("OWN_SHIFT_NOT_FOUND");
    });

    it("alocação ainda não OCUPADO não conta — o domínio a rejeitaria", async () => {
      const error = await expectError("passo meu plantão de 16/09 à noite pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("OWN_SHIFT_NOT_FOUND");
    });

    it("turno sem plantão explica o que existe no dia", async () => {
      const error = await expectError("passo meu plantão de amanhã à tarde pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("OWN_SHIFT_NOT_FOUND");
      expect(error.message).toContain("tarde");
    });
  });

  describe("setor", () => {
    it("dois setores SR-like no mesmo turno → ambiguidade, nunca escolha", async () => {
      const error = await expectError("passo meu plantão de 14/09 à noite na SR pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("AMBIGUOUS_SECTOR");
      expect(error.sectorCandidates?.map((s) => s.name).sort()).toEqual([
        "Sala Rosa",
        "Sala de Recuperação",
      ]);
    });

    it("setor inexistente no tenant", async () => {
      const error = await expectError("passo meu plantão de amanhã à noite na Hemodinâmica pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("SECTOR_NOT_FOUND");
    });

    it("setor existe mas sem plantão seu ali é outra pergunta", async () => {
      const error = await expectError("passo meu plantão de amanhã à noite no Centro Cirúrgico pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("OWN_SHIFT_NOT_FOUND");
      expect(error.sectorCandidates?.[0].name).toBe("Centro Cirúrgico");
    });

    it("nome completo do setor resolve igual à sigla", async () => {
      const result = await resolve(
        "passo meu plantão de amanhã à noite na Sala de Recuperação pro Danilo Souza",
        [tenantA],
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.ownShift.shiftInstanceId).toBe(ownTomorrowNight.shiftInstanceId);
    });
  });

  describe("instituição vem do plantão, nunca da frase", () => {
    it("plantão fora do escopo do canal não é encontrado", async () => {
      const error = await expectError("passo meu plantão de 17/09 à noite pro Danilo Souza", [tenantA]);
      expect(error.code).toBe("OWN_SHIFT_NOT_FOUND");
    });

    it("multi-instituição inequívoco resolve a instituição do plantão", async () => {
      const result = await resolveSwapIntent(
        slots("passo meu plantão de 17/09 à noite pra Germana Medeiros"),
        actorScope([tenantA, tenantB]),
        { now },
      );
      // O colega está só no tenant A, então a cadeia falha no colega — mas
      // a instituição já foi decidida pelo plantão, que é o ponto aqui.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("TARGET_PROFESSIONAL_NOT_FOUND");
    });

    it("multi-instituição ambíguo não elege a instituição ativa", async () => {
      const error = await expectError("passo meu plantão de 18/09 à noite pro Danilo Souza", [tenantA, tenantB]);
      expect(error.code).toBe("AMBIGUOUS_OWN_SHIFT");
      expect(error.message).toContain("mais de uma instituição");
      expect(new Set(error.shiftCandidates?.map((c) => c.institutionId))).toEqual(
        new Set([tenantA, tenantB]),
      );
    });

    it("sem vínculo ativo na instituição pedida falha fechado", async () => {
      const error = await expectError("passo meu plantão de amanhã à noite pro Danilo Souza", [-1]);
      expect(error.code).toBe("NOT_ELIGIBLE");
    });
  });

  describe("colega", () => {
    it("nome completo resolve", async () => {
      const result = await resolve("passo meu plantão de amanhã à noite na SR pro Danilo Souza", [tenantA]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.targetProfessional.professionalId).toBe(daniloSouza.professionalId);
    });

    it("dois Danilos → pergunta qual, nunca escolhe", async () => {
      const error = await expectError("passo meu plantão de amanhã à noite na SR pro Danilo", [tenantA]);
      expect(error.code).toBe("AMBIGUOUS_TARGET_PROFESSIONAL");
      expect(error.professionalCandidates).toHaveLength(2);
      expect(new Set(error.professionalCandidates?.map((c) => c.professionalId))).toEqual(
        new Set([daniloSouza.professionalId, daniloPereira.professionalId]),
      );
    });

    it("escolha explícita do colega resolve", async () => {
      const result = await resolve("passo meu plantão de amanhã à noite na SR pro Danilo", [tenantA], {
        chosenTargetProfessionalId: daniloPereira.professionalId,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.targetProfessional.professionalId).toBe(daniloPereira.professionalId);
    });

    it("colega inexistente", async () => {
      const error = await expectError("passo meu plantão de amanhã à noite na SR pro Ronaldo", [tenantA]);
      expect(error.code).toBe("TARGET_PROFESSIONAL_NOT_FOUND");
    });

    it("o próprio ator nunca é o colega", async () => {
      const error = await expectError(`passo meu plantão de amanhã à noite na SR pro NL Ator ${stamp}`, [tenantA]);
      expect(error.code).toBe("TARGET_PROFESSIONAL_NOT_FOUND");
    });
  });

  describe("contrapartida da troca", () => {
    it("dia e turno da contrapartida resolvem o plantão do colega", async () => {
      const result = await resolve(
        "troco meu plantão de amanhã à noite na SR com o plantão do Danilo Souza depois de amanhã à noite",
        [tenantA],
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe("SWAP");
      if (result.kind !== "SWAP") return;
      expect(result.targetShift.shiftInstanceId).toBe(daniloDayAfterNight.shiftInstanceId);
      expect(result.ownShift.shiftInstanceId).toBe(ownTomorrowNight.shiftInstanceId);
    });

    // A distinção que o §2 dos ajustes pediu: ausência ≠ inexistência.
    it("contrapartida não dita pede a informação, com candidatos", async () => {
      const error = await expectError(
        "troco meu plantão de amanhã à noite na SR com o Danilo Souza",
        [tenantA],
      );
      expect(error.code).toBe("SWAP_TARGET_SHIFT_REQUIRED");
      expect(error.message).toContain("Qual plantão de Danilo");
      expect((error.shiftCandidates?.length ?? 0) > 0).toBe(true);
      // Nunca oferece o próprio plantão como contrapartida.
      expect(error.shiftCandidates?.map((c) => c.shiftInstanceId)).not.toContain(
        ownTomorrowNight.shiftInstanceId,
      );
    });

    it("contrapartida dita e inexistente é TARGET_SHIFT_NOT_FOUND", async () => {
      const error = await expectError(
        "troco meu plantão de amanhã à noite na SR com o plantão do Danilo Souza dia 26/09 à noite",
        [tenantA],
      );
      expect(error.code).toBe("TARGET_SHIFT_NOT_FOUND");
    });

    it("plantão que não é do colega não vira contrapartida", async () => {
      // 14/09 à noite existe, mas é do ator — não do Danilo.
      const error = await expectError(
        "troco meu plantão de amanhã à noite na SR com o plantão do Danilo Souza dia 14/09 à noite",
        [tenantA],
      );
      expect(error.code).toBe("TARGET_SHIFT_NOT_FOUND");
    });

    it("duas contrapartidas no mesmo turno → pergunta qual", async () => {
      const error = await expectError(
        "troco meu plantão de amanhã à noite na SR com o plantão do Danilo Souza dia 19/09 à noite",
        [tenantA],
      );
      expect(error.code).toBe("AMBIGUOUS_TARGET_SHIFT");
      expect(error.shiftCandidates).toHaveLength(2);
    });

    it("escolha explícita da contrapartida resolve", async () => {
      const result = await resolve(
        "troco meu plantão de amanhã à noite na SR com o plantão do Danilo Souza dia 19/09 à noite",
        [tenantA],
        { chosenTargetShiftInstanceId: undefined },
      );
      expect(result.ok).toBe(false);
      const chosen = await expectError(
        "troco meu plantão de amanhã à noite na SR com o plantão do Danilo Souza dia 19/09 à noite",
        [tenantA],
      );
      const candidate = chosen.shiftCandidates![0];
      const second = await resolve(
        "troco meu plantão de amanhã à noite na SR com o plantão do Danilo Souza dia 19/09 à noite",
        [tenantA],
        { chosenTargetShiftInstanceId: candidate.shiftInstanceId },
      );
      expect(second.ok).toBe(true);
      if (second.ok && second.kind === "SWAP") {
        expect(second.targetShift.shiftInstanceId).toBe(candidate.shiftInstanceId);
      }
    });

    it("CESSAO deixa a ausência de contrapartida explícita", async () => {
      const result = await resolve("passo meu plantão de amanhã à noite na SR pro Danilo Souza", [tenantA]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe("CESSAO");
      expect(result.targetShift).toBeNull();
    });
  });
});
