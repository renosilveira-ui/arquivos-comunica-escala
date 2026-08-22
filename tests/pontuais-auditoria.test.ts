// tests/pontuais-auditoria.test.ts — auditoria 22/08, achados M3, B1 e B2.
//
// M3  professionals.getByUserId: gestor só lê profissional com vínculo
//     ativo na instituição do contexto.
// B1  shiftAssignments.listPending: só quem aprova; gestor de hospital só
//     vê a própria jurisdição.
// B2  createContext não lança para usuário sem vínculo — requireUser
//     responde FORBIDDEN com a mensagem certa.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { createContext } from "../server/_core/context";
import { sdk } from "../server/_core/sdk";
import { professionalsRouter } from "../server/aux-routers";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";

describe("pontuais da auditoria: escopo de tenant, jurisdição e contexto", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let instA: number;
  let instB: number;
  let hospA1: number;
  let hospA2: number;
  let secA1: number;
  let secA2: number;
  // instituição A: gestor+ (plus), gestor de hospital A1 (medico), user comum (doc)
  let plusUserId: number;
  let medicoUserId: number;
  let medicoProId: number;
  let docUserId: number;
  let docProId: number;
  // instituição B: profissional só de B
  let bUserId: number;
  let bProId: number;
  // sem vínculo ativo
  let orphanUserId: number;
  const userIds: number[] = [];
  const proIds: number[] = [];

  const ctx = (userId: number, role: "manager" | "doctor" | "admin", institutionId: number) =>
    ({ user: { id: userId, role, name: "T", email: `${userId}@t.local` }, institutionId, allowedInstitutionIds: [institutionId] }) as any;

  async function person(tag: string, role: "manager" | "doctor", institutionId: number, link: "GESTOR_MEDICO" | "GESTOR_PLUS" | "USER", access?: { hospitalId: number; sectorId: number }) {
    const [u] = await db.insert(users).values({ name: `PA ${tag} ${stamp}`, email: `pa-${tag}-${stamp}@test.local`, passwordHash: "test", role }).$returningId();
    const [p] = await db.insert(professionals).values({ userId: u.id, name: `PA ${tag} ${stamp}`, role: "Médico", userRole: link }).$returningId();
    await db.insert(professionalInstitutions).values({ professionalId: p.id, userId: u.id, institutionId, roleInInstitution: link, isPrimary: true, active: true });
    if (access) await db.insert(professionalAccess).values({ institutionId, professionalId: p.id, hospitalId: access.hospitalId, sectorId: access.sectorId, canAccess: true });
    userIds.push(u.id);
    proIds.push(p.id);
    return { userId: u.id, proId: p.id };
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const mkInst = async (tag: string) => {
      const [i] = await db
        .insert(institutions)
        .values({ name: `PA ${tag} ${stamp}`, cnpj: `${stamp}${tag === "A" ? 1 : 2}`.slice(-14).padStart(14, "0"), legalName: `PA ${tag}`, tradeName: `PA${tag}${stamp}`.slice(0, 20), isActive: true })
        .$returningId();
      return i.id;
    };
    instA = await mkInst("A");
    instB = await mkInst("B");
    const [h1] = await db.insert(hospitals).values({ institutionId: instA, name: `PA H1 ${stamp}` }).$returningId();
    const [h2] = await db.insert(hospitals).values({ institutionId: instA, name: `PA H2 ${stamp}` }).$returningId();
    hospA1 = h1.id;
    hospA2 = h2.id;
    const [s1] = await db.insert(sectors).values({ institutionId: instA, hospitalId: hospA1, name: `PA S1 ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    const [s2] = await db.insert(sectors).values({ institutionId: instA, hospitalId: hospA2, name: `PA S2 ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    secA1 = s1.id;
    secA2 = s2.id;

    plusUserId = (await person("plus", "manager", instA, "GESTOR_PLUS")).userId;
    const medico = await person("medico", "manager", instA, "GESTOR_MEDICO");
    medicoUserId = medico.userId;
    medicoProId = medico.proId;
    await db.insert(managerScope).values({ institutionId: instA, managerProfessionalId: medicoProId, hospitalId: hospA1, sectorId: secA1, active: true });
    const doc = await person("doc", "doctor", instA, "USER", { hospitalId: hospA1, sectorId: secA1 });
    docUserId = doc.userId;
    docProId = doc.proId;
    const b = await person("b", "doctor", instB, "USER");
    bUserId = b.userId;
    bProId = b.proId;
    const [orphan] = await db.insert(users).values({ name: `PA orphan ${stamp}`, email: `pa-orphan-${stamp}@test.local`, passwordHash: "test", role: "doctor" }).$returningId();
    orphanUserId = orphan.id;
    userIds.push(orphanUserId);

    // Dois turnos em A com alocação PENDENTE do doc: um no H1 (jurisdição
    // do gestor de hospital) e um no H2 (fora).
    const start = new Date();
    start.setDate(start.getDate() + 3);
    start.setHours(7, 0, 0, 0);
    const end = new Date(start);
    end.setHours(13, 0, 0, 0);
    for (const [h, sec] of [
      [hospA1, secA1],
      [hospA2, secA2],
    ] as const) {
      const [si] = await db.insert(shiftInstances).values({ institutionId: instA, hospitalId: h, sectorId: sec, label: `PA ${stamp}`, startAt: start, endAt: end, status: "PENDENTE" }).$returningId();
      await db.insert(shiftAssignmentsV2).values({ shiftInstanceId: si.id, institutionId: instA, hospitalId: h, sectorId: sec, professionalId: docProId, assignmentType: "ON_DUTY", status: "PENDENTE", isActive: true, createdBy: docUserId });
    }
  });

  afterAll(async () => {
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, instA));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, proIds));
    await db.delete(managerScope).where(eq(managerScope.managerProfessionalId, medicoProId));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, proIds));
    await db.delete(professionals).where(inArray(professionals.id, proIds));
    await db.delete(sectors).where(inArray(sectors.id, [secA1, secA2]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospA1, hospA2]));
    await db.delete(institutions).where(inArray(institutions.id, [instA, instB]));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("M3: gestor de A não lê profissional que só tem vínculo em B; lê o da própria instituição", async () => {
    const plus = professionalsRouter.createCaller(ctx(plusUserId, "manager", instA));
    expect(await plus.getByUserId({ userId: bUserId })).toBeNull();
    const mine = await plus.getByUserId({ userId: docUserId });
    expect(mine?.id).toBe(docProId);
    // O próprio usuário continua lendo o próprio cadastro.
    const self = professionalsRouter.createCaller(ctx(bUserId, "doctor", instB));
    expect((await self.getByUserId({ userId: bUserId }))?.id).toBe(bProId);
  });

  it("B1: USER não lista pendências; gestor de hospital vê só a jurisdição; Gestor+ vê tudo", async () => {
    const asDoc = appRouter.createCaller(ctx(docUserId, "doctor", instA));
    await expect(asDoc.shiftAssignments.listPending({})).rejects.toMatchObject({ code: "FORBIDDEN" });

    const asMedico = appRouter.createCaller(ctx(medicoUserId, "manager", instA));
    const scoped = await asMedico.shiftAssignments.listPending({});
    expect(scoped.map((r) => r.hospitalId)).toEqual([hospA1]);

    const asPlus = appRouter.createCaller(ctx(plusUserId, "manager", instA));
    const all = await asPlus.shiftAssignments.listPending({});
    expect(all.map((r) => r.hospitalId).sort()).toEqual([hospA1, hospA2].sort());
  });

  it("B2: usuário sem vínculo → contexto sem tenant (sem 500) e FORBIDDEN claro no procedimento", async () => {
    const [orphan] = await db.select().from(users).where(eq(users.id, orphanUserId));
    const spy = vi.spyOn(sdk, "authenticateRequest").mockResolvedValue(orphan as any);
    try {
      const context = await createContext({ req: { headers: {} }, res: {} } as any);
      expect(context.user?.id).toBe(orphanUserId);
      expect(context.institutionId).toBeNull();
      await expect(appRouter.createCaller(context).professionals.listMyInstitutions()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Usuário sem vínculo institucional ativo",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
