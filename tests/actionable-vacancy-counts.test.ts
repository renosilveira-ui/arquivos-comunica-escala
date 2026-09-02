import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  scheduleInvites,
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import { openTestScale } from "./helpers/open-test-scale";

describe("Vagas acionáveis — lista e contadores", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionAId: number;
  let institutionBId: number;
  let hospitalAId: number;
  let hospitalSiblingId: number;
  let hospitalLockedId: number;
  let hospitalBId: number;
  let sectorAId: number;
  let sectorSiblingId: number;
  let sectorLockedId: number;
  let sectorBId: number;
  let contextAId: number;
  let contextSiblingId: number;
  let contextLockedId: number;
  let contextBId: number;
  let doctorUserId: number;
  let doctorProfessionalId: number;
  let plusUserId: number;
  let plusProfessionalId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let invitedUserId: number;
  let invitedProfessionalId: number;
  let doctorPlantaoId: number;
  let doctorSobreavisoId: number;
  let doctorOwnRequestId: number;
  let doctorOverlappingCandidateId: number;
  let siblingShiftId: number;
  let lockedShiftId: number;
  let foreignShiftId: number;
  let pendingShiftId: number;
  let namedInviteId: number;

  const stamp = Date.now();
  const cnpjBase = String(stamp).slice(-12).padStart(12, "7");
  // MySQL TIMESTAMP ends in January/2038; keep this future fixture inside
  // that physical range so the regression is portable to CI.
  const date = "2037-04-15";
  const nextDate = "2037-04-16";
  const yearMonth = date.slice(0, 7);
  // MySQL DATETIME is UTC in this test schema. Values below are deliberately
  // distinct in BRT so only the explicit candidate overlaps the foreign
  // assignment; happy-path cards remain actionable.
  const time = {
    sobreaviso: {
      startAt: `${date} 03:00:00`, // 00:00 BRT
      endAt: `${date} 09:00:00`, // 06:00 BRT
    },
    plantao: {
      startAt: `${date} 10:00:00`, // 07:00 BRT
      endAt: `${date} 16:00:00`, // 13:00 BRT
    },
    overlapCandidate: {
      startAt: `${date} 18:00:00`, // 15:00 BRT
      endAt: `${nextDate} 00:00:00`, // 21:00 BRT
    },
    foreignAssignment: {
      startAt: `${date} 19:00:00`, // 16:00 BRT
      endAt: `${nextDate} 01:00:00`, // 22:00 BRT
    },
    ownRequest: {
      startAt: `${nextDate} 01:00:00`, // 22:00 BRT
      endAt: `${nextDate} 02:00:00`, // 23:00 BRT
    },
  } as const;

  const callerFor = (
    userId: number,
    role: "doctor" | "manager",
    institutionId = institutionAId,
  ) =>
    appRouter.createCaller({
      user: {
        id: userId,
        role,
        name: `Vagas ${userId}`,
        email: `vagas-${userId}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  async function createShift(input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    scheduleContextId: number;
    label: string;
    modality?: "PLANTAO" | "SOBREAVISO";
    status?: "VAGO" | "PENDENTE";
    coverageType?: "URGENCIA_EMERGENCIA" | "ELETIVAS" | null;
    startAt?: string;
    endAt?: string;
  }): Promise<number> {
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        scheduleContextId: input.scheduleContextId,
        label: input.label,
        startAt: sql.raw(`'${input.startAt ?? time.plantao.startAt}'`),
        endAt: sql.raw(`'${input.endAt ?? time.plantao.endAt}'`),
        modality: input.modality ?? "PLANTAO",
        status: input.status ?? "VAGO",
        coverageType: input.coverageType ?? null,
      })
      .$returningId();
    return shift.id;
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institutionA] = await db
      .insert(institutions)
      .values({
        name: `VAC Count A ${stamp}`,
        cnpj: `${cnpjBase}01`,
        legalName: `VAC Count A ${stamp}`,
        tradeName: `VCA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionAId = institutionA.id;
    const [institutionB] = await db
      .insert(institutions)
      .values({
        name: `VAC Count B ${stamp}`,
        cnpj: `${cnpjBase}02`,
        legalName: `VAC Count B ${stamp}`,
        tradeName: `VCB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = institutionB.id;

    const createHospital = async (institutionId: number, suffix: string) => {
      const [hospital] = await db
        .insert(hospitals)
        .values({ institutionId, name: `VAC Hospital ${suffix} ${stamp}` })
        .$returningId();
      const [sector] = await db
        .insert(sectors)
        .values({
          institutionId,
          hospitalId: hospital.id,
          name: `VAC Setor ${suffix} ${stamp}`,
          category: "cirurgico",
          color: "#2563EB",
        })
        .$returningId();
      const scheduleContextId = await openTestScale(db, {
        institutionId,
        hospitalId: hospital.id,
        sectorId: sector.id,
      });
      return {
        hospitalId: hospital.id,
        sectorId: sector.id,
        scheduleContextId,
      };
    };

    ({
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      scheduleContextId: contextAId,
    } = await createHospital(institutionAId, "A"));
    ({
      hospitalId: hospitalSiblingId,
      sectorId: sectorSiblingId,
      scheduleContextId: contextSiblingId,
    } = await createHospital(institutionAId, "A-IRMAO"));
    ({
      hospitalId: hospitalLockedId,
      sectorId: sectorLockedId,
      scheduleContextId: contextLockedId,
    } = await createHospital(institutionAId, "A-LOCKED"));
    ({
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      scheduleContextId: contextBId,
    } = await createHospital(institutionBId, "B"));

    const createProfessional = async (
      suffix: string,
      roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS",
      globalRole: "doctor" | "manager",
    ) => {
      const [user] = await db
        .insert(users)
        .values({
          name: `VAC ${suffix} ${stamp}`,
          email: `vac-${suffix}-${stamp}@test.local`,
          passwordHash: "test",
          role: globalRole,
        })
        .$returningId();
      const [professional] = await db
        .insert(professionals)
        .values({
          userId: user.id,
          name: `VAC ${suffix} ${stamp}`,
          role: "Médico",
          userRole: roleInInstitution,
        })
        .$returningId();
      await db.insert(professionalInstitutions).values({
        userId: user.id,
        professionalId: professional.id,
        institutionId: institutionAId,
        roleInInstitution,
        isPrimary: true,
        active: true,
      });
      return { userId: user.id, professionalId: professional.id };
    };

    ({ userId: doctorUserId, professionalId: doctorProfessionalId } =
      await createProfessional("doctor", "USER", "doctor"));
    ({ userId: plusUserId, professionalId: plusProfessionalId } =
      await createProfessional("plus", "GESTOR_PLUS", "manager"));
    ({ userId: managerUserId, professionalId: managerProfessionalId } =
      await createProfessional("manager", "GESTOR_MEDICO", "manager"));
    ({ userId: invitedUserId, professionalId: invitedProfessionalId } =
      await createProfessional("invitee", "USER", "doctor"));
    await db.insert(professionalAccess).values({
      institutionId: institutionAId,
      professionalId: doctorProfessionalId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      canAccess: true,
    });

    doctorPlantaoId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      scheduleContextId: contextAId,
      label: `VAC ${stamp} plantao`,
      coverageType: "URGENCIA_EMERGENCIA",
    });
    doctorSobreavisoId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      scheduleContextId: contextAId,
      label: `VAC ${stamp} sobreaviso`,
      modality: "SOBREAVISO",
      startAt: time.sobreaviso.startAt,
      endAt: time.sobreaviso.endAt,
    });
    doctorOwnRequestId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      scheduleContextId: contextAId,
      label: `VAC ${stamp} own-request`,
      startAt: time.ownRequest.startAt,
      endAt: time.ownRequest.endAt,
    });
    doctorOverlappingCandidateId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      scheduleContextId: contextAId,
      label: `VAC ${stamp} overlap-candidate`,
      startAt: time.overlapCandidate.startAt,
      endAt: time.overlapCandidate.endAt,
    });
    pendingShiftId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      scheduleContextId: contextAId,
      label: `VAC ${stamp} pending-summary`,
      status: "PENDENTE",
    });
    siblingShiftId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalSiblingId,
      sectorId: sectorSiblingId,
      scheduleContextId: contextSiblingId,
      label: `VAC ${stamp} sibling`,
    });
    lockedShiftId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalLockedId,
      sectorId: sectorLockedId,
      scheduleContextId: contextLockedId,
      label: `VAC ${stamp} locked`,
    });
    foreignShiftId = await createShift({
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      scheduleContextId: contextBId,
      label: `VAC ${stamp} foreign`,
      startAt: time.foreignAssignment.startAt,
      endAt: time.foreignAssignment.endAt,
    });

    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: doctorOwnRequestId,
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      status: "PENDENTE",
      isActive: true,
      createdBy: doctorUserId,
    });
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: foreignShiftId,
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      status: "PENDENTE",
      isActive: true,
      createdBy: doctorUserId,
    });
    await db.insert(managerScope).values({
      institutionId: institutionAId,
      managerProfessionalId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      active: true,
    });
    const [invite] = await db
      .insert(scheduleInvites)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalSiblingId,
        sectorId: sectorSiblingId,
        codeHash: String(stamp).padStart(64, "9"),
        createdByUserId: plusUserId,
        invitedUserId,
        invitedEmail: `vac-invitee-${stamp}@test.local`,
        maxRedemptions: 1,
        redeemedCount: 0,
        expiresAt: sql.raw("'2037-12-01 00:00:00'"),
      })
      .$returningId();
    namedInviteId = invite.id;
    await db.insert(monthlyRosters).values({
      institutionId: institutionAId,
      hospitalId: hospitalLockedId,
      yearMonth,
      status: "LOCKED",
    });
  });

  afterAll(async () => {
    const institutionIds = [institutionAId, institutionBId].filter(
      (id): id is number => Number.isInteger(id),
    );
    const shiftIds = [
      doctorPlantaoId,
      doctorSobreavisoId,
      doctorOwnRequestId,
      doctorOverlappingCandidateId,
      siblingShiftId,
      lockedShiftId,
      foreignShiftId,
      pendingShiftId,
    ].filter((id): id is number => Number.isInteger(id));
    const professionalIds = [
      doctorProfessionalId,
      plusProfessionalId,
      managerProfessionalId,
      invitedProfessionalId,
    ].filter((id): id is number => Number.isInteger(id));
    const userIds = [
      doctorUserId,
      plusUserId,
      managerUserId,
      invitedUserId,
    ].filter((id): id is number => Number.isInteger(id));
    const contextIds = [
      contextAId,
      contextSiblingId,
      contextLockedId,
      contextBId,
    ].filter((id): id is number => Number.isInteger(id));
    const sectorIds = [
      sectorAId,
      sectorSiblingId,
      sectorLockedId,
      sectorBId,
    ].filter((id): id is number => Number.isInteger(id));
    const hospitalIds = [
      hospitalAId,
      hospitalSiblingId,
      hospitalLockedId,
      hospitalBId,
    ].filter((id): id is number => Number.isInteger(id));

    if (shiftIds.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db
        .delete(shiftInstances)
        .where(inArray(shiftInstances.id, shiftIds));
    }
    if (namedInviteId) {
      await db
        .delete(scheduleInvites)
        .where(eq(scheduleInvites.id, namedInviteId));
    }
    if (institutionIds.length) {
      await db
        .delete(monthlyRosters)
        .where(inArray(monthlyRosters.institutionId, institutionIds));
    }
    if (professionalIds.length) {
      await db
        .delete(managerScope)
        .where(inArray(managerScope.managerProfessionalId, professionalIds));
      await db
        .delete(professionalAccess)
        .where(inArray(professionalAccess.professionalId, professionalIds));
      await db
        .delete(professionalInstitutions)
        .where(
          inArray(professionalInstitutions.professionalId, professionalIds),
        );
      await db
        .delete(professionals)
        .where(inArray(professionals.id, professionalIds));
    }
    if (contextIds.length) {
      await db
        .delete(scheduleContexts)
        .where(inArray(scheduleContexts.id, contextIds));
    }
    if (sectorIds.length) {
      await db.delete(sectors).where(inArray(sectors.id, sectorIds));
    }
    if (hospitalIds.length) {
      await db.delete(hospitals).where(inArray(hospitals.id, hospitalIds));
    }
    if (institutionIds.length) {
      await db
        .delete(institutions)
        .where(inArray(institutions.id, institutionIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("conta apenas a mesma população acionável da lista para USER", async () => {
    const caller = callerFor(doctorUserId, "doctor");
    const [rows, counts] = await Promise.all([
      caller.shiftInstances.listVacancies({ date }),
      caller.filters.actionableVacancyCounts({ date }),
    ]);
    const ids = rows.map((row) => row.shiftInstanceId).sort((a, b) => a - b);

    expect(ids).toEqual(
      [doctorPlantaoId, doctorSobreavisoId].sort((a, b) => a - b),
    );
    expect(ids).not.toContain(doctorOwnRequestId);
    expect(ids).not.toContain(doctorOverlappingCandidateId);
    expect(ids).not.toContain(siblingShiftId);
    expect(ids).not.toContain(lockedShiftId);
    expect(ids).not.toContain(foreignShiftId);
    expect(counts.total).toBe(rows.length);
    expect(counts.vacanciesByHospital[hospitalAId]).toBe(2);
    expect(counts.vacanciesBySector[sectorAId]).toBe(2);
    expect(counts.vacanciesByHospital[hospitalSiblingId] ?? 0).toBe(0);
    expect(counts.vacanciesByHospital[hospitalLockedId] ?? 0).toBe(0);
  });

  it("aplica os filtros de Vagas ao contador pelo mesmo contrato da lista", async () => {
    const caller = callerFor(doctorUserId, "doctor");
    const filters = {
      date,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      shiftLabel: `VAC ${stamp} plantao`,
      modality: "PLANTAO" as const,
      coverageType: "URGENCIA_EMERGENCIA" as const,
    };
    const [rows, counts] = await Promise.all([
      caller.shiftInstances.listVacancies(filters),
      caller.filters.actionableVacancyCounts(filters),
    ]);

    expect(rows.map((row) => row.shiftInstanceId)).toEqual([doctorPlantaoId]);
    expect(counts.total).toBe(rows.length);
    expect(counts.vacanciesByHospital).toEqual({ [hospitalAId]: 1 });
    expect(counts.vacanciesBySector).toEqual({ [sectorAId]: 1 });
  });

  it.each([
    ["hospital", { hospitalId: () => hospitalAId }],
    ["setor", { sectorId: () => sectorAId }],
    ["turno", { shiftLabel: () => `VAC ${stamp} plantao` }],
    ["modalidade", { modality: () => "PLANTAO" as const }],
    ["cobertura", { coverageType: () => "URGENCIA_EMERGENCIA" as const }],
  ] as const)(
    "mantém paridade lista/contador ao filtrar por %s",
    async (_label, filterFactory) => {
      const filters = Object.fromEntries(
        Object.entries(filterFactory).map(([key, value]) => [key, value()]),
      );
      const caller = callerFor(doctorUserId, "doctor");
      const [rows, counts] = await Promise.all([
        caller.shiftInstances.listVacancies({ date, ...filters }),
        caller.filters.actionableVacancyCounts({ date, ...filters }),
      ]);

      expect(counts.total).toBe(rows.length);
      expect(
        Object.values(counts.vacanciesByHospital).reduce(
          (sum, count) => sum + count,
          0,
        ),
      ).toBe(rows.length);
      expect(
        Object.values(counts.vacanciesBySector).reduce(
          (sum, count) => sum + count,
          0,
        ),
      ).toBe(rows.length);
    },
  );

  it("mantém o resumo gerencial de pendências separado dos contadores acionáveis", async () => {
    const caller = callerFor(plusUserId, "manager");
    const [summary, actionable] = await Promise.all([
      caller.filters.summaryCounts({ date }),
      caller.filters.actionableVacancyCounts({ date }),
    ]);

    expect(summary.pendingByHospital[hospitalAId]).toBe(1);
    expect(summary.pendingBySector[sectorAId]).toBe(1);
    expect(actionable.total).not.toBe(0);
    expect(actionable.vacanciesByHospital[hospitalAId] ?? 0).toBeGreaterThan(0);
  });

  it("GESTOR_MEDICO permanece restrito ao manager_scope, sem herdar a via GESTOR_PLUS", async () => {
    const caller = callerFor(managerUserId, "manager");
    const [rows, counts] = await Promise.all([
      caller.shiftInstances.listVacancies({ date }),
      caller.filters.actionableVacancyCounts({ date }),
    ]);
    const ids = rows.map((row) => row.shiftInstanceId);

    expect(ids).toContain(doctorPlantaoId);
    expect(ids).toContain(doctorSobreavisoId);
    expect(ids).toContain(doctorOverlappingCandidateId);
    expect(ids).not.toContain(doctorOwnRequestId);
    expect(ids).not.toContain(siblingShiftId);
    expect(ids).not.toContain(lockedShiftId);
    expect(ids).not.toContain(foreignShiftId);
    expect(counts.total).toBe(rows.length);
    expect(counts.vacanciesByHospital).toEqual({ [hospitalAId]: 3 });
    expect(counts.vacanciesByHospital[hospitalSiblingId] ?? 0).toBe(0);
  });

  it("inclui o convite nominal pendente, mas não amplia acesso de outro hospital", async () => {
    const caller = callerFor(invitedUserId, "doctor");
    const [rows, counts] = await Promise.all([
      caller.shiftInstances.listVacancies({ date }),
      caller.filters.actionableVacancyCounts({ date }),
    ]);

    expect(rows.map((row) => row.shiftInstanceId)).toEqual([siblingShiftId]);
    expect(counts.total).toBe(1);
    expect(counts.vacanciesByHospital).toEqual({ [hospitalSiblingId]: 1 });
    expect(counts.vacanciesBySector).toEqual({ [sectorSiblingId]: 1 });
  });

  it("GESTOR_PLUS vê todas as vagas assumíveis do próprio tenant, nunca outro tenant", async () => {
    const caller = callerFor(plusUserId, "manager");
    const [rows, counts] = await Promise.all([
      caller.shiftInstances.listVacancies({ date }),
      caller.filters.actionableVacancyCounts({ date }),
    ]);
    const ids = rows.map((row) => row.shiftInstanceId);

    expect(ids).toContain(doctorPlantaoId);
    expect(ids).toContain(doctorSobreavisoId);
    expect(ids).toContain(doctorOverlappingCandidateId);
    expect(ids).not.toContain(doctorOwnRequestId);
    expect(ids).toContain(siblingShiftId);
    expect(ids).not.toContain(lockedShiftId);
    expect(ids).not.toContain(foreignShiftId);
    expect(counts.total).toBe(rows.length);
    expect(counts.vacanciesByHospital[hospitalSiblingId]).toBe(1);
    expect(counts.vacanciesByHospital[hospitalLockedId] ?? 0).toBe(0);
    expect(counts.vacanciesByHospital[hospitalBId] ?? 0).toBe(0);
  });

  it("resolve intenção de rota pela mesma população acionável e não vaza alvo indisponível", async () => {
    const routeDate = "2037-04-17";
    const routeShiftId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      scheduleContextId: contextAId,
      label: `VAC ${stamp} route-intent`,
      startAt: `${routeDate} 10:00:00`,
      endAt: `${routeDate} 16:00:00`,
    });

    try {
      const doctor = callerFor(doctorUserId, "doctor");
      const resolveIntentInput = (
        shiftInstanceId: number,
        expectedTenantId = institutionAId,
      ) => ({
        shiftInstanceId,
        expectedTenantId,
        requestTenantRevision: 1,
      });
      await expect(
        doctor.shiftInstances.resolveVacancyIntent(resolveIntentInput(routeShiftId)),
      ).resolves.toEqual({
        available: true,
        shiftInstanceId: routeShiftId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        date: routeDate,
      });

      // USER e GESTOR_MEDICO não ganham o hospital irmão; GESTOR_PLUS e o
      // convite nominal usam as mesmas grants acionáveis da lista/escrita.
      await expect(
        doctor.shiftInstances.resolveVacancyIntent(resolveIntentInput(siblingShiftId)),
      ).resolves.toEqual({ available: false });
      await expect(
        callerFor(managerUserId, "manager").shiftInstances.resolveVacancyIntent(
          resolveIntentInput(siblingShiftId),
        ),
      ).resolves.toEqual({ available: false });
      await expect(
        callerFor(plusUserId, "manager").shiftInstances.resolveVacancyIntent(
          resolveIntentInput(siblingShiftId),
        ),
      ).resolves.toMatchObject({
        available: true,
        shiftInstanceId: siblingShiftId,
        hospitalId: hospitalSiblingId,
        sectorId: sectorSiblingId,
        date,
      });
      await expect(
        callerFor(invitedUserId, "doctor").shiftInstances.resolveVacancyIntent(
          resolveIntentInput(siblingShiftId),
        ),
      ).resolves.toMatchObject({
        available: true,
        shiftInstanceId: siblingShiftId,
        hospitalId: hospitalSiblingId,
        sectorId: sectorSiblingId,
        date,
      });
      await expect(
        doctor.shiftInstances.resolveVacancyIntent(resolveIntentInput(foreignShiftId)),
      ).resolves.toEqual({ available: false });
      await expect(
        doctor.shiftInstances.resolveVacancyIntent(
          resolveIntentInput(routeShiftId, institutionBId),
        ),
      ).resolves.toEqual({ available: false });

      await expect(
        doctor.shiftAssignments.assumeVacancy({
          shiftInstanceId: routeShiftId,
          assignmentType: "ON_DUTY",
        }),
      ).resolves.toMatchObject({ ok: true, status: "PENDENTE" });

      // Ocupação/revogação e alvo de outro tenant colapsam na mesma resposta
      // negativa, sem nome, data, hospital, setor ou motivo enumerável.
      await expect(
        doctor.shiftInstances.resolveVacancyIntent(resolveIntentInput(routeShiftId)),
      ).resolves.toEqual({ available: false });
    } finally {
      await db
        .delete(shiftAuditLog)
        .where(eq(shiftAuditLog.shiftInstanceId, routeShiftId));
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.shiftInstanceId, routeShiftId));
      await db
        .delete(shiftInstances)
        .where(eq(shiftInstances.id, routeShiftId));
    }
  });

  it("só anuncia vaga que assume e remove a mesma linha da lista e do contador", async () => {
    const mutationDate = "2037-04-16";
    const mutationShiftId = await createShift({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      scheduleContextId: contextAId,
      label: `VAC ${stamp} mutation-success`,
      startAt: `${mutationDate} 10:00:00`,
      endAt: `${mutationDate} 16:00:00`,
    });

    try {
      const caller = callerFor(doctorUserId, "doctor");
      const [beforeRows, beforeCounts] = await Promise.all([
        caller.shiftInstances.listVacancies({ date: mutationDate }),
        caller.filters.actionableVacancyCounts({ date: mutationDate }),
      ]);
      expect(beforeRows.map((row) => row.shiftInstanceId)).toContain(
        mutationShiftId,
      );
      expect(beforeCounts.total).toBe(beforeRows.length);

      await expect(
        caller.shiftAssignments.assumeVacancy({
          shiftInstanceId: mutationShiftId,
          assignmentType: "ON_DUTY",
        }),
      ).resolves.toMatchObject({ ok: true, status: "PENDENTE" });

      const [afterRows, afterCounts] = await Promise.all([
        caller.shiftInstances.listVacancies({ date: mutationDate }),
        caller.filters.actionableVacancyCounts({ date: mutationDate }),
      ]);
      expect(afterRows.map((row) => row.shiftInstanceId)).not.toContain(
        mutationShiftId,
      );
      expect(afterCounts.total).toBe(afterRows.length);
      expect(afterCounts.vacanciesByHospital[hospitalAId] ?? 0).toBe(
        afterRows.length,
      );
    } finally {
      await db
        .delete(shiftAuditLog)
        .where(eq(shiftAuditLog.shiftInstanceId, mutationShiftId));
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.shiftInstanceId, mutationShiftId));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, mutationShiftId));
    }
  });

  it("fecha a topologia ambígua em vez de anunciar vaga que a escrita recusará", async () => {
    const [duplicate] = await db
      .insert(scheduleContexts)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        admissionPolicy: "ALL_CFM_EXCEPT_GENERALIST",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
        active: true,
      })
      .$returningId();

    try {
      const caller = callerFor(doctorUserId, "doctor");
      const [rows, counts] = await Promise.all([
        caller.shiftInstances.listVacancies({ date }),
        caller.filters.actionableVacancyCounts({ date }),
      ]);

      expect(rows).toEqual([]);
      expect(counts).toEqual({
        total: 0,
        vacanciesByHospital: {},
        vacanciesBySector: {},
      });
    } finally {
      await db
        .delete(scheduleContexts)
        .where(eq(scheduleContexts.id, duplicate.id));
    }
  });

  it("fecha todas as vagas quando a alocação ativa do profissional tem topologia contaminada", async () => {
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: doctorPlantaoId,
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      status: "PENDENTE",
      isActive: true,
      createdBy: doctorUserId,
    });

    const caller = callerFor(doctorUserId, "doctor");
    const [rows, counts] = await Promise.all([
      caller.shiftInstances.listVacancies({ date }),
      caller.filters.actionableVacancyCounts({ date }),
    ]);

    expect(rows).toEqual([]);
    expect(counts).toEqual({
      total: 0,
      vacanciesByHospital: {},
      vacanciesBySector: {},
    });
  });
});
