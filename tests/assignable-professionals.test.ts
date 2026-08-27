import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContextAllowedQualifications,
  scheduleContexts,
  scheduleInvites,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  generateScheduleInviteCode,
  hashScheduleInviteCode,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import { redeemScheduleInviteInTransaction } from "../server/schedule-invites";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";

describe("professionals.listAssignableForShift", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let availableProfessionalId: number;
  let assignedProfessionalId: number;
  let hospitalWideProfessionalId: number;
  let crossSectorProfessionalId: number;
  let inviteeProfessionalId: number;
  let shiftInstanceId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;

  async function createUserProfessional(stamp: number, label: string, roleInInstitution = "USER") {
    const [user] = await db
      .insert(users)
      .values({
        name: `Assignable ${label} ${stamp}`,
        email: `assignable-${label}-${stamp}@test.local`,
        passwordHash: "test",
        role: roleInInstitution === "GESTOR_MEDICO" ? "manager" : "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();

    const [pro] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name: `Assignable ${label} ${stamp}`,
        role: "Médico",
        userRole: roleInInstitution as "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS",
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .$returningId();

    await db.insert(professionalInstitutions).values({
      professionalId: pro.id,
      userId: user.id,
      institutionId,
      roleInInstitution: roleInInstitution as "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });

    return { userId: user.id, professionalId: pro.id };
  }

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const stamp = Date.now();
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Assignable Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Assignable Tenant ${stamp}`,
        tradeName: `Assignable ${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Assignable Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;

    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Assignable Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    await db
      .update(scheduleContexts)
      .set({ admissionPolicy: "QUALIFICATION_ALLOWLIST" })
      .where(eq(scheduleContexts.id, scheduleContextId));
    await db.insert(scheduleContextAllowedQualifications).values({
      scheduleContextId,
      medicalSpecialtyId: anesthesiaId,
    });

    const manager = await createUserProfessional(stamp, "Manager", "GESTOR_MEDICO");
    managerUserId = manager.userId;
    managerProfessionalId = manager.professionalId;

    const available = await createUserProfessional(stamp, "Available");
    availableProfessionalId = available.professionalId;

    const assigned = await createUserProfessional(stamp, "AlreadyAssigned");
    assignedProfessionalId = assigned.professionalId;

    const hospitalWide = await createUserProfessional(stamp, "HospitalWide");
    hospitalWideProfessionalId = hospitalWide.professionalId;

    const crossSector = await createUserProfessional(stamp, "CrossSector");
    crossSectorProfessionalId = crossSector.professionalId;

    const invitee = await createUserProfessional(stamp, "Invitee");
    inviteeProfessionalId = invitee.professionalId;
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.professionalId, inviteeProfessionalId));
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Assignable Outro Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();

    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId,
      hospitalId,
      sectorId,
      active: true,
    });

    await db.insert(professionalAccess).values([
      { institutionId, professionalId: availableProfessionalId, hospitalId, sectorId, canAccess: true },
      { institutionId, professionalId: assignedProfessionalId, hospitalId, sectorId, canAccess: true },
      { institutionId, professionalId: hospitalWideProfessionalId, hospitalId, sectorId: null, canAccess: true },
      { institutionId, professionalId: crossSectorProfessionalId, hospitalId, sectorId: otherSector.id, canAccess: true },
    ]);

    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: "Plantão teste alocáveis",
        startAt: new Date(),
        endAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        status: "VAGO",
      })
      .$returningId();
    shiftInstanceId = shift.id;

    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: assignedProfessionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });

    const inviteCode = generateScheduleInviteCode();
    await db.insert(scheduleInvites).values({
      institutionId,
      hospitalId,
      sectorId,
      codeHash: hashScheduleInviteCode(normalizeScheduleInviteCode(inviteCode)),
      createdByUserId: managerUserId,
      invitedUserId: invitee.userId,
      maxRedemptions: 1,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.transaction(async (tx) => {
      await redeemScheduleInviteInTransaction(tx, {
        code: normalizeScheduleInviteCode(inviteCode),
        userId: invitee.userId,
        professionalId: inviteeProfessionalId,
        qualification: {
          medicalSpecialtyId: anesthesiaId,
          operationalProfileCode: null,
        },
      });
    });
  });

  it("inclui GESTOR_MEDICO com scope e convite resgatado; allowlist exige acesso setorial", async () => {
    const caller = appRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Manager",
        email: "manager@test.local",
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    const rows = await (caller.professionals as any).listAssignableForShift({
      shiftInstanceId,
    });
    const ids = rows.map((row: { id: number }) => row.id);

    expect(ids).toContain(availableProfessionalId);
    expect(ids).toContain(managerProfessionalId);
    expect(ids).toContain(inviteeProfessionalId);
    expect(ids).not.toContain(assignedProfessionalId);
    expect(ids).not.toContain(hospitalWideProfessionalId);
    expect(ids).not.toContain(crossSectorProfessionalId);
    expect(rows.find((row: { id: number }) => row.id === availableProfessionalId)).toMatchObject({
      id: availableProfessionalId,
      name: expect.any(String),
    });

    const [shift] = await db
      .select()
      .from(shiftInstances)
      .where(and(eq(shiftInstances.id, shiftInstanceId), eq(shiftInstances.institutionId, institutionId)));
    expect(shift?.id).toBe(shiftInstanceId);
  });
});
