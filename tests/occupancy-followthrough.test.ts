import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
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
  hashLegacyScheduleInviteCode,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";
import { getDb } from "../server/db";
import { editorRouter } from "../server/editor";
import { appRouter } from "../server/routers";
import { dayKeyBrt, yearMonthBrt } from "../server/local-time";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";

describe("follow-through #422: lista de ocupação ⊆ write", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let institutionBId: number;
  let hospitalId: number;
  let hospitalBId: number;
  let allowlistSectorId: number;
  let emptySectorId: number;
  let allCfmSectorId: number;
  let sectorBId: number;
  let allowlistContextId: number;
  let emptyContextId: number;
  let allCfmContextId: number;
  let contextBId: number;
  let anesthesiaId: number;
  let plusUserId: number;
  let plusProfessionalId: number;
  let userUserId: number;
  let userProfessionalId: number;
  let allowlistShiftId: number;
  let emptyShiftId: number;
  let allCfmShiftId: number;
  let foreignShiftId: number;
  let profileSectorId: number;
  let profileContextId: number;
  let profileShiftId: number;
  let residentUserId: number;
  let residentProfessionalId: number;
  let medicoUserId: number;
  let medicoProfessionalId: number;
  let inviteeUserId: number;
  let inviteeProfessionalId: number;
  let vacancyDate: string;

  const plusCaller = () =>
    appRouter.createCaller({
      user: {
        id: plusUserId,
        role: "manager",
        name: "PLUS",
        email: `plus-${stamp}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  const plusEditor = () =>
    editorRouter.createCaller({
      user: {
        id: plusUserId,
        role: "manager",
        name: "PLUS",
        email: `plus-${stamp}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  const userCaller = () =>
    appRouter.createCaller({
      user: {
        id: userUserId,
        role: "doctor",
        name: "USER",
        email: `user-${stamp}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  const managerEditor = () =>
    editorRouter.createCaller({
      user: {
        id: plusUserId,
        role: "manager",
        name: "PLUS",
        email: `plus-${stamp}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  const residentCaller = () =>
    appRouter.createCaller({
      user: {
        id: residentUserId,
        role: "doctor",
        name: "RESIDENTE",
        email: `resident-${stamp}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  const medicoCaller = () =>
    appRouter.createCaller({
      user: {
        id: medicoUserId,
        role: "manager",
        name: "GESTOR_MEDICO",
        email: `medico-${stamp}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  const inviteeCaller = () =>
    appRouter.createCaller({
      user: {
        id: inviteeUserId,
        role: "doctor",
        name: "CONVITE",
        email: `invitee-${stamp}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  async function insertShift(input: {
    sectorId: number;
    scheduleContextId: number;
    label: string;
    hospital?: number;
    institution?: number;
  }) {
    const startAt = new Date();
    startAt.setUTCDate(startAt.getUTCDate() + 14);
    startAt.setUTCHours(13, 0, 0, 0);
    const endAt = new Date(startAt);
    endAt.setUTCHours(19, 0, 0, 0);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: input.institution ?? institutionId,
        hospitalId: input.hospital ?? hospitalId,
        sectorId: input.sectorId,
        scheduleContextId: input.scheduleContextId,
        label: input.label,
        startAt,
        endAt,
        status: "VAGO",
      })
      .$returningId();
    return shift.id;
  }

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `FT Occupancy ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `FT Occupancy ${stamp}`,
        tradeName: `FT${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [institutionB] = await db
      .insert(institutions)
      .values({
        name: `FT Occupancy B ${stamp}`,
        cnpj: `${stamp + 1}`.toString().slice(-14).padStart(14, "0"),
        legalName: `FT Occupancy B ${stamp}`,
        tradeName: `FTB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = institutionB.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `FT Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [hospitalB] = await db
      .insert(hospitals)
      .values({
        institutionId: institutionBId,
        name: `FT Hospital B ${stamp}`,
      })
      .$returningId();
    hospitalBId = hospitalB.id;

    const insertSector = async (
      name: string,
      hid = hospitalId,
      iid = institutionId,
    ) => {
      const [sector] = await db
        .insert(sectors)
        .values({
          institutionId: iid,
          hospitalId: hid,
          name,
          category: "cirurgico",
          color: "#2563EB",
        })
        .$returningId();
      return sector.id;
    };

    allowlistSectorId = await insertSector(`FT Allowlist ${stamp}`);
    emptySectorId = await insertSector(`FT Empty ${stamp}`);
    allCfmSectorId = await insertSector(`FT AllCfm ${stamp}`);
    profileSectorId = await insertSector(`FT Profile ${stamp}`);
    sectorBId = await insertSector(
      `FT Sector B ${stamp}`,
      hospitalBId,
      institutionBId,
    );

    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);

    const [allowlistContext] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId: allowlistSectorId,
        admissionPolicy: "QUALIFICATION_ALLOWLIST",
        active: true,
      })
      .$returningId();
    allowlistContextId = allowlistContext.id;
    await db.insert(scheduleContextAllowedQualifications).values({
      scheduleContextId: allowlistContextId,
      medicalSpecialtyId: anesthesiaId,
    });

    const [emptyContext] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId: emptySectorId,
        admissionPolicy: "QUALIFICATION_ALLOWLIST",
        active: true,
      })
      .$returningId();
    emptyContextId = emptyContext.id;

    const [profileContext] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId: profileSectorId,
        admissionPolicy: "PINNED_QUALIFICATION",
        operationalProfileCode: "RESIDENTE_ANESTESIOLOGIA",
        medicalSpecialtyId: null,
        active: true,
      })
      .$returningId();
    profileContextId = profileContext.id;

    allCfmContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: allCfmSectorId,
    });
    contextBId = await openTestScale(db, {
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
    });

    const [plusUser] = await db
      .insert(users)
      .values({
        name: `FT PLUS ${stamp}`,
        email: `plus-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    plusUserId = plusUser.id;
    const [plusPro] = await db
      .insert(professionals)
      .values({
        userId: plusUserId,
        name: `FT PLUS ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_PLUS",
        medicalSpecialtyId: null,
      })
      .$returningId();
    plusProfessionalId = plusPro.id;
    await db.insert(professionalInstitutions).values({
      professionalId: plusProfessionalId,
      userId: plusUserId,
      institutionId,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });

    const [user] = await db
      .insert(users)
      .values({
        name: `FT USER ${stamp}`,
        email: `user-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    userUserId = user.id;
    const [userPro] = await db
      .insert(professionals)
      .values({
        userId: userUserId,
        name: `FT USER ${stamp}`,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    userProfessionalId = userPro.id;
    await db.insert(professionalInstitutions).values({
      professionalId: userProfessionalId,
      userId: userUserId,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    await db.insert(professionalAccess).values([
      {
        institutionId,
        professionalId: userProfessionalId,
        hospitalId,
        sectorId: allowlistSectorId,
        canAccess: true,
      },
      {
        institutionId,
        professionalId: userProfessionalId,
        hospitalId,
        sectorId: emptySectorId,
        canAccess: true,
      },
      {
        institutionId,
        professionalId: userProfessionalId,
        hospitalId,
        sectorId: allCfmSectorId,
        canAccess: true,
      },
      {
        institutionId,
        professionalId: userProfessionalId,
        hospitalId,
        sectorId: profileSectorId,
        canAccess: true,
      },
    ]);

    const [residentUser] = await db
      .insert(users)
      .values({
        name: `FT RESIDENTE ${stamp}`,
        email: `resident-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    residentUserId = residentUser.id;
    const [residentPro] = await db
      .insert(professionals)
      .values({
        userId: residentUserId,
        name: `FT RESIDENTE ${stamp}`,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: null,
        operationalProfileCode: "RESIDENTE_ANESTESIOLOGIA",
      })
      .$returningId();
    residentProfessionalId = residentPro.id;
    await db.insert(professionalInstitutions).values({
      professionalId: residentProfessionalId,
      userId: residentUserId,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: residentProfessionalId,
      hospitalId,
      sectorId: profileSectorId,
      canAccess: true,
    });

    const [medicoUser] = await db
      .insert(users)
      .values({
        name: `FT MEDICO ${stamp}`,
        email: `medico-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    medicoUserId = medicoUser.id;
    const [medicoPro] = await db
      .insert(professionals)
      .values({
        userId: medicoUserId,
        name: `FT MEDICO ${stamp}`,
        role: "Médico",
        userRole: "GESTOR_MEDICO",
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    medicoProfessionalId = medicoPro.id;
    await db.insert(professionalInstitutions).values({
      professionalId: medicoProfessionalId,
      userId: medicoUserId,
      institutionId,
      roleInInstitution: "GESTOR_MEDICO",
      isPrimary: true,
      active: true,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: medicoProfessionalId,
      hospitalId,
      sectorId: allowlistSectorId,
      active: true,
    });

    const [inviteeUser] = await db
      .insert(users)
      .values({
        name: `FT CONVITE ${stamp}`,
        email: `invitee-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    inviteeUserId = inviteeUser.id;
    const [inviteePro] = await db
      .insert(professionals)
      .values({
        userId: inviteeUserId,
        name: `FT CONVITE ${stamp}`,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    inviteeProfessionalId = inviteePro.id;
    await db.insert(professionalInstitutions).values({
      professionalId: inviteeProfessionalId,
      userId: inviteeUserId,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    const inviteExpires = new Date();
    inviteExpires.setUTCDate(inviteExpires.getUTCDate() + 7);
    await db.insert(scheduleInvites).values({
      institutionId,
      hospitalId,
      sectorId: allowlistSectorId,
      codeHash: hashLegacyScheduleInviteCode(
        normalizeScheduleInviteCode(generateScheduleInviteCode()),
      ),
      codeHashVersion: "SHA256_V1",
      createdByUserId: plusUserId,
      invitedUserId: inviteeUserId,
      maxRedemptions: 1,
      expiresAt: inviteExpires,
    });

    allowlistShiftId = await insertShift({
      sectorId: allowlistSectorId,
      scheduleContextId: allowlistContextId,
      label: `FT allowlist ${stamp}`,
    });
    emptyShiftId = await insertShift({
      sectorId: emptySectorId,
      scheduleContextId: emptyContextId,
      label: `FT empty ${stamp}`,
    });
    allCfmShiftId = await insertShift({
      sectorId: allCfmSectorId,
      scheduleContextId: allCfmContextId,
      label: `FT allcfm ${stamp}`,
    });
    foreignShiftId = await insertShift({
      sectorId: sectorBId,
      scheduleContextId: contextBId,
      label: `FT foreign ${stamp}`,
      hospital: hospitalBId,
      institution: institutionBId,
    });
    profileShiftId = await insertShift({
      sectorId: profileSectorId,
      scheduleContextId: profileContextId,
      label: `FT profile ${stamp}`,
    });
    const [localShift] = await db
      .select({ startAt: shiftInstances.startAt })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, allowlistShiftId))
      .limit(1);
    vacancyDate = dayKeyBrt(localShift.startAt);
    await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: yearMonthBrt(localShift.startAt),
      status: "PUBLISHED",
    });
  });

  beforeEach(async () => {
    await db
      .delete(shiftAssignmentsV2)
      .where(
        eq(shiftAssignmentsV2.institutionId, institutionId),
      );
    await db
      .update(professionals)
      .set({ medicalSpecialtyId: null, specialty: null })
      .where(eq(professionals.id, plusProfessionalId));
    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
      .where(
        eq(shiftInstances.institutionId, institutionId),
      );
  });

  afterAll(async () => {
    // Fixtures são isolados por stamp; não apagar shift_instances aqui —
    // notifications/audit podem referenciar o turno.
  });

  it("T1 GESTOR_PLUS sem specialty não ocupa", async () => {
    await expect(
      plusEditor().assignDirect({
        shiftInstanceId: allowlistShiftId,
        professionalId: plusProfessionalId,
        assignmentType: "ON_DUTY",
        reason: "PLUS sem especialidade",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Profissional sem qualificação compatível com a escala do plantão.",
    });
    await expect(
      plusCaller().shiftAssignments.assumeVacancy({
        shiftInstanceId: allowlistShiftId,
        assignmentType: "ON_DUTY",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Profissional sem qualificação compatível com a escala do plantão.",
    });
  });

  it("T2 GESTOR_PLUS qualificado ocupa e aparece na actionability", async () => {
    await db
      .update(professionals)
      .set({
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .where(eq(professionals.id, plusProfessionalId));

    const assigned = await plusEditor().assignDirect({
      shiftInstanceId: allowlistShiftId,
      professionalId: plusProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "PLUS qualificado",
    });
    expect(assigned.ok).toBe(true);

    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, allowlistShiftId));
    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
      .where(eq(shiftInstances.id, allowlistShiftId));

    const vacancies = await plusCaller().shiftInstances.listVacancies({ date: vacancyDate });
    const ids = vacancies.map((row) => row.shiftInstanceId);
    expect(ids).toContain(allowlistShiftId);
    expect(ids).toContain(allCfmShiftId);
    expect(ids).toContain(emptyShiftId);
    expect(ids).not.toContain(foreignShiftId);
    expect(ids).not.toContain(profileShiftId);
    expect(vacancies.every((row) => row.canAssume === true)).toBe(true);
  });

  it("T5 allowlist vazia preserva ocupação com ACL setorial e credencial", async () => {
    const vacancies = await userCaller().shiftInstances.listVacancies({ date: vacancyDate });
    expect(vacancies.map((row) => row.shiftInstanceId)).toContain(
      emptyShiftId,
    );
    expect(vacancies.map((row) => row.shiftInstanceId)).not.toContain(
      profileShiftId,
    );
    await expect(
      managerEditor().assignDirect({
        shiftInstanceId: emptyShiftId,
        professionalId: userProfessionalId,
        assignmentType: "ON_DUTY",
        reason: "allowlist ainda não configurada",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("T6 ALL_CFM com especialidade CFM ocupa", async () => {
    const result = await managerEditor().assignDirect({
      shiftInstanceId: allCfmShiftId,
      professionalId: userProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "ALL_CFM legítimo",
    });
    expect(result.ok).toBe(true);
  });

  it("vagas PLUS sem specialty não oferecem CTA; write recusa depois de lista stale", async () => {
    const emptyList = await plusCaller().shiftInstances.listVacancies({ date: vacancyDate });
    expect(emptyList.map((row) => row.shiftInstanceId)).not.toContain(
      allowlistShiftId,
    );

    await db
      .update(professionals)
      .set({
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .where(eq(professionals.id, plusProfessionalId));
    const listed = await plusCaller().shiftInstances.listVacancies({ date: vacancyDate });
    expect(listed.map((row) => row.shiftInstanceId)).toContain(allowlistShiftId);

    await db
      .update(professionals)
      .set({ medicalSpecialtyId: null, specialty: null })
      .where(eq(professionals.id, plusProfessionalId));
    await expect(
      plusCaller().shiftAssignments.assumeVacancy({
        shiftInstanceId: allowlistShiftId,
        assignmentType: "ON_DUTY",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Profissional sem qualificação compatível com a escala do plantão.",
    });
  });

  it("picker de alocação não lista inelegível; convite/ACL qualificado permanece", async () => {
    await db
      .update(professionals)
      .set({
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .where(eq(professionals.id, plusProfessionalId));
    const rows = await plusCaller().professionals.listAssignableForShift({
      shiftInstanceId: allowlistShiftId,
    });
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(userProfessionalId);
    expect(ids).not.toContain(plusProfessionalId);
  });

  it("perfil operacional PINNED ocupa e aparece; especialidade CFM não entra", async () => {
    const occupied = await managerEditor().assignDirect({
      shiftInstanceId: profileShiftId,
      professionalId: residentProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "residente PINNED",
    });
    expect(occupied.ok).toBe(true);

    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, profileShiftId));
    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
      .where(eq(shiftInstances.id, profileShiftId));

    await expect(
      managerEditor().assignDirect({
        shiftInstanceId: profileShiftId,
        professionalId: userProfessionalId,
        assignmentType: "ON_DUTY",
        reason: "CFM em PINNED de residente",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Profissional sem qualificação compatível com a escala do plantão.",
    });

    const residentVacancies = await residentCaller().shiftInstances.listVacancies(
      { date: vacancyDate },
    );
    expect(residentVacancies.map((row) => row.shiftInstanceId)).toContain(
      profileShiftId,
    );
    const userVacancies = await userCaller().shiftInstances.listVacancies({ date: vacancyDate });
    expect(userVacancies.map((row) => row.shiftInstanceId)).not.toContain(
      profileShiftId,
    );
  });

  it("GESTOR_MEDICO com manager_scope e especialidade vê vaga acionável", async () => {
    const vacancies = await medicoCaller().shiftInstances.listVacancies({ date: vacancyDate });
    const ids = vacancies.map((row) => row.shiftInstanceId);
    expect(ids).toContain(allowlistShiftId);
    expect(ids).not.toContain(allCfmShiftId);
    expect(ids).not.toContain(foreignShiftId);
  });

  it("convite pendente com especialidade correta aparece e assume", async () => {
    const vacancies = await inviteeCaller().shiftInstances.listVacancies({ date: vacancyDate });
    expect(vacancies.map((row) => row.shiftInstanceId)).toContain(
      allowlistShiftId,
    );
    const assumed = await inviteeCaller().shiftAssignments.assumeVacancy({
      shiftInstanceId: allowlistShiftId,
      assignmentType: "ON_DUTY",
    });
    expect(assumed).toMatchObject({ ok: true });
  });
});
