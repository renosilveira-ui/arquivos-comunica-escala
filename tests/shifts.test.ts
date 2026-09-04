// tests/shifts.test.ts — CRUD básico de turnos via shiftsRouter
// (substitui o placeholder `describe.skip` deixado após truncamento do arquivo).
//
//   create (a partir de template, horário de parede -03:00) → get → update
//   (horários e modalidade) → listByPeriod enxerga o turno → USER comum não
//   cria nem edita.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  medicalSpecialties,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAuditLog,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { addDaysToKey, dayKeyBrt } from "../server/local-time";
import { shiftsRouter } from "../server/shifts-crud";

describe("shifts: create / get / update / listByPeriod", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let templateId: number;
  let scheduleContextId: number;
  let medicalSpecialtyId: number;
  let managerUserId: number;
  let managerProId: number;
  let doctorUserId: number;
  let doctorProId: number;
  const day = dayKeyBrt(new Date()); // hoje (mês corrente)

  const ctx = (userId: number, role: "manager" | "doctor") =>
    ({
      user: {
        id: userId,
        role,
        name: "T",
        email: `${userId}@t.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    }) as any;
  const asManager = () =>
    shiftsRouter.createCaller(ctx(managerUserId, "manager"));
  const asDoctor = () => shiftsRouter.createCaller(ctx(doctorUserId, "doctor"));

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const [inst] = await db
      .insert(institutions)
      .values({
        name: `Shifts Tenant ${stamp}`,
        cnpj: `${stamp}5`.slice(-14).padStart(14, "0"),
        legalName: `Shifts ${stamp}`,
        tradeName: `SH${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Shifts Hospital ${stamp}` })
      .$returningId();
    hospitalId = h.id;
    const [sec] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Shifts Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sec.id;
    const [specialty] = await db
      .select({ id: medicalSpecialties.id })
      .from(medicalSpecialties)
      .where(eq(medicalSpecialties.code, "ANESTESIOLOGIA"))
      .limit(1);
    if (!specialty) throw new Error("Catálogo de especialidades ausente");
    medicalSpecialtyId = specialty.id;
    const [context] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        medicalSpecialtyId,
        active: true,
      })
      .$returningId();
    scheduleContextId = context.id;
    const [t] = await db
      .insert(shiftTemplates)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        name: "Noite",
        startTime: "19:00:00",
        endTime: "07:00:00",
      })
      .$returningId();
    templateId = t.id;
    const person = async (
      tag: string,
      role: "manager" | "doctor",
      link: "GESTOR_PLUS" | "USER",
    ) => {
      const [u] = await db
        .insert(users)
        .values({
          name: `Shifts ${tag} ${stamp}`,
          email: `shifts-${tag}-${stamp}@test.local`,
          passwordHash: "test",
          role,
        })
        .$returningId();
      const [p] = await db
        .insert(professionals)
        .values({
          userId: u.id,
          name: `Shifts ${tag} ${stamp}`,
          role: "Médico",
          userRole: link,
          medicalSpecialtyId,
        })
        .$returningId();
      await db.insert(professionalInstitutions).values({
        professionalId: p.id,
        userId: u.id,
        institutionId,
        roleInInstitution: link,
        isPrimary: true,
        active: true,
      });
      await db.insert(professionalAccess).values({
        institutionId,
        professionalId: p.id,
        hospitalId,
        sectorId,
        canAccess: true,
      });
      return { userId: u.id, proId: p.id };
    };
    const m = await person("gestor", "manager", "GESTOR_PLUS");
    managerUserId = m.userId;
    managerProId = m.proId;
    const [otherInstitution] = await db
      .insert(institutions)
      .values({
        name: `Shifts Other Tenant ${stamp}`,
        cnpj: `${stamp}6`.slice(-14).padStart(14, "0"),
        legalName: `Shifts Other ${stamp}`,
        tradeName: `SHO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    otherInstitutionId = otherInstitution.id;
    await db.insert(professionalInstitutions).values({
      professionalId: managerProId,
      userId: managerUserId,
      institutionId: otherInstitutionId,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: false,
      active: true,
    });
    const d = await person("medico", "doctor", "USER");
    doctorUserId = d.userId;
    doctorProId = d.proId;
  });

  afterAll(async () => {
    const mine = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db
        .delete(auditTrail)
        .where(inArray(auditTrail.shiftInstanceId, ids));
      await db
        .delete(shiftAuditLog)
        .where(inArray(shiftAuditLog.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db
      .delete(auditTrail)
      .where(eq(auditTrail.institutionId, institutionId));
    await db
      .delete(shiftTemplates)
      .where(eq(shiftTemplates.institutionId, institutionId));
    await db
      .delete(professionalAccess)
      .where(
        inArray(professionalAccess.professionalId, [managerProId, doctorProId]),
      );
    await db
      .delete(professionalInstitutions)
      .where(
        inArray(professionalInstitutions.professionalId, [
          managerProId,
          doctorProId,
        ]),
      );
    await db
      .delete(professionals)
      .where(inArray(professionals.id, [managerProId, doctorProId]));
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    await db
      .delete(scheduleContexts)
      .where(eq(scheduleContexts.id, scheduleContextId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db
      .delete(institutions)
      .where(eq(institutions.id, otherInstitutionId));
    await db
      .delete(users)
      .where(inArray(users.id, [managerUserId, doctorUserId]));
  });

  it("create a partir do template grava instante UTC do horário de parede (-03:00) e turno noturno vira o dia", async () => {
    const created = await asManager().create({
      date: day,
      shiftTemplateId: templateId,
    });
    expect(created).toBeTruthy();
    expect(created!.label).toBe("Noite");
    expect(created!.status).toBe("VAGO");
    expect(created!.startAt.toISOString()).toBe(
      new Date(`${day}T19:00:00-03:00`).toISOString(),
    );
    expect(created!.endAt.toISOString()).toBe(
      new Date(`${addDaysToKey(day, 1)}T07:00:00-03:00`).toISOString(),
    );
    expect(dayKeyBrt(created!.startAt)).toBe(day);
  });

  it("serializa creates idênticos pela chave natural: 1 sucesso, 1 CONFLICT e 1 auditoria", async () => {
    const raceDay = addDaysToKey(day, 2);
    const startAt = new Date(`${raceDay}T19:00:00-03:00`);
    const endAt = new Date(`${addDaysToKey(raceDay, 1)}T07:00:00-03:00`);

    const outcomes = await Promise.allSettled([
      asManager().create({ date: raceDay, shiftTemplateId: templateId }),
      asManager().create({ date: raceDay, shiftTemplateId: templateId }),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });

    const rows = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          eq(shiftInstances.hospitalId, hospitalId),
          eq(shiftInstances.sectorId, sectorId),
          eq(shiftInstances.startAt, startAt),
          eq(shiftInstances.endAt, endAt),
          eq(shiftInstances.label, "Noite"),
        ),
      );
    expect(rows).toHaveLength(1);

    const [operationalAudits, governanceAudits] = await Promise.all([
      db
        .select({ id: shiftAuditLog.id })
        .from(shiftAuditLog)
        .where(eq(shiftAuditLog.shiftInstanceId, rows[0].id)),
      db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(eq(auditTrail.shiftInstanceId, rows[0].id)),
    ]);
    expect(operationalAudits).toHaveLength(1);
    expect(governanceAudits).toHaveLength(1);
  });

  it("create duplicado segue shift→identity e não deadlocka com mutação de identidade", async () => {
    const [existing] = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          eq(shiftInstances.hospitalId, hospitalId),
          eq(shiftInstances.sectorId, sectorId),
          eq(shiftInstances.startAt, new Date(`${day}T19:00:00-03:00`)),
          eq(shiftInstances.label, "Noite"),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Turno base ausente");

    for (let round = 0; round < 5; round += 1) {
      let signalShiftLocked!: () => void;
      const shiftLocked = new Promise<void>((resolve) => {
        signalShiftLocked = resolve;
      });
      const identityMutation = db.transaction(async (tx) => {
        const [lockedShift] = await tx
          .select({ id: shiftInstances.id })
          .from(shiftInstances)
          .where(eq(shiftInstances.id, existing.id))
          .limit(1)
          .for("share");
        if (!lockedShift) throw new Error("Turno deixou de existir");
        signalShiftLocked();

        // Simula a fronteira administrativa: topologia operacional primeiro,
        // identidade depois. O create deve aguardar o shift sem reter user X.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const [lockedUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, managerUserId))
          .limit(1)
          .for("update");
        if (!lockedUser) throw new Error("Gestor deixou de existir");
      });

      await shiftLocked;
      const create = asManager().create({
        date: day,
        shiftTemplateId: templateId,
      });
      const [identityResult, createResult] = await Promise.allSettled([
        identityMutation,
        create,
      ]);

      expect(identityResult.status).toBe("fulfilled");
      expect(createResult.status).toBe("rejected");
      if (createResult.status === "rejected") {
        expect(createResult.reason).toMatchObject({ code: "CONFLICT" });
        expect(String(createResult.reason?.message)).not.toMatch(
          /deadlock|ER_LOCK_DEADLOCK/i,
        );
      }
    }
  });

  it("update sequencial não pode colidir com a chave natural de outro turno", async () => {
    const occupiedDay = addDaysToKey(day, 4);
    const movingDay = addDaysToKey(day, 5);
    const occupied = await asManager().create({
      date: occupiedDay,
      shiftTemplateId: templateId,
    });
    const moving = await asManager().create({
      date: movingDay,
      shiftTemplateId: templateId,
    });
    if (!occupied || !moving)
      throw new Error("Falha ao preparar turnos do teste");

    await expect(
      asManager().update({
        id: moving.id,
        startAt: occupied.startAt.toISOString(),
        endAt: occupied.endAt.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [persisted] = await db
      .select({ startAt: shiftInstances.startAt, endAt: shiftInstances.endAt })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, moving.id));
    expect(persisted.startAt.toISOString()).toBe(moving.startAt.toISOString());
    expect(persisted.endAt.toISOString()).toBe(moving.endAt.toISOString());

    const [operationalAudits, governanceAudits] = await Promise.all([
      db
        .select({ id: shiftAuditLog.id })
        .from(shiftAuditLog)
        .where(eq(shiftAuditLog.shiftInstanceId, moving.id)),
      db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(eq(auditTrail.shiftInstanceId, moving.id)),
    ]);
    expect(operationalAudits).toHaveLength(1);
    expect(governanceAudits).toHaveLength(1);
  });

  it("serializa updates convergentes: 1 sucesso, 1 CONFLICT e nenhum audit fantasma", async () => {
    const firstDay = addDaysToKey(day, 6);
    const secondDay = addDaysToKey(day, 7);
    const targetDay = addDaysToKey(day, 8);
    const first = await asManager().create({
      date: firstDay,
      shiftTemplateId: templateId,
    });
    const second = await asManager().create({
      date: secondDay,
      shiftTemplateId: templateId,
    });
    if (!first || !second) throw new Error("Falha ao preparar turnos do teste");
    const targetStartAt = new Date(`${targetDay}T19:00:00-03:00`);
    const targetEndAt = new Date(
      `${addDaysToKey(targetDay, 1)}T07:00:00-03:00`,
    );
    const update = (id: number) =>
      asManager().update({
        id,
        startAt: targetStartAt.toISOString(),
        endAt: targetEndAt.toISOString(),
      });

    const outcomes = await Promise.allSettled([
      update(first.id),
      update(second.id),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });

    const converged = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          eq(shiftInstances.hospitalId, hospitalId),
          eq(shiftInstances.sectorId, sectorId),
          eq(shiftInstances.startAt, targetStartAt),
          eq(shiftInstances.endAt, targetEndAt),
          eq(shiftInstances.label, "Noite"),
        ),
      );
    expect(converged).toHaveLength(1);

    const ids = [first.id, second.id];
    const [operationalAudits, governanceAudits] = await Promise.all([
      db
        .select({ id: shiftAuditLog.id })
        .from(shiftAuditLog)
        .where(inArray(shiftAuditLog.shiftInstanceId, ids)),
      db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(inArray(auditTrail.shiftInstanceId, ids)),
    ]);
    expect(operationalAudits).toHaveLength(3);
    expect(governanceAudits).toHaveLength(3);
  });

  it("get devolve o turno com setor/hospital; turno de outro tenant → NOT_FOUND", async () => {
    const [row] = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    const got = await asManager().get({ id: row.id });
    expect(got).toMatchObject({ id: row.id, label: "Noite" });
    const other = shiftsRouter.createCaller({
      ...ctx(managerUserId, "manager"),
      institutionId: otherInstitutionId,
      allowedInstitutionIds: [otherInstitutionId],
    });
    await expect(other.get({ id: row.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("update muda horários/modalidade e listByPeriod enxerga o turno no dia", async () => {
    const [row] = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    const newStart = new Date(`${day}T20:00:00-03:00`);
    const newEnd = new Date(`${addDaysToKey(day, 1)}T08:00:00-03:00`);
    const updated = await asManager().update({
      id: row.id,
      startAt: newStart.toISOString(),
      endAt: newEnd.toISOString(),
      modality: "SOBREAVISO",
    });
    expect(updated?.startAt.toISOString()).toBe(newStart.toISOString());
    expect(updated?.endAt.toISOString()).toBe(newEnd.toISOString());
    expect(updated?.modality).toBe("SOBREAVISO");
    expect(updated?.coverageType).toBeNull(); // invariante: SOBREAVISO ⇒ coverageType NULL

    const list = await asDoctor().listByPeriod({
      startDate: new Date(`${day}T00:00:00-03:00`).toISOString(),
      endDate: new Date(`${addDaysToKey(day, 1)}T00:00:00-03:00`).toISOString(),
    });
    expect(list.map((s: any) => s.id)).toContain(row.id);
  });

  it("listByPeriod com chaves date-only usa dias civis -03:00: inclui a última noite do mês e não vaza o mês anterior", async () => {
    // Template tardio: 23:00 no relógio do hospital cruza para o dia UTC
    // seguinte, expondo a virada. new Date("YYYY-MM-DD") (UTC) vazava o fim do
    // mês anterior e cortava as últimas horas do último dia.
    const [lateTemplate] = await db
      .insert(shiftTemplates)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        name: `Madrugada ${stamp}`,
        startTime: "23:00:00",
        endTime: "07:00:00",
      })
      .$returningId();

    // Mês fixo e futuro (independe do mês do runner e da guarda de edição).
    const prevMonthLastDay = "2027-02-28"; // 23:00 -03 = 2027-03-01T02:00Z
    const monthFirstDay = "2027-03-01"; // 23:00 -03 = 2027-03-02T02:00Z
    const monthLastDay = "2027-03-31"; // 23:00 -03 = 2027-04-01T02:00Z

    const prevLeak = await asManager().create({
      date: prevMonthLastDay,
      shiftTemplateId: lateTemplate.id,
    });
    const first = await asManager().create({
      date: monthFirstDay,
      shiftTemplateId: lateTemplate.id,
    });
    const last = await asManager().create({
      date: monthLastDay,
      shiftTemplateId: lateTemplate.id,
    });

    const rows = await asManager().listByPeriod({
      startDate: monthFirstDay,
      endDate: monthLastDay,
    });
    const ids = rows.map((s: any) => s.id);

    // A última noite (23:00 do dia 31, que é 01/04 02:00Z) precisa aparecer.
    expect(ids).toContain(last!.id);
    // O primeiro dia aparece normalmente.
    expect(ids).toContain(first!.id);
    // A noite de 28/02 (01/03 02:00Z) NÃO pode vazar para março.
    expect(ids).not.toContain(prevLeak!.id);

    // Instantes ISO completos usam limite superior meio-aberto (lt): um fim no
    // exato startAt de `last` o EXCLUI; um instante logo depois o inclui.
    const exclusive = await asManager().listByPeriod({
      startDate: monthFirstDay,
      endDate: last!.startAt.toISOString(),
    });
    expect(exclusive.map((s: any) => s.id)).not.toContain(last!.id);
    const inclusive = await asManager().listByPeriod({
      startDate: monthFirstDay,
      endDate: new Date(last!.startAt.getTime() + 1).toISOString(),
    });
    expect(inclusive.map((s: any) => s.id)).toContain(last!.id);
  });

  it("listByPeriod rejeita formato inválido, janela invertida e teto acima de 93 dias", async () => {
    await expect(
      asDoctor().listByPeriod({
        startDate: "lixo",
        endDate: "2026-09-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      asDoctor().listByPeriod({
        startDate: "2026-02-29",
        endDate: "2026-03-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      asDoctor().listByPeriod({
        startDate: "2026-09-01T10:00:00",
        endDate: "2026-09-02T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      asDoctor().listByPeriod({
        startDate: "2026-09-10",
        endDate: "2026-09-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      asDoctor().listByPeriod({
        startDate: "2026-09-01T10:00:00.000Z",
        endDate: "2026-09-01T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      asDoctor().listByPeriod({
        startDate: "2026-01-01",
        endDate: addDaysToKey("2026-01-01", 93),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      asDoctor().listByPeriod({
        startDate: "1900-01-01",
        endDate: "2200-01-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const exact = await asDoctor().listByPeriod({
      startDate: "2026-01-01",
      endDate: addDaysToKey("2026-01-01", 92),
    });
    expect(Array.isArray(exact)).toBe(true);

    await expect(
      asDoctor().listByPeriod({
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        scheduleContextId: 9_999_999,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("USER comum não cria nem edita turno", async () => {
    await expect(
      asDoctor().create({ date: day, shiftTemplateId: templateId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    await expect(
      asDoctor().update({
        id: row.id,
        startAt: new Date(`${day}T21:00:00-03:00`).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
