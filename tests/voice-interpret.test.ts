// tests/voice-interpret.test.ts — comando de voz: datas relativas, dias
// da semana, números por extenso, títulos, verbos; e resolução contra
// plantões reais ("hoje", "próxima sexta", "meu próximo plantão").

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
import {
  parsePeriod,
  parseVoiceCommand,
  periodOfStart,
  resolveSwapCommand,
  resolveVoiceDate,
  type ParsedCommand,
} from "../server/voice/interpret";

const parse = (t: string) => parseVoiceCommand(t) as ParsedCommand;

describe("parseVoiceCommand — datas", () => {
  it('"hoje" → offset 0', () => {
    const p = parse("trocar meu plantão de hoje à noite com o João");
    expect(p.kind).toBe("TROCA");
    expect(p.date).toMatchObject({ kind: "offset", days: 0 });
    expect(p.period).toBe("noite");
    expect(p.targetName).toBe("joao");
  });

  it('"amanhã" e "depois de amanhã"', () => {
    expect(parse("passar o plantão de amanhã para a Maria").date).toMatchObject({ kind: "offset", days: 1 });
    expect(parse("passar o plantão de depois de amanhã para a Maria").date).toMatchObject({ kind: "offset", days: 2 });
    // "amanhã" não vira turno "manhã"
    expect(parse("passar o plantão de amanhã para a Maria").period).toBeNull();
  });

  it("dia da semana, com e sem 'próxima' / 'que vem'", () => {
    expect(parse("ceder meu plantão de sexta com o Pedro").date).toMatchObject({ kind: "weekday", weekday: 5, forceNext: false });
    expect(parse("ceder meu plantão da próxima sexta com o Pedro").date).toMatchObject({ kind: "weekday", weekday: 5, forceNext: true });
    expect(parse("ceder meu plantão de terça-feira que vem com o Pedro").date).toMatchObject({ kind: "weekday", weekday: 2, forceNext: true });
    expect(parse("ceder meu plantão de sábado com o Pedro").date).toMatchObject({ kind: "weekday", weekday: 6 });
  });

  it("dia do mês: 'dia 2', '2 de setembro', '02/09', 'dia vinte e um'", () => {
    expect(parse("trocar dia 2 à noite com o João").date).toMatchObject({ kind: "absolute", day: 2, month: null });
    expect(parse("trocar meu plantão de 2 de setembro com o João").date).toMatchObject({ kind: "absolute", day: 2, month: 9 });
    expect(parse("trocar meu plantão de 02/09 com o João").date).toMatchObject({ kind: "absolute", day: 2, month: 9 });
    expect(parse("trocar meu plantão do dia vinte e um com o João").date).toMatchObject({ kind: "absolute", day: 21, month: null });
    expect(parse("trocar meu plantão do dia primeiro de outubro com o João").date).toMatchObject({ kind: "absolute", day: 1, month: 10 });
  });

  it('"meu próximo plantão"', () => {
    expect(parse("passar meu próximo plantão para o Carlos").date).toMatchObject({ kind: "next-shift" });
  });

  it("sem data → pede o dia com exemplos", () => {
    const p = parseVoiceCommand("trocar meu plantão com o João");
    expect(p.kind).toBe("FALHA");
    expect((p as any).reason).toContain("hoje");
  });
});

describe("parseVoiceCommand — turno, colega e verbos", () => {
  it("turnos: de manhã / à tarde / à noite / madrugada / cedo", () => {
    expect(parse("trocar hoje de manhã com o João").period).toBe("manha");
    expect(parse("trocar hoje à tarde com o João").period).toBe("tarde");
    expect(parse("trocar hoje de madrugada com o João").period).toBe("noite");
    expect(parse("trocar hoje cedo com o João").period).toBe("manha");
  });

  it("títulos são ignorados e o nome para na palavra de contexto", () => {
    expect(parse("trocar meu plantão de hoje com o Dr. João Silva").targetName).toBe("joao silva");
    expect(parse("passar para a doutora Maria o plantão de sexta").targetName).toBe("maria");
    expect(parse("trocar com a Ana Paula dia 2").targetName).toBe("ana paula");
    expect(parse("troca de plantão entre eu e Carlos Eduardo hoje").targetName).toBe("carlos eduardo");
  });

  it("verbos: dar / oferecer / repassar / transferir", () => {
    for (const t of [
      "dar meu plantão de hoje para o João",
      "oferecer meu plantão de hoje para o João",
      "repassar o plantão de amanhã pro João",
      "transferir o plantão de sexta pra Maria",
    ]) {
      expect(parseVoiceCommand(t).kind).toBe("TROCA");
    }
  });

  it("sem verbo ou sem colega → falhas claras", () => {
    expect(parseVoiceCommand("meu plantão de hoje").kind).toBe("FALHA");
    const noTarget = parseVoiceCommand("trocar meu plantão de hoje");
    expect(noTarget.kind).toBe("FALHA");
    expect((noTarget as any).reason).toContain("com quem");
  });
});

describe("resolveVoiceDate", () => {
  // Quarta-feira 2026-09-09 12:00 BRT = 15:00Z
  const now = new Date("2026-09-09T15:00:00Z");
  const ok = (d: any) => {
    const r = resolveVoiceDate(d, now);
    if (!r.ok) throw new Error(r.error);
    return `${r.target.y}-${String(r.target.m).padStart(2, "0")}-${String(r.target.d).padStart(2, "0")}`;
  };

  it("hoje / amanhã / depois de amanhã", () => {
    expect(ok({ kind: "offset", days: 0, said: "hoje" })).toBe("2026-09-09");
    expect(ok({ kind: "offset", days: 1, said: "amanhã" })).toBe("2026-09-10");
    expect(ok({ kind: "offset", days: 2, said: "" })).toBe("2026-09-11");
  });

  it("ontem → já passou", () => {
    const r = resolveVoiceDate({ kind: "offset", days: -1, said: "ontem" }, now);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("já passou");
  });

  it("dia da semana: próxima ocorrência; 'próxima' pula a de hoje", () => {
    expect(ok({ kind: "weekday", weekday: 5, forceNext: false, said: "" })).toBe("2026-09-11"); // sexta
    expect(ok({ kind: "weekday", weekday: 3, forceNext: false, said: "" })).toBe("2026-09-09"); // quarta = hoje
    expect(ok({ kind: "weekday", weekday: 3, forceNext: true, said: "" })).toBe("2026-09-16"); // próxima quarta
    expect(ok({ kind: "weekday", weekday: 1, forceNext: false, said: "" })).toBe("2026-09-14"); // segunda
  });

  it("dia do mês: sem mês usa o próximo dia N; com mês passado vai para o ano que vem", () => {
    expect(ok({ kind: "absolute", day: 20, month: null, said: "" })).toBe("2026-09-20");
    expect(ok({ kind: "absolute", day: 2, month: null, said: "" })).toBe("2026-10-02");
    expect(ok({ kind: "absolute", day: 2, month: 9, said: "" })).toBe("2027-09-02");
    expect(ok({ kind: "absolute", day: 15, month: 12, said: "" })).toBe("2026-12-15");
    const bad = resolveVoiceDate({ kind: "absolute", day: 31, month: 11, said: "" }, now);
    expect(bad.ok).toBe(false);
  });
});

describe("resolveSwapCommand — contra plantões reais", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let me: { userId: number; professionalId: number };
  let colleague: { userId: number; professionalId: number; name: string };
  const shiftIds: number[] = [];

  // "Agora" fixo num dia útil: quarta 2026-09-09 12:00 BRT.
  const now = new Date("2026-09-09T15:00:00Z");
  const at = (date: string, time: string) => new Date(`${date}T${time}-03:00`);

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");
    const stamp = Date.now();
    const [inst] = await db.insert(institutions).values({
      name: `Voz Tenant ${stamp}`, cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
      legalName: `Voz Tenant ${stamp}`, tradeName: `VZ${stamp}`.slice(0, 20), isActive: true,
    }).$returningId();
    institutionId = inst.id;
    const [hosp] = await db.insert(hospitals).values({ institutionId, name: `Voz Hospital ${stamp}` }).$returningId();
    hospitalId = hosp.id;
    const [sec] = await db.insert(sectors).values({ institutionId, hospitalId, name: `Voz Setor ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    sectorId = sec.id;

    const mk = async (tag: string, name: string) => {
      const [u] = await db!.insert(users).values({ name, email: `voz-${tag}-${stamp}@test.local`, passwordHash: "test", role: "doctor" }).$returningId();
      const [p] = await db!.insert(professionals).values({ userId: u.id, name, role: "Médico", userRole: "USER", specialty: "Anestesiologia" }).$returningId();
      await db!.insert(professionalInstitutions).values({ professionalId: p.id, userId: u.id, institutionId, roleInInstitution: "USER", isPrimary: true, active: true });
      return { userId: u.id, professionalId: p.id, name };
    };
    me = await mk("eu", `Voz Eu ${stamp}`);
    colleague = await mk("colega", `Germana Medeiros ${stamp}`);

    const mkShift = async (date: string, label: string, start: string, end: string) => {
      const startAt = at(date, start);
      const endAt = at(date, end);
      if (endAt <= startAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
      const [s] = await db!.insert(shiftInstances).values({ institutionId, hospitalId, sectorId, label, specialty: "Anestesiologia", startAt, endAt, status: "OCUPADO", createdBy: me.userId }).$returningId();
      await db!.insert(shiftAssignmentsV2).values({ shiftInstanceId: s.id, institutionId, hospitalId, sectorId, professionalId: me.professionalId, assignmentType: "ON_DUTY", status: "OCUPADO", isActive: true, createdBy: me.userId });
      shiftIds.push(s.id);
      return s.id;
    };
    await mkShift("2026-09-09", "Noite", "19:00:00", "07:00:00"); // hoje à noite
    await mkShift("2026-09-11", "Manhã", "07:00:00", "13:00:00"); // sexta de manhã
    await mkShift("2026-09-11", "Tarde", "13:00:00", "19:00:00"); // sexta à tarde
  });

  afterAll(async () => {
    if (!db) return;
    if (shiftIds.length) {
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    await db.delete(professionalInstitutions).where(eq(professionalInstitutions.institutionId, institutionId));
    await db.delete(professionals).where(inArray(professionals.id, [me.professionalId, colleague.professionalId]));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [me.userId, colleague.userId]));
  });

  const ctx = () => ({ userId: me.userId, professionalId: me.professionalId, institutionId, now });

  it('"hoje" resolve o único plantão do dia sem precisar do turno', async () => {
    const r = await resolveSwapCommand(parse("trocar meu plantão de hoje com a Germana"), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action.dateStr).toBe("09/09");
    expect(r.action.shiftLabel).toBe("Noite");
    expect(r.action.toProfessionalId).toBe(colleague.professionalId);
    expect(r.confirmationText).toContain("quarta, 09/09");
  });

  it('"sexta de manhã" acha o turno certo; "sexta" sem turno pede o turno', async () => {
    const ok = await resolveSwapCommand(parse("passar o plantão de sexta de manhã para a Germana"), ctx());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.action.dateStr).toBe("11/09");
    const amb = await resolveSwapCommand(parse("passar o plantão de sexta para a Germana"), ctx());
    expect(amb.ok).toBe(false);
    if (!amb.ok) expect(amb.error).toContain("diga o turno");
  });

  it('"amanhã" sem plantão → mensagem natural', async () => {
    const r = await resolveSwapCommand(parse("trocar meu plantão de amanhã com a Germana"), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Você não tem plantão amanhã.");
  });

  it('"meu próximo plantão" pega o primeiro plantão futuro', async () => {
    const r = await resolveSwapCommand(parse("passar meu próximo plantão para a Germana"), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action.shiftLabel).toBe("Noite");
  });

  it('"ontem" → já passou', async () => {
    const r = await resolveSwapCommand(parse("trocar meu plantão de ontem com a Germana"), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("já passou");
  });
});

describe("parsePeriod — 'cedo' como turno × verbo ceder", () => {
  it("'hoje cedo' / 'amanhã cedo' / 'bem cedo' são manhã", () => {
    expect(parsePeriod("trocar hoje cedo com o joao")).toBe("manha");
    expect(parsePeriod("trocar amanha cedo")).toBe("manha");
    expect(parsePeriod("trocar bem cedo")).toBe("manha");
  });
  it("'cedo meu plantão de hoje à noite' é o verbo ceder: turno da noite", () => {
    expect(parsePeriod("cedo meu plantao de hoje a noite")).toBe("noite");
    expect(parsePeriod("cedo meu plantao de amanha")).toBeNull();
    expect(parseVoiceCommand("cedo meu plantão de hoje à noite para o João")).toMatchObject({ kind: "TROCA", period: "noite", targetName: "joao" });
  });
});

describe("periodOfStart — turno pelo horário de início no relógio do hospital", () => {
  it("classifica por faixa, não por hora exata", () => {
    expect(periodOfStart(new Date("2026-09-10T10:00:00.000Z"))).toBe("manha"); // 07:00 BRT
    expect(periodOfStart(new Date("2026-09-10T11:30:00.000Z"))).toBe("manha"); // 08:30 BRT
    expect(periodOfStart(new Date("2026-09-10T16:00:00.000Z"))).toBe("tarde"); // 13:00 BRT
    expect(periodOfStart(new Date("2026-09-10T20:00:00.000Z"))).toBe("tarde"); // 17:00 BRT
    expect(periodOfStart(new Date("2026-09-10T22:00:00.000Z"))).toBe("noite"); // 19:00 BRT
    expect(periodOfStart(new Date("2026-09-11T01:00:00.000Z"))).toBe("noite"); // 22:00 BRT
  });
});
