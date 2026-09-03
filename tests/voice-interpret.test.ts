// tests/voice-interpret.test.ts — comando de voz sobre o núcleo compartilhado.
//
// Regressão obrigatória desta frente: "trocar" NUNCA pode virar cessão.
// Antes, o parser devolvia um único kind e `buildResolved` fixava
// CESSAO_DIRECIONADA, então "trocar meu plantão de hoje com a Germana"
// criava uma cessão — o médico entregava o plantão sem contrapartida.
//
// A interpretação em si (datas, turnos, setor, nomes) é testada em
// tests/swap-intent-parser.test.ts e tests/swap-intent-resolver.test.ts.
// Aqui provamos o CONTRATO do endpoint: forma da resposta, autoridade do
// tipo no servidor e o gate fail-closed para cliente antigo.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
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
import { interpretVoiceSwapCommand } from "../server/voice/interpret";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Person = { userId: number; professionalId: number; name: string };

describe("voice.interpret — adapter do núcleo compartilhado", () => {
  let db: Db;
  const stamp = Date.now();
  // Quarta 09/09/2026, 12:00 BRT = 15:00Z.
  const now = new Date("2026-09-09T15:00:00Z");
  const at = (date: string, time: string) => new Date(`${date}T${time}-03:00`);

  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let me: Person;
  let colleague: Person;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const shiftIds: number[] = [];

  let myNightToday: number;
  let colleagueNightFriday: number;

  async function makePerson(label: string, name: string): Promise<Person> {
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `voz-${label}-${stamp}@example.test`,
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
      institutionId,
      roleInInstitution: "USER",
      active: true,
    });
    return { userId: user.id, professionalId: professional.id, name };
  }

  async function makeShift(owner: Person, date: string, label: string, start: string, end: string) {
    const startAt = at(date, start);
    const endAt = at(date, end);
    if (endAt <= startAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label,
        specialty: "Anestesiologia",
        startAt,
        endAt,
        status: "OCUPADO",
      })
      .$returningId();
    shiftIds.push(shift.id);
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shift.id,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: owner.professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    return shift.id;
  }

  /** Cliente novo: anuncia que sabe materializar troca e cessão. */
  const interpret = (text: string, extra: Record<string, unknown> = {}) =>
    interpretVoiceSwapCommand({
      text,
      actor: { userId: me.userId, professionalId: me.professionalId, institutionId },
      supportedOfferTypes: ["SWAP", "CESSAO"],
      now,
      ...extra,
    });

  /** Cliente antigo: não anuncia nada, então só executa cessão. */
  const interpretLegacyClient = (text: string) =>
    interpretVoiceSwapCommand({
      text,
      actor: { userId: me.userId, professionalId: me.professionalId, institutionId },
      now,
    });

  beforeAll(async () => {
    db = (await getDb())!;
    if (!db) throw new Error("Database not available");
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Voz Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Voz Tenant ${stamp}`,
        tradeName: `VZ${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Voz Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({ institutionId, hospitalId, name: "Sala de Recuperação", category: "cirurgico", color: "#2563EB" })
      .$returningId();
    sectorId = sector.id;

    me = await makePerson("eu", `Voz Eu ${stamp}`);
    colleague = await makePerson("colega", `Germana Medeiros ${stamp}`);

    myNightToday = await makeShift(me, "2026-09-09", "Noite", "19:00:00", "07:00:00");
    await makeShift(me, "2026-09-11", "Manhã", "07:00:00", "13:00:00");
    await makeShift(me, "2026-09-11", "Tarde", "13:00:00", "19:00:00");
    colleagueNightFriday = await makeShift(colleague, "2026-09-11", "Noite", "19:00:00", "07:00:00");
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
    await db.delete(sectors).where(inArray(sectors.id, [sectorId]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalId]));
    await db.delete(institutions).where(inArray(institutions.id, [institutionId]));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  });

  describe("troca ≠ cessão", () => {
    // O teste que esta frente existe para garantir.
    it('"trocar ... com o plantão do colega" devolve SWAP com contrapartida', async () => {
      const result = await interpret(
        "trocar meu plantão de hoje à noite com o plantão da Germana de sexta à noite",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.action.type).toBe("SWAP");
      expect(result.action.fromShiftInstanceId).toBe(myNightToday);
      expect(result.action.toShiftInstanceId).toBe(colleagueNightFriday);
      expect(result.action.toProfessionalId).toBe(colleague.professionalId);
      expect(result.confirmationText).toContain("Trocar seu plantão");
    });

    it("nenhuma forma de trocar devolve uma ação de cessão", async () => {
      for (const phrase of [
        "trocar meu plantão de hoje à noite com a Germana",
        "troca meu plantão de hoje com a Germana",
        "troco meu plantão de hoje à noite com a Germana",
        "permutar meu plantão de hoje à noite com a Germana",
      ]) {
        const result = await interpret(phrase);
        if (result.ok) {
          expect(result.action.type).not.toBe("CESSAO");
        } else {
          // Sem contrapartida dita, o servidor PERGUNTA — nunca cede.
          expect(result.code).toBe("SWAP_TARGET_SHIFT_REQUIRED");
        }
      }
    });

    it('"passar ... para o colega" devolve CESSAO sem contrapartida', async () => {
      const result = await interpret("passar meu plantão de hoje à noite para a Germana");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.action.type).toBe("CESSAO");
      expect(result.action.toShiftInstanceId).toBeUndefined();
      expect(result.action.fromShiftInstanceId).toBe(myNightToday);
      expect(result.confirmationText).toContain("Passar seu plantão");
    });

    it("troca sem contrapartida dita pergunta qual plantão entra, com candidatos", async () => {
      const result = await interpret("trocar meu plantão de hoje à noite com a Germana");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("SWAP_TARGET_SHIFT_REQUIRED");
      expect(result.error).toContain("Qual plantão de Germana");
      expect(result.shiftCandidates?.map((c) => c.shiftInstanceId)).toContain(
        colleagueNightFriday,
      );
    });
  });

  describe("gate de capacidade do cliente (fail-closed)", () => {
    it("cliente antigo pedindo troca recebe erro claro, não uma cessão", async () => {
      const result = await interpretLegacyClient(
        "trocar meu plantão de hoje à noite com o plantão da Germana de sexta à noite",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("UNSUPPORTED_INTENT");
      expect(result.error).toContain("Atualize o app");
    });

    it("cliente antigo continua cedendo plantão normalmente", async () => {
      const result = await interpretLegacyClient("passar meu plantão de hoje à noite para a Germana");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.action.type).toBe("CESSAO");
    });
  });

  describe("contrato da resposta", () => {
    it("a ação traz o que o app precisa para chamar swaps.offer", async () => {
      const result = await interpret("passar meu plantão de hoje à noite para a Germana");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.action.shiftLabel).toBe("Noite");
      expect(result.action.dateStr).toBe("09/09");
      expect(result.action.timeRange).toBe("19:00–07:00");
      expect(result.action.sectorName).toBe("Sala de Recuperação");
      expect(result.action.toProfessionalName).toContain("Germana");
      expect(result.action.fromAssignmentId).toBeTypeOf("number");
    });

    it("ambiguidade de turno vira pergunta com candidatos", async () => {
      const result = await interpret("passar meu plantão de sexta para a Germana");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("AMBIGUOUS_OWN_SHIFT");
      expect(result.shiftCandidates).toHaveLength(2);
    });

    it("escolha do plantão por toque resolve a ambiguidade", async () => {
      const ambiguous = await interpret("passar meu plantão de sexta para a Germana");
      if (ambiguous.ok) throw new Error("esperava ambiguidade");
      const chosen = ambiguous.shiftCandidates![0];
      const result = await interpret("passar meu plantão de sexta para a Germana", {
        ownShiftInstanceId: chosen.shiftInstanceId,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.action.fromShiftInstanceId).toBe(chosen.shiftInstanceId);
    });

    it("dia sem plantão e comando incompreensível têm mensagens próprias", async () => {
      const noShift = await interpret("passar meu plantão de amanhã para a Germana");
      expect(noShift.ok).toBe(false);
      if (!noShift.ok) expect(noShift.code).toBe("OWN_SHIFT_NOT_FOUND");

      const nonsense = await interpret("meu plantão de hoje");
      expect(nonsense.ok).toBe(false);
      if (!nonsense.ok) expect(nonsense.code).toBe("UNSUPPORTED_INTENT");

      const noDate = await interpret("passar meu plantão para a Germana");
      expect(noDate.ok).toBe(false);
      if (!noDate.ok) expect(noDate.code).toBe("INVALID_DATE");
    });

    it("plantão que já começou não é interpretado como disponível", async () => {
      // "hoje de manhã" já passou às 12:00 BRT.
      const result = await interpret("passar meu plantão de hoje de manhã para a Germana");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("OWN_SHIFT_NOT_FOUND");
    });
  });
});
