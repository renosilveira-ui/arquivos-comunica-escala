import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutionFeatureEntitlements,
  institutions,
  monthlyRosters,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { ensureTestAnesthesiaSpecialty } from "./helpers/open-test-scale";
import { getDb } from "../server/db";
import { mondayOfKey } from "../server/local-time";
import { scheduleContextsRouter } from "../server/schedule-contexts";
import { shiftsRouter } from "../server/shifts-crud";
import { calendarRouter } from "../server/calendar";

const OFFSET = "-03:00";
const SHIFT_DAY = "2026-09-10";
const at = (date: string, time: string) => new Date(`${date}T${time}${OFFSET}`);

describe("panorama Geral: todos vêem quem está no plantão", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalId: number;
  let emergencySectorId: number;
  let utiSectorId: number;
  let emergencyContextId: number;
  let utiContextId: number;
  let otherContextId: number;
  let gestorUserId: number;
  let gestorProId: number;
  let readerUserId: number;
  let readerProId: number;
  let colleagueUserId: number;
  let colleagueProId: number;
  let anesthesiaId: number;
  let emergencyShiftId: number;
  let utiShiftId: number;
  let otherShiftId: number;
  const stamp = Date.now();

  const ctx = (
    userId: number,
    role: "manager" | "doctor",
    institution = institutionId,
  ) =>
    ({
      user: {
        id: userId,
        role,
        name: "T",
        email: `${userId}@t.local`,
        sessionVersion: 1,
      },
      institutionId: institution,
      allowedInstitutionIds: [institution],
    }) as any;

  const shiftsAs = (userId: number, role: "manager" | "doctor" = "doctor") =>
    shiftsRouter.createCaller(ctx(userId, role));
  const contextsAs = (userId: number, role: "manager" | "doctor" = "doctor") =>
    scheduleContextsRouter.createCaller(ctx(userId, role));

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;

    const [inst] = await db
      .insert(institutions)
      .values({
        name: `Roster Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Roster ${stamp}`,
        tradeName: `RT${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;

    const [otherInst] = await db
      .insert(institutions)
      .values({
        name: `Roster Other ${stamp}`,
        cnpj: `${stamp + 1}`.slice(-14).padStart(14, "0"),
        legalName: `Roster Other ${stamp}`,
        tradeName: `RO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    otherInstitutionId = otherInst.id;

    await db.insert(institutionFeatureEntitlements).values({
      institutionId,
      featureCode: "CROSS_SCHEDULE_ROSTER_VIEW",
      enabled: true,
      source: "LEGACY_COMPATIBILITY",
      version: 1,
    });

    const [hosp] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Roster Hospital ${stamp}` })
      .$returningId();
    hospitalId = hosp.id;
    // Visibilidade entre colegas pressupõe publicação, não só entitlement.
    await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: "2026-09",
      status: "PUBLISHED",
    });
    const [otherHosp] = await db
      .insert(hospitals)
      .values({
        institutionId: otherInstitutionId,
        name: `Roster Other Hosp ${stamp}`,
      })
      .$returningId();

    const [emergency] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Emergência ${stamp}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    emergencySectorId = emergency.id;
    const [uti] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `UTI ${stamp}`,
        category: "internacao",
        color: "#DC2626",
      })
      .$returningId();
    utiSectorId = uti.id;
    const [otherSec] = await db
      .insert(sectors)
      .values({
        institutionId: otherInstitutionId,
        hospitalId: otherHosp.id,
        name: `Setor alheio ${stamp}`,
        category: "servico",
        color: "#7C3AED",
      })
      .$returningId();

    const [emergencyCtx] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId: emergencySectorId,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
        active: true,
      })
      .$returningId();
    emergencyContextId = emergencyCtx.id;
    const [utiCtx] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId: utiSectorId,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
        active: true,
      })
      .$returningId();
    utiContextId = utiCtx.id;
    const [otherCtx] = await db
      .insert(scheduleContexts)
      .values({
        institutionId: otherInstitutionId,
        hospitalId: otherHosp.id,
        sectorId: otherSec.id,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
        active: true,
      })
      .$returningId();
    otherContextId = otherCtx.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);

    const person = async (
      tag: string,
      role: "manager" | "doctor",
      link: "GESTOR_PLUS" | "USER",
      institution = institutionId,
    ) => {
      const [u] = await db
        .insert(users)
        .values({
          name: `Roster ${tag} ${stamp}`,
          email: `roster-${tag}-${stamp}@test.local`,
          passwordHash: "test",
          role,
          approvalStatus: "APPROVED",
        })
        .$returningId();
      const [p] = await db
        .insert(professionals)
        .values({
          userId: u.id,
          name: `Roster ${tag} ${stamp}`,
          role: "Médico",
          userRole: link,
          medicalSpecialtyId: anesthesiaId,
          specialty: "Anestesiologia",
        })
        .$returningId();
      await db.insert(professionalInstitutions).values({
        professionalId: p.id,
        userId: u.id,
        institutionId: institution,
        roleInInstitution: link,
        isPrimary: true,
        active: true,
      });
      return { userId: u.id, proId: p.id };
    };

    const gestor = await person("gestor", "manager", "GESTOR_PLUS");
    gestorUserId = gestor.userId;
    gestorProId = gestor.proId;
    const reader = await person("leitor", "doctor", "USER");
    readerUserId = reader.userId;
    readerProId = reader.proId;
    const colleague = await person("colega", "doctor", "USER");
    colleagueUserId = colleague.userId;
    colleagueProId = colleague.proId;

    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: readerProId,
      hospitalId,
      sectorId: emergencySectorId,
      canAccess: true,
    });

    const [emergencyShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId: emergencySectorId,
        scheduleContextId: emergencyContextId,
        label: "Manhã",
        startAt: at(SHIFT_DAY, "07:00:00"),
        endAt: at(SHIFT_DAY, "13:00:00"),
        status: "OCUPADO",
      })
      .$returningId();
    emergencyShiftId = emergencyShift.id;
    const [utiShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId: utiSectorId,
        scheduleContextId: utiContextId,
        label: "Manhã",
        startAt: at(SHIFT_DAY, "07:00:00"),
        endAt: at(SHIFT_DAY, "13:00:00"),
        status: "OCUPADO",
      })
      .$returningId();
    utiShiftId = utiShift.id;
    const [otherShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: otherInstitutionId,
        hospitalId: otherHosp.id,
        sectorId: otherSec.id,
        scheduleContextId: otherContextId,
        label: "Manhã",
        startAt: at(SHIFT_DAY, "07:00:00"),
        endAt: at(SHIFT_DAY, "13:00:00"),
        status: "OCUPADO",
      })
      .$returningId();
    otherShiftId = otherShift.id;

    await db.insert(shiftAssignmentsV2).values([
      {
        shiftInstanceId: emergencyShiftId,
        institutionId,
        hospitalId,
        sectorId: emergencySectorId,
        professionalId: readerProId,
        isActive: true,
        status: "CONFIRMADO",
      },
      {
        shiftInstanceId: utiShiftId,
        institutionId,
        hospitalId,
        sectorId: utiSectorId,
        professionalId: colleagueProId,
        isActive: true,
        status: "CONFIRMADO",
      },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    const tenantIds = [institutionId, otherInstitutionId];
    await db
      .delete(monthlyRosters)
      .where(inArray(monthlyRosters.institutionId, tenantIds));
    await db
      .delete(managerScope)
      .where(inArray(managerScope.institutionId, tenantIds));
    const shifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(inArray(shiftInstances.institutionId, tenantIds));
    const ids = shifts.map((row) => row.id);
    if (ids.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    const pros = [gestorProId, readerProId, colleagueProId];
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.professionalId, pros));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.professionalId, pros));
    await db.delete(professionals).where(inArray(professionals.id, pros));
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.institutionId, tenantIds));
    await db.delete(sectors).where(inArray(sectors.institutionId, tenantIds));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.institutionId, tenantIds));
    await db
      .delete(institutionFeatureEntitlements)
      .where(inArray(institutionFeatureEntitlements.institutionId, tenantIds));
    await db.delete(institutions).where(inArray(institutions.id, tenantIds));
    await db
      .delete(users)
      .where(inArray(users.id, [gestorUserId, readerUserId, colleagueUserId]));
  });

  function flattenAgenda(
    result: Awaited<ReturnType<ReturnType<typeof shiftsAs>["listAgenda"]>>,
  ) {
    return result.weeks.flatMap((week) =>
      week.days.flatMap((day) => day.groups.flatMap((group) => group.shifts)),
    );
  }

  it("USER lê o plantão de outro setor no Geral, com o nome do colega", async () => {
    const mine = await contextsAs(readerUserId).listMine();
    expect(mine.map((row) => row.id)).toEqual([emergencyContextId]);

    const readable = await contextsAs(readerUserId).listReadable();
    expect(readable.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [emergencyContextId, utiContextId].sort((a, b) => a - b),
    );
    expect(readable.every((row) => row.canManage === false)).toBe(true);

    const agenda = await shiftsAs(readerUserId).listAgenda({
      startDate: mondayOfKey(SHIFT_DAY),
      weeks: 1,
      scope: "geral",
    });
    const rows = flattenAgenda(agenda);
    expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [emergencyShiftId, utiShiftId].sort((a, b) => a - b),
    );
    expect(
      rows.find((row) => row.id === utiShiftId)?.professionalNames,
    ).toEqual([`Roster colega ${stamp}`]);
    expect(rows.find((row) => row.id === emergencyShiftId)).toMatchObject({
      professionalNames: [`Roster leitor ${stamp}`],
      isMine: true,
    });
    expect(rows.some((row) => row.id === otherShiftId)).toBe(false);

    const filtered = await shiftsAs(readerUserId).listAgenda({
      startDate: mondayOfKey(SHIFT_DAY),
      weeks: 1,
      scope: "geral",
      scheduleContextId: utiContextId,
    });
    expect(flattenAgenda(filtered).map((row) => row.id)).toEqual([utiShiftId]);

    const mineAgenda = await shiftsAs(readerUserId).listAgenda({
      startDate: mondayOfKey(SHIFT_DAY),
      weeks: 1,
      scope: "minha",
    });
    expect(flattenAgenda(mineAgenda).map((row) => row.id)).toEqual([
      emergencyShiftId,
    ]);
  });

  it("USER abre o detalhe do plantão alheio e continua sem poder gerir a escala", async () => {
    const detail = await shiftsAs(readerUserId).get({ id: utiShiftId });
    expect(detail.id).toBe(utiShiftId);
    expect(detail.assignments.map((row) => row.professionalName)).toEqual([
      `Roster colega ${stamp}`,
    ]);

    await expect(
      shiftsAs(readerUserId).openMonthShifts({
        hospitalId,
        sectorId: utiSectorId,
        scheduleContextId: utiContextId,
        yearMonth: "2026-09",
        mode: "all-applicable",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Apenas gestores da instituição podem gerenciar escalas",
    });
  });

  it.each(["DRAFT", "ABSENT", "PUBLISHED", "LOCKED"] as const)(
    "%s: leitores aplicam publicação, gestão, ownership e tenant",
    async (status) => {
      const [managerAssignment] = await db
        .insert(shiftAssignmentsV2)
        .values({
          shiftInstanceId: emergencyShiftId,
          institutionId,
          hospitalId,
          sectorId: emergencySectorId,
          professionalId: gestorProId,
          isActive: true,
          status: "CONFIRMADO",
        })
        .$returningId();
      await db
        .delete(monthlyRosters)
        .where(eq(monthlyRosters.institutionId, institutionId));
      if (status !== "ABSENT") {
        await db
          .insert(monthlyRosters)
          .values({ institutionId, hospitalId, yearMonth: "2026-09", status });
      }
      try {
        for (const isManager of [false, true]) {
          const userId = isManager ? gestorUserId : readerUserId;
          const role = isManager ? "manager" : "doctor";
          const caller = shiftsAs(userId, role);
          const visible =
            isManager || status === "PUBLISHED" || status === "LOCKED";
          const expectedIds = visible
            ? [emergencyShiftId, utiShiftId].sort((a, b) => a - b)
            : [];
          const agenda = flattenAgenda(
            await caller.listAgenda({
              startDate: mondayOfKey(SHIFT_DAY),
              weeks: 1,
              scope: "geral",
            }),
          );
          expect(agenda.map((row) => row.id).sort((a, b) => a - b)).toEqual(
            expectedIds,
          );
          const period = await caller.listByPeriod({
            startDate: SHIFT_DAY,
            endDate: SHIFT_DAY,
          });
          expect(period.map((row) => row.id).sort((a, b) => a - b)).toEqual(
            expectedIds,
          );
          const ownAgenda = flattenAgenda(
            await caller.listAgenda({
              startDate: mondayOfKey(SHIFT_DAY),
              weeks: 1,
              scope: "minha",
            }),
          );
          expect(ownAgenda.map((row) => row.id)).toEqual(
            visible ? [emergencyShiftId] : [],
          );
          // USER: próprio e colega obedecem à mesma cerca de rascunho.
          for (const id of [emergencyShiftId, utiShiftId]) {
            if (visible) expect((await caller.get({ id })).id).toBe(id);
            else
              await expect(caller.get({ id })).rejects.toMatchObject({
                code: "FORBIDDEN",
              });
          }
          const calendar = calendarRouter.createCaller(ctx(userId, role));
          const calendarInput = {
            institutionId,
            hospitalId,
            sectorId: emergencySectorId,
            scheduleContextId: emergencyContextId,
            date: SHIFT_DAY,
          };
          if (visible)
            await expect(calendar.getDay(calendarInput)).resolves.toBeDefined();
          else
            await expect(calendar.getDay(calendarInput)).rejects.toMatchObject({
              code: "FORBIDDEN",
            });
          await expect(caller.get({ id: otherShiftId })).rejects.toMatchObject({
            code: "NOT_FOUND",
          });
          await expect(
            caller.listByPeriod({
              startDate: SHIFT_DAY,
              endDate: SHIFT_DAY,
              scheduleContextId: otherContextId,
            }),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });
          await expect(
            caller.listAgenda({
              startDate: mondayOfKey(SHIFT_DAY),
              weeks: 1,
              scope: "geral",
              scheduleContextId: otherContextId,
            }),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });
        }
        const mine = flattenAgenda(
          await shiftsAs(readerUserId).listAgenda({
            startDate: mondayOfKey(SHIFT_DAY),
            weeks: 1,
            scope: "minha",
          }),
        );
        expect(mine.map((row) => row.id)).toEqual(
          status === "PUBLISHED" || status === "LOCKED"
            ? [emergencyShiftId]
            : [],
        );
      } finally {
        await db
          .delete(shiftAssignmentsV2)
          .where(eq(shiftAssignmentsV2.id, managerAssignment.id));
        await db
          .delete(monthlyRosters)
          .where(eq(monthlyRosters.institutionId, institutionId));
        await db.insert(monthlyRosters).values({
          institutionId,
          hospitalId,
          yearMonth: "2026-09",
          status: "PUBLISHED",
        });
      }
    },
  );

  it("publicação de outro tenant não autoriza o mesmo hospital/mês", async () => {
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    // FKs isoladas não comprovam a tupla composta instituição/hospital.
    const [poisoned] = await db
      .insert(monthlyRosters)
      .values({
        institutionId: otherInstitutionId,
        hospitalId,
        yearMonth: "2026-09",
        status: "PUBLISHED",
      })
      .$returningId();
    try {
      const caller = shiftsAs(readerUserId);
      await expect(caller.get({ id: emergencyShiftId })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(
        await caller.listByPeriod({ startDate: SHIFT_DAY, endDate: SHIFT_DAY }),
      ).toEqual([]);
      expect(
        flattenAgenda(
          await caller.listAgenda({
            startDate: mondayOfKey(SHIFT_DAY),
            weeks: 1,
            scope: "geral",
          }),
        ),
      ).toEqual([]);
    } finally {
      await db.delete(monthlyRosters).where(eq(monthlyRosters.id, poisoned.id));
      await db
        .insert(monthlyRosters)
        .values({
          institutionId,
          hospitalId,
          yearMonth: "2026-09",
          status: "PUBLISHED",
        });
    }
  });

  it("fallback próprio publicado não revela colegas; rascunho continua bloqueado", async () => {
    const [colleagueAssignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: emergencyShiftId,
        institutionId,
        hospitalId,
        sectorId: emergencySectorId,
        professionalId: colleagueProId,
        isActive: true,
        status: "CONFIRMADO",
      })
      .$returningId();
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.professionalId, readerProId));
    await db
      .update(institutionFeatureEntitlements)
      .set({ enabled: false })
      .where(eq(institutionFeatureEntitlements.institutionId, institutionId));
    try {
      const caller = shiftsAs(readerUserId);
      expect(
        (await caller.get({ id: emergencyShiftId })).assignments.map(
          (a) => a.professionalId,
        ),
      ).toEqual([readerProId]);
      const period = await caller.listByPeriod({
        startDate: SHIFT_DAY,
        endDate: SHIFT_DAY,
      });
      expect(period.map((row) => row.id)).toEqual([emergencyShiftId]);
      expect(period[0].assignments.map((a) => a.professionalId)).toEqual([
        readerProId,
      ]);
      const mine = flattenAgenda(
        await caller.listAgenda({
          startDate: mondayOfKey(SHIFT_DAY),
          weeks: 1,
          scope: "minha",
        }),
      );
      expect(mine.map((row) => row.id)).toEqual([emergencyShiftId]);
      expect(mine[0].professionalNames).toEqual([`Roster leitor ${stamp}`]);
      await db
        .update(monthlyRosters)
        .set({ status: "DRAFT" })
        .where(eq(monthlyRosters.institutionId, institutionId));
      await expect(caller.get({ id: emergencyShiftId })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(
        await caller.listByPeriod({ startDate: SHIFT_DAY, endDate: SHIFT_DAY }),
      ).toEqual([]);
      expect(
        flattenAgenda(
          await caller.listAgenda({
            startDate: mondayOfKey(SHIFT_DAY),
            weeks: 1,
            scope: "minha",
          }),
        ),
      ).toEqual([]);
    } finally {
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, colleagueAssignment.id));
      await db.insert(professionalAccess).values({
        institutionId,
        professionalId: readerProId,
        hospitalId,
        sectorId: emergencySectorId,
        canAccess: true,
      });
      await db
        .update(institutionFeatureEntitlements)
        .set({ enabled: true })
        .where(eq(institutionFeatureEntitlements.institutionId, institutionId));
      await db
        .update(monthlyRosters)
        .set({ status: "PUBLISHED" })
        .where(eq(monthlyRosters.institutionId, institutionId));
    }
  });

  it("GESTOR_MEDICO fora do manager_scope não herda leitura de rascunho", async () => {
    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "GESTOR_MEDICO" })
      .where(
        and(
          eq(professionalInstitutions.institutionId, institutionId),
          eq(professionalInstitutions.professionalId, gestorProId),
        ),
      );
    const [scope] = await db
      .insert(managerScope)
      .values({
        institutionId,
        hospitalId,
        sectorId: utiSectorId,
        managerProfessionalId: gestorProId,
        active: true,
      })
      .$returningId();
    const [access] = await db
      .insert(professionalAccess)
      .values({
        institutionId,
        hospitalId,
        sectorId: emergencySectorId,
        professionalId: gestorProId,
        canAccess: true,
      })
      .$returningId();
    await db
      .update(monthlyRosters)
      .set({ status: "DRAFT" })
      .where(eq(monthlyRosters.institutionId, institutionId));
    try {
      const caller = shiftsAs(gestorUserId, "manager");
      expect((await caller.get({ id: utiShiftId })).id).toBe(utiShiftId);
      await expect(caller.get({ id: emergencyShiftId })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(
        (
          await caller.listByPeriod({
            startDate: SHIFT_DAY,
            endDate: SHIFT_DAY,
          })
        ).map((row) => row.id),
      ).toEqual([utiShiftId]);
      expect(
        flattenAgenda(
          await caller.listAgenda({
            startDate: mondayOfKey(SHIFT_DAY),
            weeks: 1,
            scope: "geral",
          }),
        ).map((row) => row.id),
      ).toEqual([utiShiftId]);
    } finally {
      await db.delete(managerScope).where(eq(managerScope.id, scope.id));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.id, access.id));
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "GESTOR_PLUS" })
        .where(
          and(
            eq(professionalInstitutions.institutionId, institutionId),
            eq(professionalInstitutions.professionalId, gestorProId),
          ),
        );
      await db
        .update(monthlyRosters)
        .set({ status: "PUBLISHED" })
        .where(eq(monthlyRosters.institutionId, institutionId));
    }
  });

  it("lote com dois hospitais e dois meses mantém status exato e mês civil BRT", async () => {
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Roster Lote ${stamp}` })
      .$returningId();
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospital.id,
        name: "Lote",
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    const [context] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId: hospital.id,
        sectorId: sector.id,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        active: true,
      })
      .$returningId();
    await db.insert(monthlyRosters).values([
      {
        institutionId,
        hospitalId: hospital.id,
        yearMonth: "2026-09",
        status: "LOCKED",
      },
      {
        institutionId,
        hospitalId: hospital.id,
        yearMonth: "2026-10",
        status: "DRAFT",
      },
    ]);
    const fixtures = [
      {
        hospitalId,
        sectorId: emergencySectorId,
        scheduleContextId: emergencyContextId,
        startAt: at("2026-09-30", "23:00:00"),
        endAt: at("2026-10-01", "07:00:00"),
      },
      {
        hospitalId,
        sectorId: emergencySectorId,
        scheduleContextId: emergencyContextId,
        startAt: at("2026-10-01", "07:00:00"),
        endAt: at("2026-10-01", "13:00:00"),
      },
      {
        hospitalId: hospital.id,
        sectorId: sector.id,
        scheduleContextId: context.id,
        startAt: at("2026-09-30", "23:00:00"),
        endAt: at("2026-10-01", "07:00:00"),
      },
      {
        hospitalId: hospital.id,
        sectorId: sector.id,
        scheduleContextId: context.id,
        startAt: at("2026-10-01", "07:00:00"),
        endAt: at("2026-10-01", "13:00:00"),
      },
    ];
    const inserted = await db
      .insert(shiftInstances)
      .values(
        fixtures.map((row) => ({
          ...row,
          institutionId,
          label: "Lote",
          status: "VAGO" as const,
        })),
      )
      .$returningId();
    const select = vi.spyOn(db, "select");
    const expectedIds = [inserted[0].id, inserted[2].id].sort((a, b) => a - b);
    try {
      const period = await shiftsAs(readerUserId).listByPeriod({
        startDate: "2026-09-28",
        endDate: "2026-10-04",
      });
      expect(period.map((row) => row.id).sort((a, b) => a - b)).toEqual(
        expectedIds,
      );
      expect(
        select.mock.calls.filter(
          ([fields]) =>
            (fields as { status?: unknown })?.status === monthlyRosters.status,
        ),
      ).toHaveLength(1);
      select.mockClear();
      const agenda = flattenAgenda(
        await shiftsAs(readerUserId).listAgenda({
          startDate: "2026-09-28",
          weeks: 1,
          scope: "geral",
        }),
      );
      expect(agenda.map((row) => row.id).sort((a, b) => a - b)).toEqual(
        expectedIds,
      );
      expect(
        select.mock.calls.filter(
          ([fields]) =>
            (fields as { status?: unknown })?.status === monthlyRosters.status,
        ),
      ).toHaveLength(1);
      expect(
        (await shiftsAs(readerUserId).get({ id: inserted[0].id })).id,
      ).toBe(inserted[0].id);
      await expect(
        shiftsAs(readerUserId).get({ id: inserted[1].id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      select.mockRestore();
      await db.delete(shiftInstances).where(
        inArray(
          shiftInstances.id,
          inserted.map((row) => row.id),
        ),
      );
      await db
        .delete(monthlyRosters)
        .where(eq(monthlyRosters.hospitalId, hospital.id));
      await db
        .delete(scheduleContexts)
        .where(eq(scheduleContexts.id, context.id));
      await db.delete(sectors).where(eq(sectors.id, sector.id));
      await db.delete(hospitals).where(eq(hospitals.id, hospital.id));
    }
  });
});
