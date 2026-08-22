// tests/next-shift.test.ts — shifts.getNextShift: em andamento tem
// prioridade; senão o próximo futuro; passados não contam; sem plantão → null.

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
import { shiftsRouter } from "../server/shifts-crud";

describe("shifts.getNextShift", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let userId: number;
  let professionalId: number;
  let otherUserId: number;
  let otherProfessionalId: number;
  const shiftIds: number[] = [];

  const caller = (uid: number) =>
    shiftsRouter.createCaller({
      user: { id: uid, role: "doctor", name: "Teste", email: "t@test.local" },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  const hoursFromNow = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);

  async function mkShift(start: Date, end: Date, label: string, pro: number) {
    const [s] = await db!
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, label, startAt: start, endAt: end, status: "OCUPADO", createdBy: userId })
      .$returningId();
    await db!.insert(shiftAssignmentsV2).values({
      shiftInstanceId: s.id, institutionId, hospitalId, sectorId, professionalId: pro,
      assignmentType: "ON_DUTY", status: "OCUPADO", isActive: true, createdBy: userId,
    });
    shiftIds.push(s.id);
    return s.id;
  }

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");
    const stamp = Date.now();
    const [inst] = await db.insert(institutions).values({
      name: `Next Tenant ${stamp}`, cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
      legalName: `Next Tenant ${stamp}`, tradeName: `NX${stamp}`.slice(0, 20), isActive: true,
    }).$returningId();
    institutionId = inst.id;
    const [h] = await db.insert(hospitals).values({ institutionId, name: `Next Hospital ${stamp}` }).$returningId();
    hospitalId = h.id;
    const [sec] = await db.insert(sectors).values({ institutionId, hospitalId, name: `Next Setor ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    sectorId = sec.id;

    const mk = async (tag: string) => {
      const [u] = await db!.insert(users).values({ name: `Next ${tag}`, email: `next-${tag}-${stamp}@test.local`, passwordHash: "test", role: "doctor" }).$returningId();
      const [p] = await db!.insert(professionals).values({ userId: u.id, name: `Next ${tag}`, role: "Médico", userRole: "USER" }).$returningId();
      await db!.insert(professionalInstitutions).values({ professionalId: p.id, userId: u.id, institutionId, roleInInstitution: "USER", isPrimary: true, active: true });
      return { userId: u.id, professionalId: p.id };
    };
    const me = await mk("eu");
    userId = me.userId; professionalId = me.professionalId;
    const other = await mk("outro");
    otherUserId = other.userId; otherProfessionalId = other.professionalId;
  });

  afterAll(async () => {
    if (!db) return;
    if (shiftIds.length) {
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    await db.delete(professionalInstitutions).where(eq(professionalInstitutions.institutionId, institutionId));
    await db.delete(professionals).where(inArray(professionals.id, [professionalId, otherProfessionalId]));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
  });

  it("sem plantão futuro → null", async () => {
    expect(await caller(userId).getNextShift()).toBeNull();
  });

  it("ignora plantão passado e devolve o próximo futuro, com setor/hospital", async () => {
    await mkShift(hoursFromNow(-30), hoursFromNow(-18), "Passado", professionalId);
    const futureId = await mkShift(hoursFromNow(30), hoursFromNow(42), "Futuro", professionalId);
    await mkShift(hoursFromNow(60), hoursFromNow(72), "Depois", professionalId);
    const r = await caller(userId).getNextShift();
    expect(r?.id).toBe(futureId);
    expect(r?.inProgress).toBe(false);
    expect(r?.sectorName).toContain("Next Setor");
    expect(r?.hospitalName).toContain("Next Hospital");
  });

  it("plantão em andamento tem prioridade sobre o futuro", async () => {
    const nowId = await mkShift(hoursFromNow(-2), hoursFromNow(4), "Agora", professionalId);
    const r = await caller(userId).getNextShift();
    expect(r?.id).toBe(nowId);
    expect(r?.inProgress).toBe(true);
  });

  it("não vaza plantão de outro profissional", async () => {
    await mkShift(hoursFromNow(1), hoursFromNow(7), "Do outro", otherProfessionalId);
    const r = await caller(userId).getNextShift();
    expect(r?.label).toBe("Agora");
    const o = await caller(otherUserId).getNextShift();
    expect(o?.label).toBe("Do outro");
  });
});
