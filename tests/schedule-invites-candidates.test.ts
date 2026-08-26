import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  medicalSpecialties,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import { ensureTestAnesthesiaSpecialty } from "./helpers/open-test-scale";

describe("scheduleInvites.listCandidates — sala de espera e busca por nome", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let managerUserId: number;
  let waitingUserId: number;
  let houseUserId: number;
  let alreadyInScaleUserId: number;
  let otherHouseUserId: number;
  let wrongSpecialtyUserId: number;

  async function createDoctor(input: {
    stamp: number;
    label: string;
    name: string;
    specialtyId: number;
    specialtyLabel: string;
    institutionId?: number;
  }) {
    const [user] = await db
      .insert(users)
      .values({
        name: input.name,
        email: `invite-cand-${input.label}-${input.stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    const [pro] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name: input.name,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: input.specialtyId,
        specialty: input.specialtyLabel,
      })
      .$returningId();
    if (input.institutionId != null) {
      await db.insert(professionalInstitutions).values({
        professionalId: pro.id,
        userId: user.id,
        institutionId: input.institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });
    }
    return { userId: user.id, professionalId: pro.id };
  }

  function caller() {
    return appRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Gestor candidatos",
        email: "gestor-cand@test.local",
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as never);
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const stamp = Date.now();

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Invite Cand Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Invite Cand ${stamp}`,
        tradeName: `IC${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [other] = await db
      .insert(institutions)
      .values({
        name: `Invite Cand Other ${stamp}`,
        cnpj: `${stamp}1`.slice(-14).padStart(14, "0"),
        legalName: `Invite Cand Other ${stamp}`,
        tradeName: `ICO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    otherInstitutionId = other.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Invite Cand Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;

    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Invite Cand Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;

    const anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    await db
      .insert(medicalSpecialties)
      .values({
        code: "CLINICA_MEDICA",
        name: "Clínica médica",
        sourceVersion: "CFM_2380_2024",
        active: true,
        sortOrder: 16,
      })
      .onDuplicateKeyUpdate({ set: { active: true } });
    const [clinica] = await db
      .select({ id: medicalSpecialties.id })
      .from(medicalSpecialties)
      .where(eq(medicalSpecialties.code, "CLINICA_MEDICA"));

    await db.insert(scheduleContexts).values({
      institutionId,
      hospitalId,
      sectorId,
      medicalSpecialtyId: anesthesiaId,
      admissionPolicy: "PINNED_QUALIFICATION",
      active: true,
    });

    const [managerUser] = await db
      .insert(users)
      .values({
        name: `Invite Cand Gestor ${stamp}`,
        email: `invite-cand-manager-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    managerUserId = managerUser.id;
    const [managerPro] = await db
      .insert(professionals)
      .values({
        userId: managerUserId,
        name: `Invite Cand Gestor ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_MEDICO",
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: managerPro.id,
      userId: managerUserId,
      institutionId,
      roleInInstitution: "GESTOR_MEDICO",
      isPrimary: true,
      active: true,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: managerPro.id,
      hospitalId,
      sectorId,
      active: true,
    });

    const waiting = await createDoctor({
      stamp,
      label: "waiting",
      name: "José da Silva Awaiting",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
    });
    waitingUserId = waiting.userId;

    const house = await createDoctor({
      stamp,
      label: "house",
      name: "Ana Casa Sem Setor",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
      institutionId,
    });
    houseUserId = house.userId;

    const already = await createDoctor({
      stamp,
      label: "already",
      name: "Bruno Já Na Escala",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
      institutionId,
    });
    alreadyInScaleUserId = already.userId;
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: already.professionalId,
      hospitalId,
      sectorId,
      canAccess: true,
    });

    const otherHouse = await createDoctor({
      stamp,
      label: "other",
      name: "Carla Outro Hospital",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
      institutionId: otherInstitutionId,
    });
    otherHouseUserId = otherHouse.userId;

    const wrong = await createDoctor({
      stamp,
      label: "wrong",
      name: "Diego Clínica Médica",
      specialtyId: clinica.id,
      specialtyLabel: "Clínica médica",
    });
    wrongSpecialtyUserId = wrong.userId;
  });

  it("mostra a sala de espera e a casa sem exigir e-mail; fecha o plantel de outro hospital", async () => {
    const rows = await caller().scheduleInvites.listCandidates({
      hospitalId,
      sectorId,
    });
    const ids = rows.map((row) => row.userId);

    expect(ids).toContain(waitingUserId);
    expect(ids).toContain(houseUserId);
    expect(ids).not.toContain(alreadyInScaleUserId);
    expect(ids).not.toContain(otherHouseUserId);
    expect(ids).not.toContain(wrongSpecialtyUserId);
    expect(rows.find((row) => row.userId === waitingUserId)?.name).toBe(
      "José da Silva Awaiting",
    );
    expect(rows[0]).not.toHaveProperty("email");
  });

  it("filtra por nome sem acento e sem maiúscula", async () => {
    const rows = await caller().scheduleInvites.listCandidates({
      hospitalId,
      sectorId,
      name: "jose",
    });
    const ids = rows.map((row) => row.userId);

    expect(ids).toContain(waitingUserId);
    expect(ids).not.toContain(houseUserId);
    expect(ids).not.toContain(otherHouseUserId);
  });
});
