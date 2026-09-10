// tests/next-shift.test.ts — shifts.getNextShift: em andamento tem
// prioridade; senão o próximo futuro; passados não contam; sem plantão → null.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  monthlyRosters,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { shiftsRouter } from "../server/shifts-crud";
import { yearMonthBrt } from "../server/local-time";

describe("shifts.getNextShift", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let userId: number;
  let professionalId: number;
  let otherUserId: number;
  let otherProfessionalId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let scheduleContextId: number;
  let yearMonth: string;
  const shiftIds: number[] = [];

  const caller = (uid: number) =>
    shiftsRouter.createCaller({
      user: { id: uid, role: "doctor", name: "Teste", email: "t@test.local" },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  const hoursFromNow = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);

  async function mkShift(
    start: Date,
    end: Date,
    label: string,
    pro: number,
    contextId?: number,
  ) {
    const [s] = await db!
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId: contextId,
        label,
        startAt: start,
        endAt: end,
        status: "OCUPADO",
        createdBy: userId,
      })
      .$returningId();
    await db!.insert(shiftAssignmentsV2).values({
      shiftInstanceId: s.id,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: pro,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
      createdBy: userId,
    });
    shiftIds.push(s.id);
    return s.id;
  }

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");
    const stamp = Date.now();
    const [inst] = await db
      .insert(institutions)
      .values({
        name: `Next Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Next Tenant ${stamp}`,
        tradeName: `NX${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Next Hospital ${stamp}` })
      .$returningId();
    hospitalId = h.id;
    yearMonth = yearMonthBrt(new Date());
    await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth,
      status: "PUBLISHED",
    });
    const [sec] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Next Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sec.id;
    const [context] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        active: true,
      })
      .$returningId();
    scheduleContextId = context.id;

    const mk = async (
      tag: string,
      roleInInstitution: "USER" | "GESTOR_PLUS" = "USER",
    ) => {
      const [u] = await db!
        .insert(users)
        .values({
          name: `Next ${tag}`,
          email: `next-${tag}-${stamp}@test.local`,
          passwordHash: "test",
          role: roleInInstitution === "USER" ? "doctor" : "manager",
        })
        .$returningId();
      const [p] = await db!
        .insert(professionals)
        .values({
          userId: u.id,
          name: `Next ${tag}`,
          role: "Médico",
          userRole: roleInInstitution,
        })
        .$returningId();
      await db!.insert(professionalInstitutions).values({
        professionalId: p.id,
        userId: u.id,
        institutionId,
        roleInInstitution,
        isPrimary: true,
        active: true,
      });
      return { userId: u.id, professionalId: p.id };
    };
    const me = await mk("eu");
    userId = me.userId;
    professionalId = me.professionalId;
    const other = await mk("outro");
    otherUserId = other.userId;
    otherProfessionalId = other.professionalId;
    const manager = await mk("gestor", "GESTOR_PLUS");
    managerUserId = manager.userId;
    managerProfessionalId = manager.professionalId;
  });

  afterAll(async () => {
    if (!db) return;
    if (shiftIds.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db
        .delete(shiftInstances)
        .where(inArray(shiftInstances.id, shiftIds));
    }
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    await db
      .delete(professionals)
      .where(
        inArray(professionals.id, [
          professionalId,
          otherProfessionalId,
          managerProfessionalId,
        ]),
      );
    await db
      .delete(scheduleContexts)
      .where(eq(scheduleContexts.id, scheduleContextId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db
      .delete(users)
      .where(inArray(users.id, [userId, otherUserId, managerUserId]));
  });

  it("sem plantão futuro → null", async () => {
    expect(await caller(userId).getNextShift()).toBeNull();
  });

  it("ignora plantão passado e devolve o próximo futuro, com setor/hospital", async () => {
    await mkShift(
      hoursFromNow(-30),
      hoursFromNow(-18),
      "Passado",
      professionalId,
    );
    const futureId = await mkShift(
      hoursFromNow(30),
      hoursFromNow(42),
      "Futuro",
      professionalId,
    );
    await mkShift(hoursFromNow(60), hoursFromNow(72), "Depois", professionalId);
    const r = await caller(userId).getNextShift();
    expect(r?.id).toBe(futureId);
    expect(r?.inProgress).toBe(false);
    expect(r?.sectorName).toContain("Next Setor");
    expect(r?.hospitalName).toContain("Next Hospital");
  });

  it("plantão em andamento tem prioridade sobre o futuro", async () => {
    const nowId = await mkShift(
      hoursFromNow(-2),
      hoursFromNow(4),
      "Agora",
      professionalId,
    );
    const r = await caller(userId).getNextShift();
    expect(r?.id).toBe(nowId);
    expect(r?.inProgress).toBe(true);
  });

  it("não vaza plantão de outro profissional", async () => {
    await mkShift(
      hoursFromNow(1),
      hoursFromNow(7),
      "Do outro",
      otherProfessionalId,
    );
    const r = await caller(userId).getNextShift();
    expect(r?.label).toBe("Agora");
    const o = await caller(otherUserId).getNextShift();
    expect(o?.label).toBe("Do outro");
  });

  it("oculta o plantão próprio em DRAFT e libera PUBLISHED/LOCKED", async () => {
    await mkShift(
      hoursFromNow(-1),
      hoursFromNow(3),
      "Agora gestor",
      managerProfessionalId,
      scheduleContextId,
    );
    await db!
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    await expect(caller(userId).getActiveShift()).resolves.toBeNull();
    await expect(caller(userId).getNextShift()).resolves.toBeNull();
    await expect(caller(managerUserId).getActiveShift()).resolves.toMatchObject(
      {
        label: "Agora gestor",
      },
    );
    await expect(caller(managerUserId).getNextShift()).resolves.toMatchObject({
      label: "Agora gestor",
    });

    await db!.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth,
      status: "DRAFT",
    });
    await expect(caller(userId).getActiveShift()).resolves.toBeNull();
    await expect(caller(userId).getNextShift()).resolves.toBeNull();

    await db!
      .update(monthlyRosters)
      .set({ status: "LOCKED" })
      .where(eq(monthlyRosters.institutionId, institutionId));
    await expect(caller(userId).getActiveShift()).resolves.toMatchObject({
      label: "Agora",
    });
    await expect(caller(userId).getNextShift()).resolves.toMatchObject({
      label: "Agora",
    });

    await db!
      .update(monthlyRosters)
      .set({ status: "PUBLISHED" })
      .where(eq(monthlyRosters.institutionId, institutionId));
  });
});
