// tests/confirmacao-nomeacao.test.ts — auditoria 22/08 (parte 2), cron de
// confirmação pré-plantão e indicação de substituto.
//
// - acceptNomination: transação, origem ainda ativa, mês não trancado,
//   status do turno derivado, tipo preservado.
// - rechecagem: NOMINATED sem aceite → TITULAR auto-confirmado e a
//   indicação limpa (SSO/push não vão para quem nunca aceitou); alocação
//   inativa encerra a rechecagem sem auto-confirmar.
// - confirm em alocação removida → erro claro.
// - push token: reatribuído ao usuário atual; desregistro remove.
// - cron: gatilho dispara dentro da janela (não só no minuto exato) e é
//   idempotente.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  dutyConfirmations,
  hospitals,
  institutions,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  pushTokens,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { confirmationRouter } from "../server/confirmation-router";
import { dispatchConfirmations, processRechecks } from "../server/cron/shift-confirmation-dispatcher";
import { getDb } from "../server/db";
import { addDaysToKey, dayKeyBrt, yearMonthBrt } from "../server/local-time";
import * as pushService from "../server/notifications-service";
import { syncDutyToComunica } from "../server/sso/duty-sync";

vi.mock("../server/sso/auto-sso", () => ({ triggerAutoSso: vi.fn(async () => undefined) }));
vi.mock("../server/sso/duty-sync", () => ({ syncDutyToComunica: vi.fn(async () => undefined) }));

describe("confirmação pré-plantão e indicação de substituto", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let titularUserId: number;
  let titularProId: number;
  let subUserId: number;
  let subProId: number;
  const userIds: number[] = [];
  const proIds: number[] = [];
  let pushSpy: ReturnType<typeof vi.spyOn>;

  // Plantão daqui a 2 dias, 13:00–19:00 (Tarde) no relógio do HOSPITAL
  // (-03:00 explícito: em CI o processo roda em UTC e setHours(13) seria
  // 10h no Brasil — fora da janela do gatilho "Tarde").
  const shiftDay = addDaysToKey(dayKeyBrt(new Date()), 2);
  const start = new Date(`${shiftDay}T13:00:00-03:00`);
  const end = new Date(`${shiftDay}T19:00:00-03:00`);

  const ctx = (userId: number) =>
    ({ user: { id: userId, role: "doctor", name: "T", email: `${userId}@t.local` }, institutionId, allowedInstitutionIds: [institutionId] }) as any;

  async function person(tag: string) {
    const [u] = await db.insert(users).values({ name: `CN ${tag} ${stamp}`, email: `cn-${tag}-${stamp}@test.local`, passwordHash: "test", role: "doctor" }).$returningId();
    const [p] = await db.insert(professionals).values({ userId: u.id, name: `CN ${tag} ${stamp}`, role: "Médico", userRole: "USER" }).$returningId();
    await db.insert(professionalInstitutions).values({ professionalId: p.id, userId: u.id, institutionId, roleInInstitution: "USER", isPrimary: true, active: true });
    await db.insert(professionalAccess).values({ institutionId, professionalId: p.id, hospitalId, sectorId, canAccess: true });
    userIds.push(u.id);
    proIds.push(p.id);
    return { userId: u.id, proId: p.id };
  }

  async function shiftWithTitular(type: "ON_DUTY" | "ON_CALL" = "ON_DUTY") {
    const [s] = await db
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, label: `CN ${stamp}`, startAt: start, endAt: end, status: "OCUPADO" })
      .$returningId();
    const [a] = await db
      .insert(shiftAssignmentsV2)
      .values({ shiftInstanceId: s.id, institutionId, hospitalId, sectorId, professionalId: titularProId, assignmentType: type, status: "OCUPADO", isActive: true, createdBy: titularUserId })
      .$returningId();
    return { shiftId: s.id, assignmentId: a.id };
  }

  async function nominated(assignmentId: number, shiftId: number, recheckAt = new Date(Date.now() - 60_000)) {
    const [c] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "NOMINATED",
        replacementProfessionalId: subProId,
        replacementUserId: subUserId,
        notifiedAt: new Date(),
        recheckAt,
        confirmationToken: crypto.randomUUID(),
      })
      .$returningId();
    const [row] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, c.id));
    return row;
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    pushSpy = vi.spyOn(pushService, "sendPushNotification").mockResolvedValue({ success: true, message: "mock" });
    const [inst] = await db
      .insert(institutions)
      .values({ name: `CN Tenant ${stamp}`, cnpj: `${stamp}`.slice(-14).padStart(14, "0"), legalName: `CN ${stamp}`, tradeName: `CN${stamp}`.slice(0, 20), isActive: true })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db.insert(hospitals).values({ institutionId, name: `CN Hospital ${stamp}` }).$returningId();
    hospitalId = h.id;
    const [sec] = await db.insert(sectors).values({ institutionId, hospitalId, name: `CN Setor ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    sectorId = sec.id;
    const t = await person("titular");
    titularUserId = t.userId;
    titularProId = t.proId;
    const s = await person("sub");
    subUserId = s.userId;
    subProId = s.proId;
  });

  beforeEach(async () => {
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.shiftInstanceId, ids));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(pushTokens).where(inArray(pushTokens.userId, userIds));
    pushSpy.mockClear();
    vi.mocked(syncDutyToComunica).mockClear();
  });

  afterAll(async () => {
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.shiftInstanceId, ids));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(pushTokens).where(inArray(pushTokens.userId, userIds));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, proIds));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, proIds));
    await db.delete(professionals).where(inArray(professionals.id, proIds));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, userIds));
    pushSpy.mockRestore();
  });

  it("acceptNomination: substituto assume com tipo preservado e turno OCUPADO; segunda tentativa → CONFLICT", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular("ON_CALL");
    const conf = await nominated(assignmentId, shiftId);
    const sub = confirmationRouter.createCaller(ctx(subUserId));
    const nom = await sub.getNomination({ confirmationToken: conf.confirmationToken });
    expect(nom?.shiftInstanceId).toBe(shiftId);

    const r = await sub.acceptNomination({ confirmationToken: conf.confirmationToken });
    expect(r.status).toBe("REPLACEMENT_CONFIRMED");
    const active = await db
      .select({ professionalId: shiftAssignmentsV2.professionalId, assignmentType: shiftAssignmentsV2.assignmentType })
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, shiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(active).toEqual([{ professionalId: subProId, assignmentType: "ON_CALL" }]);
    const [shift] = await db.select({ status: shiftInstances.status }).from(shiftInstances).where(eq(shiftInstances.id, shiftId));
    expect(shift.status).toBe("OCUPADO");
    await expect(sub.acceptNomination({ confirmationToken: conf.confirmationToken })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("acceptNomination: origem já removida → CONFLICT sem criar alocação; mês LOCKED → FORBIDDEN", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await db.update(shiftAssignmentsV2).set({ isActive: false }).where(eq(shiftAssignmentsV2.id, assignmentId));
    const sub = confirmationRouter.createCaller(ctx(subUserId));
    await expect(sub.acceptNomination({ confirmationToken: conf.confirmationToken })).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await db.select({ id: shiftAssignmentsV2.id }).from(shiftAssignmentsV2).where(and(eq(shiftAssignmentsV2.shiftInstanceId, shiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(rows).toHaveLength(0);

    const s2 = await shiftWithTitular();
    const conf2 = await nominated(s2.assignmentId, s2.shiftId);
    await db.insert(monthlyRosters).values({ institutionId, hospitalId, yearMonth: yearMonthBrt(start), status: "LOCKED" });
    await expect(sub.acceptNomination({ confirmationToken: conf2.confirmationToken })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("indicação com vínculo revogado falha antes de leitura, mutação ou push", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.professionalId, subProId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    const sub = confirmationRouter.createCaller(ctx(subUserId));
    try {
      await expect(
        sub.getNomination({ confirmationToken: conf.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        sub.acceptNomination({ confirmationToken: conf.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        sub.declineNomination({ confirmationToken: conf.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const [after] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(after.status).toBe("NOMINATED");
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(professionalInstitutions.professionalId, subProId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    }
  });

  it("decline e nominateReplacement validam o fluxo público e o vínculo atual do indicado", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const token = crypto.randomUUID();
    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "PENDING",
        notifiedAt: new Date(),
        confirmationToken: token,
      })
      .$returningId();
    const titular = confirmationRouter.createCaller(ctx(titularUserId));

    await expect(titular.decline({ confirmationToken: token, reason: "Indisponível" })).resolves.toMatchObject({
      status: "DECLINED",
    });
    expect(vi.mocked(syncDutyToComunica)).toHaveBeenCalledWith(inserted.id, "WITHDRAW");

    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.professionalId, subProId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    try {
      await expect(
        titular.nominateReplacement({
          confirmationToken: token,
          replacementProfessionalId: subProId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(pushSpy).not.toHaveBeenCalled();
      const [unchanged] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, inserted.id));
      expect(unchanged.status).toBe("DECLINED");
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(professionalInstitutions.professionalId, subProId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    }

    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, subProId));
    try {
      await expect(
        titular.nominateReplacement({
          confirmationToken: token,
          replacementProfessionalId: subProId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, subProId));
    }

    const [poisonLinkUser] = await db
      .insert(users)
      .values({
        name: `CN poison link ${stamp}`,
        email: `cn-poison-link-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    userIds.push(poisonLinkUser.id);
    await db
      .update(professionalInstitutions)
      .set({ userId: poisonLinkUser.id })
      .where(
        and(
          eq(professionalInstitutions.professionalId, subProId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    try {
      await expect(
        titular.nominateReplacement({
          confirmationToken: token,
          replacementProfessionalId: subProId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ userId: subUserId })
        .where(
          and(
            eq(professionalInstitutions.professionalId, subProId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    }

    await expect(
      titular.nominateReplacement({
        confirmationToken: token,
        replacementProfessionalId: subProId,
      }),
    ).resolves.toMatchObject({ status: "NOMINATED" });
    expect(pushSpy).toHaveBeenCalledWith(
      subUserId,
      expect.objectContaining({ data: expect.objectContaining({ confirmationToken: token }) }),
    );
  });

  it("decline e nominateReplacement recusam confirmação cuja identidade diverge da alocação", async () => {
    const sub = confirmationRouter.createCaller(ctx(subUserId));

    const first = await shiftWithTitular();
    const declineToken = crypto.randomUUID();
    const [declinePoisoned] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: first.shiftId,
        assignmentId: first.assignmentId,
        professionalId: subProId,
        userId: subUserId,
        status: "PENDING",
        notifiedAt: new Date(),
        confirmationToken: declineToken,
      })
      .$returningId();
    await expect(
      sub.decline({ confirmationToken: declineToken, reason: "Não deveria alterar" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const second = await shiftWithTitular();
    const nominateToken = crypto.randomUUID();
    const [nominatePoisoned] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: second.shiftId,
        assignmentId: second.assignmentId,
        professionalId: subProId,
        userId: subUserId,
        status: "DECLINED",
        notifiedAt: new Date(),
        confirmationToken: nominateToken,
      })
      .$returningId();
    await expect(
      sub.nominateReplacement({
        confirmationToken: nominateToken,
        replacementProfessionalId: titularProId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rows = await db
      .select({ id: dutyConfirmations.id, status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(inArray(dutyConfirmations.id, [declinePoisoned.id, nominatePoisoned.id]));
    expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [declinePoisoned.id, "PENDING"],
        [nominatePoisoned.id, "DECLINED"],
      ]),
    );
    expect(pushSpy).not.toHaveBeenCalled();
    expect(vi.mocked(syncDutyToComunica)).not.toHaveBeenCalled();
  });

  it("rechecagem: NOMINATED sem aceite → titular auto-confirmado, indicação limpa, substituto avisado", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await processRechecks(new Date());
    const [row] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, conf.id));
    expect(row.status).toBe("AUTO_CONFIRMED");
    expect(row.replacementUserId).toBeNull();
    expect(row.replacementProfessionalId).toBeNull();
    const targets = pushSpy.mock.calls.map((c) => c[0]);
    expect(targets).toContain(subUserId); // "Indicação expirada"
    expect(targets).toContain(titularUserId); // "confirmado automaticamente"
    // Titular continua sendo o alocado.
    const active = await db.select({ professionalId: shiftAssignmentsV2.professionalId }).from(shiftAssignmentsV2).where(and(eq(shiftAssignmentsV2.shiftInstanceId, shiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(active).toEqual([{ professionalId: titularProId }]);
  });

  it("rechecagem: alocação removida → encerra sem auto-confirmar; confirm manual → erro claro", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const [c] = await db
      .insert(dutyConfirmations)
      .values({ institutionId, shiftInstanceId: shiftId, assignmentId, professionalId: titularProId, userId: titularUserId, status: "PENDING", notifiedAt: new Date(), recheckAt: new Date(Date.now() - 60_000), confirmationToken: crypto.randomUUID() })
      .$returningId();
    await db.update(shiftAssignmentsV2).set({ isActive: false }).where(eq(shiftAssignmentsV2.id, assignmentId));
    const [conf] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, c.id));

    await expect(confirmationRouter.createCaller(ctx(titularUserId)).confirm({ confirmationToken: conf.confirmationToken })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await processRechecks(new Date());
    const [row] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, c.id));
    expect(row.status).toBe("PENDING");
    expect(row.recheckAt).toBeNull();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("não confirma candidatura PENDENTE nem titular sem acesso ao setor", async () => {
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: `CN gate ${stamp}`,
        startAt: start,
        endAt: end,
        status: "PENDENTE",
      })
      .$returningId();
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: titularProId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
        createdBy: titularUserId,
      })
      .$returningId();
    const trigger = {
      notifyHour: 11,
      notifyMinute: 0,
      shiftStartTime: "13:00",
      shiftEndTime: "19:00",
      label: "Tarde",
      shiftNextDay: false,
    };
    const dispatchAt = new Date(`${shiftDay}T11:07:00-03:00`);

    await dispatchConfirmations(dispatchAt, trigger);
    expect(
      await db
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.assignmentId, assignment.id)),
    ).toHaveLength(0);
    expect(pushSpy).not.toHaveBeenCalled();

    const pendingToken = crypto.randomUUID();
    const [pending] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shift.id,
        assignmentId: assignment.id,
        professionalId: titularProId,
        userId: titularUserId,
        status: "PENDING",
        notifiedAt: new Date(),
        confirmationToken: pendingToken,
      })
      .$returningId();
    await expect(
      confirmationRouter.createCaller(ctx(titularUserId)).confirm({ confirmationToken: pendingToken }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await db.delete(dutyConfirmations).where(eq(dutyConfirmations.id, pending.id));

    await db
      .update(shiftAssignmentsV2)
      .set({ status: "OCUPADO" })
      .where(eq(shiftAssignmentsV2.id, assignment.id));
    await db.update(shiftInstances).set({ status: "OCUPADO" }).where(eq(shiftInstances.id, shift.id));
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, titularProId));
    try {
      await dispatchConfirmations(dispatchAt, trigger);
      expect(
        await db
          .select({ id: dutyConfirmations.id })
          .from(dutyConfirmations)
          .where(eq(dutyConfirmations.assignmentId, assignment.id)),
      ).toHaveLength(0);

      const noAccessToken = crypto.randomUUID();
      const [noAccess] = await db
        .insert(dutyConfirmations)
        .values({
          institutionId,
          shiftInstanceId: shift.id,
          assignmentId: assignment.id,
          professionalId: titularProId,
          userId: titularUserId,
          status: "PENDING",
          notifiedAt: new Date(),
          confirmationToken: noAccessToken,
        })
        .$returningId();
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).confirm({
          confirmationToken: noAccessToken,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const [unchanged] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, noAccess.id));
      expect(unchanged.status).toBe("PENDING");
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, titularProId));
    }
  });

  it("cron: disparo dentro da janela é idempotente (uma confirmação por alocação)", async () => {
    const { assignmentId } = await shiftWithTitular();
    // Gatilho "Tarde" (11:00 → plantão 13:00 do mesmo dia), simulando 11:07 no dia do plantão.
    const trigger = { notifyHour: 11, notifyMinute: 0, shiftStartTime: "13:00", shiftEndTime: "19:00", label: "Tarde", shiftNextDay: false };
    const at1107 = new Date(`${shiftDay}T11:07:00-03:00`);
    await dispatchConfirmations(at1107, trigger);
    await dispatchConfirmations(new Date(at1107.getTime() + 60_000), trigger);
    const rows = await db.select({ id: dutyConfirmations.id }).from(dutyConfirmations).where(eq(dutyConfirmations.assignmentId, assignmentId));
    expect(rows).toHaveLength(1);
  });

  it("push token: troca de conta reatribui; desregistro remove", async () => {
    const token = `ExponentPushToken[cn-${stamp}]`;
    await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({ token, platform: "ios" });
    await confirmationRouter.createCaller(ctx(subUserId)).registerPushToken({ token, platform: "ios" });
    const [row] = await db.select({ userId: pushTokens.userId }).from(pushTokens).where(eq(pushTokens.token, token));
    expect(row.userId).toBe(subUserId);
    await confirmationRouter.createCaller(ctx(subUserId)).unregisterPushToken({ token });
    const left = await db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.token, token));
    expect(left).toHaveLength(0);
  });
});
