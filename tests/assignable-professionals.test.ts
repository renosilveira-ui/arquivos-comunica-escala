import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";

describe("professionals.listAssignableForShift", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let availableProfessionalId: number;
  let assignedProfessionalId: number;
  let noAccessProfessionalId: number;
  let shiftInstanceId: number;

  async function createUserProfessional(stamp: number, label: string, roleInInstitution = "USER") {
    const [user] = await db
      .insert(users)
      .values({
        name: `Assignable ${label} ${stamp}`,
        email: `assignable-${label}-${stamp}@test.local`,
        passwordHash: "test",
        role: roleInInstitution === "GESTOR_MEDICO" ? "manager" : "doctor",
      })
      .$returningId();

    const [pro] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name: `Assignable ${label} ${stamp}`,
        role: "Médico",
        userRole: roleInInstitution as "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS",
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

    const manager = await createUserProfessional(stamp, "Manager", "GESTOR_MEDICO");
    managerUserId = manager.userId;
    managerProfessionalId = manager.professionalId;

    const available = await createUserProfessional(stamp, "Available");
    availableProfessionalId = available.professionalId;

    const assigned = await createUserProfessional(stamp, "AlreadyAssigned");
    assignedProfessionalId = assigned.professionalId;

    const noAccess = await createUserProfessional(stamp, "NoAccess");
    noAccessProfessionalId = noAccess.professionalId;

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
    ]);

    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
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
  });

  it("lista somente profissionais com acesso ao setor e ainda não alocados", async () => {
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
    expect(ids).not.toContain(assignedProfessionalId);
    expect(ids).not.toContain(noAccessProfessionalId);
    expect(rows[0]).toMatchObject({ id: availableProfessionalId, name: expect.any(String) });

    const [shift] = await db
      .select()
      .from(shiftInstances)
      .where(and(eq(shiftInstances.id, shiftInstanceId), eq(shiftInstances.institutionId, institutionId)));
    expect(shift?.id).toBe(shiftInstanceId);
  });
});
