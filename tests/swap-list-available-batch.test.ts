import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { swapRouter } from "../server/swap-router";
import { yearMonthBrt } from "../server/local-time";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = {
  userId: number;
  professionalId: number;
  accessId: number | null;
  name: string;
};
type ShiftFixture = { shiftId: number; assignmentId: number };

describe("swaps.listAvailable — validação canônica em lote", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let actor: Identity;
  let source: Identity;
  let noAccessSource: Identity;
  let revokedPiSource: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const stamp = Date.now();

  const at = (dayOffset: number, hour: number): Date => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 400 + dayOffset);
    value.setUTCHours(hour, 0, 0, 0);
    return value;
  };

  async function createIdentity(
    label: string,
    withAccess = true,
  ): Promise<Identity> {
    const name = `swap-batch-${stamp}-${label}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name,
        role: "Médico",
        specialty: "Anestesiologia",
        userRole: "USER",
      })
      .$returningId();
    professionalIds.push(professional.id);
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: user.id,
      institutionId,
      roleInInstitution: "USER",
      active: true,
    });
    let accessId: number | null = null;
    if (withAccess) {
      const [access] = await db
        .insert(professionalAccess)
        .values({
          institutionId,
          professionalId: professional.id,
          hospitalId,
          sectorId,
          canAccess: true,
        })
        .$returningId();
      accessId = access.id;
    }
    return { userId: user.id, professionalId: professional.id, accessId, name };
  }

  async function createShift(
    owner: Identity,
    dayOffset: number,
    startHour = 8,
    endHour = 14,
  ): Promise<ShiftFixture> {
    const startAt = at(dayOffset, startHour);
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(startAt),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: `swap-batch-${stamp}-shift-${dayOffset}-${owner.professionalId}`,
        specialty: "Anestesiologia",
        startAt,
        endAt: at(dayOffset, endHour),
        status: "OCUPADO",
      })
      .$returningId();
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: owner.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    return { shiftId: shift.id, assignmentId: assignment.id };
  }

  async function createOffer(
    owner: Identity,
    shift: ShiftFixture,
    reason: string,
    input: {
      type?: "CESSAO" | "TRANSFER" | "SWAP";
      toProfessionalId?: number | null;
      toUserId?: number | null;
      toShiftInstanceId?: number | null;
      toAssignmentId?: number | null;
      fromUserId?: number;
      sectorContextId?: number | null;
    } = {},
  ): Promise<number> {
    const [offer] = await db
      .insert(swapRequests)
      .values({
        type: input.type ?? "CESSAO",
        status: "PENDING",
        fromProfessionalId: owner.professionalId,
        fromUserId: input.fromUserId ?? owner.userId,
        fromShiftInstanceId: shift.shiftId,
        fromAssignmentId: shift.assignmentId,
        toProfessionalId: input.toProfessionalId ?? null,
        toUserId: input.toUserId ?? null,
        toShiftInstanceId: input.toShiftInstanceId ?? null,
        toAssignmentId: input.toAssignmentId ?? null,
        institutionId,
        hospitalId,
        sectorId:
          input.sectorContextId === undefined
            ? sectorId
            : input.sectorContextId,
        reason: `swap-batch-${stamp}-${reason}`,
      })
      .$returningId();
    return offer.id;
  }

  function callerFor(identity: Identity, sessionVersion = 1) {
    return swapRouter.createCaller({
      user: {
        id: identity.userId,
        role: "doctor",
        name: identity.name,
        email: `${identity.name}@example.test`,
        sessionVersion,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as never);
  }

  const caller = (sessionVersion = 1) => callerFor(actor, sessionVersion);

  async function measured<T>(
    operation: () => Promise<T>,
  ): Promise<{ count: number; value: T }> {
    const client = db.$client as unknown as {
      query: (...args: unknown[]) => unknown;
      execute: (...args: unknown[]) => unknown;
    };
    const originalQuery = client.query;
    const originalExecute = client.execute;
    let count = 0;
    client.query = function countedQuery(
      this: typeof client,
      ...args: unknown[]
    ) {
      count += 1;
      return Reflect.apply(originalQuery, this, args);
    };
    client.execute = function countedExecute(
      this: typeof client,
      ...args: unknown[]
    ) {
      count += 1;
      return Reflect.apply(originalExecute, this, args);
    };
    try {
      const value = await operation();
      return { count, value };
    } finally {
      client.query = originalQuery;
      client.execute = originalExecute;
    }
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Swap Batch ${stamp}`,
        cnpj: String(stamp).slice(-14).padStart(14, "7"),
        legalName: `Swap Batch ${stamp}`,
        tradeName: `SB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Swap Batch Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Swap Batch Setor ${stamp}`,
        category: "cirurgico",
        color: "#123456",
      })
      .$returningId();
    sectorId = sector.id;
    actor = await createIdentity("actor");
    source = await createIdentity("source");
    noAccessSource = await createIdentity("no-access-source", false);
    revokedPiSource = await createIdentity("revoked-pi-source");
  });

  beforeEach(async () => {
    await db
      .delete(swapRequests)
      .where(eq(swapRequests.institutionId, institutionId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.institutionId, institutionId));
    await db
      .delete(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    await db
      .update(users)
      .set({ sessionVersion: 1, approvalStatus: "APPROVED", deletedAt: null })
      .where(inArray(users.id, userIds));
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(inArray(professionalInstitutions.professionalId, professionalIds));
    await db
      .update(institutions)
      .set({ isActive: true })
      .where(eq(institutions.id, institutionId));
    if (actor.accessId !== null) {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.id, actor.accessId));
    }
    if (source.accessId !== null) {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.id, source.accessId));
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(swapRequests)
      .where(eq(swapRequests.institutionId, institutionId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.institutionId, institutionId));
    await db
      .delete(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    await db
      .delete(professionals)
      .where(inArray(professionals.id, professionalIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  it("mantém exatamente três queries para 1 ou 5 candidatos", async () => {
    const firstShift = await createShift(source, 1);
    await createOffer(source, firstShift, "count-1");
    const one = await measured(() =>
      caller().listAvailable({ type: "CESSAO" }),
    );
    expect(one.value).toHaveLength(1);

    for (let index = 2; index <= 5; index += 1) {
      const shift = await createShift(source, index);
      await createOffer(source, shift, `count-${index}`);
    }
    const five = await measured(() =>
      caller().listAvailable({ type: "CESSAO" }),
    );
    expect(five.value).toHaveLength(5);
    expect({ one: one.count, five: five.count }).toEqual({ one: 3, five: 3 });
  });

  it("preserva o output e omite em lote tuplas, identidades, ACLs e conflitos envenenados", async () => {
    const validOneWayShift = await createShift(source, 10);
    const validOneWayId = await createOffer(
      source,
      validOneWayShift,
      "valid-one-way",
      {
        toProfessionalId: actor.professionalId,
        toUserId: actor.userId,
      },
    );

    const validSwapSource = await createShift(source, 11, 8, 12);
    const validSwapTarget = await createShift(actor, 11, 14, 18);
    const validSwapId = await createOffer(
      source,
      validSwapSource,
      "valid-swap",
      {
        type: "SWAP",
        toShiftInstanceId: validSwapTarget.shiftId,
      },
    );

    const badIdentityShift = await createShift(source, 12);
    const badIdentityId = await createOffer(
      source,
      badIdentityShift,
      "bad-source-identity",
      {
        fromUserId: noAccessSource.userId,
      },
    );
    const missingAccessShift = await createShift(noAccessSource, 13);
    const missingAccessId = await createOffer(
      noAccessSource,
      missingAccessShift,
      "missing-source-access",
    );
    const nullContextShift = await createShift(source, 14);
    const nullContextId = await createOffer(
      source,
      nullContextShift,
      "null-sector-context",
      {
        sectorContextId: null,
      },
    );
    const partialRecipientShift = await createShift(source, 15);
    const partialRecipientId = await createOffer(
      source,
      partialRecipientShift,
      "partial-recipient",
      { toProfessionalId: actor.professionalId, toUserId: null },
    );

    const actorConflict = await createShift(actor, 16, 9, 13);
    const conflictSource = await createShift(source, 16, 8, 14);
    const conflictId = await createOffer(
      source,
      conflictSource,
      "actor-time-conflict",
    );
    expect(actorConflict.assignmentId).toBeGreaterThan(0);

    const invalidTargetSource = await createShift(source, 17, 8, 12);
    const invalidTarget = await createShift(actor, 17, 14, 18);
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, invalidTarget.assignmentId));
    const invalidTargetId = await createOffer(
      source,
      invalidTargetSource,
      "inactive-target-tuple",
      {
        type: "SWAP",
        toShiftInstanceId: invalidTarget.shiftId,
      },
    );

    const revokedPiShift = await createShift(revokedPiSource, 18);
    const revokedPiId = await createOffer(
      revokedPiSource,
      revokedPiShift,
      "inactive-source-membership",
    );
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(
            professionalInstitutions.professionalId,
            revokedPiSource.professionalId,
          ),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );

    const duplicateSource = await createShift(source, 19);
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: duplicateSource.shiftId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: source.professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    const duplicateSourceId = await createOffer(
      source,
      duplicateSource,
      "duplicate-source-assignment",
    );

    const rows = await caller().listAvailable({});
    const ids = rows.map(({ id }) => Number(id));
    expect(ids).toEqual([validOneWayId, validSwapId]);
    expect(ids).not.toEqual(
      expect.arrayContaining([
        badIdentityId,
        missingAccessId,
        nullContextId,
        partialRecipientId,
        conflictId,
        invalidTargetId,
        revokedPiId,
        duplicateSourceId,
      ]),
    );

    const oneWay = rows[0];
    expect(oneWay).toMatchObject({
      id: validOneWayId,
      type: "CESSAO",
      reason: `swap-batch-${stamp}-valid-one-way`,
      fromProfessional: { name: source.name, role: "Médico" },
      fromShift: {
        id: validOneWayShift.shiftId,
        hospitalName: `Swap Batch Hospital ${stamp}`,
        sectorName: `Swap Batch Setor ${stamp}`,
      },
      toShift: null,
    });
    expect(oneWay.fromShift.startAt.getTime()).toBe(at(10, 8).getTime());
    expect(oneWay.fromShift.endAt.getTime()).toBe(at(10, 14).getTime());

    const bidirectional = rows[1];
    expect(bidirectional).toMatchObject({
      id: validSwapId,
      type: "SWAP",
      fromShift: { id: validSwapSource.shiftId },
      toShift: {
        id: validSwapTarget.shiftId,
        hospitalName: `Swap Batch Hospital ${stamp}`,
        sectorName: `Swap Batch Setor ${stamp}`,
      },
    });
    expect(bidirectional.toShift?.startAt.getTime()).toBe(at(11, 14).getTime());

    const onlySwap = await caller().listAvailable({ type: "SWAP" });
    expect(onlySwap.map(({ id }) => Number(id))).toEqual([validSwapId]);
  });

  it("falha fechado para sessão obsoleta ou instituição inativa e não vaza candidatos", async () => {
    const shift = await createShift(source, 30);
    await createOffer(source, shift, "actor-authority");

    await db
      .update(users)
      .set({ sessionVersion: 2 })
      .where(eq(users.id, actor.userId));
    await expect(caller(1).listAvailable({})).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/sessão|vínculo/i),
    });

    await db
      .update(users)
      .set({ sessionVersion: 1 })
      .where(eq(users.id, actor.userId));
    await db
      .update(institutions)
      .set({ isActive: false })
      .where(eq(institutions.id, institutionId));
    await expect(caller().listAvailable({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await db
      .update(institutions)
      .set({ isActive: true })
      .where(eq(institutions.id, institutionId));
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.professionalId, actor.professionalId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    await expect(caller().listAvailable({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("omite todos os candidatos quando a ACL atual do ator é revogada", async () => {
    const shift = await createShift(source, 40);
    await createOffer(source, shift, "actor-access-revoked");
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.id, actor.accessId!));

    await expect(caller().listAvailable({})).resolves.toEqual([]);
  });

  it("nega PENDENTE na origem e contrapartida em listagem, oferta, aceite e efetivação", async () => {
    const pendingSource = await createShift(source, 50);
    await db
      .update(shiftAssignmentsV2)
      .set({ status: "PENDENTE" })
      .where(eq(shiftAssignmentsV2.id, pendingSource.assignmentId));

    const sourceAuditBefore = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.shiftInstanceId, pendingSource.shiftId));
    await expect(
      callerFor(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: pendingSource.shiftId,
        fromAssignmentId: pendingSource.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db
        .select({ id: swapRequests.id })
        .from(swapRequests)
        .where(eq(swapRequests.fromAssignmentId, pendingSource.assignmentId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(eq(auditTrail.shiftInstanceId, pendingSource.shiftId)),
    ).toEqual(sourceAuditBefore);

    const pendingSourceId = await createOffer(
      source,
      pendingSource,
      "pending-source-assignment",
    );

    const swapSource = await createShift(source, 51, 8, 12);
    const pendingTarget = await createShift(actor, 51, 14, 18);
    await db
      .update(shiftAssignmentsV2)
      .set({ status: "PENDENTE" })
      .where(eq(shiftAssignmentsV2.id, pendingTarget.assignmentId));

    await expect(
      callerFor(source).offer({
        type: "SWAP",
        fromShiftInstanceId: swapSource.shiftId,
        fromAssignmentId: swapSource.assignmentId,
        toShiftInstanceId: pendingTarget.shiftId,
        toProfessionalId: actor.professionalId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const pendingTargetId = await createOffer(
      source,
      swapSource,
      "pending-target-assignment",
      {
        type: "SWAP",
        toProfessionalId: actor.professionalId,
        toUserId: actor.userId,
        toShiftInstanceId: pendingTarget.shiftId,
      },
    );
    const available = await caller().listAvailable({});
    expect(available.map(({ id }) => Number(id))).not.toEqual(
      expect.arrayContaining([pendingSourceId, pendingTargetId]),
    );

    const auditBefore = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(inArray(auditTrail.entityId, [pendingSourceId, pendingTargetId]));
    await expect(
      caller().accept({ swapRequestId: pendingTargetId }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const [stillPending] = await db
      .select({ status: swapRequests.status, version: swapRequests.version })
      .from(swapRequests)
      .where(eq(swapRequests.id, pendingTargetId));
    expect(stillPending).toEqual({ status: "PENDING", version: 1 });

    await db
      .update(swapRequests)
      .set({
        status: "ACCEPTED",
        toAssignmentId: pendingTarget.assignmentId,
        version: 2,
      })
      .where(eq(swapRequests.id, pendingTargetId));
    await expect(
      callerFor(source).approveByOwner({ swapRequestId: pendingTargetId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const [stillAccepted] = await db
      .select({ status: swapRequests.status, version: swapRequests.version })
      .from(swapRequests)
      .where(eq(swapRequests.id, pendingTargetId));
    expect(stillAccepted).toEqual({ status: "ACCEPTED", version: 2 });
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          inArray(auditTrail.entityId, [pendingSourceId, pendingTargetId]),
        ),
    ).toEqual(auditBefore);
  });

  it("exige roster PUBLISHED: DRAFT, ausente e LOCKED não listam nem escrevem", async () => {
    const draftForOffer = await createShift(source, 60);
    const draftMonth = yearMonthBrt(at(60, 8));
    await db
      .update(monthlyRosters)
      .set({ status: "DRAFT" })
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, draftMonth),
        ),
      );

    const noRoster = await createShift(source, 100);
    const noRosterMonth = yearMonthBrt(at(100, 8));
    const noRosterId = await createOffer(source, noRoster, "no-roster");
    await db
      .delete(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, noRosterMonth),
        ),
      );

    const locked = await createShift(source, 140);
    const lockedMonth = yearMonthBrt(at(140, 8));
    const lockedId = await createOffer(source, locked, "locked-roster", {
      toProfessionalId: actor.professionalId,
      toUserId: actor.userId,
    });
    await db
      .update(monthlyRosters)
      .set({ status: "LOCKED" })
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, lockedMonth),
        ),
      );

    const draftListed = await createOffer(
      source,
      draftForOffer,
      "draft-roster",
    );
    const listed = await caller().listAvailable({});
    expect(listed.map(({ id }) => Number(id))).not.toEqual(
      expect.arrayContaining([draftListed, noRosterId, lockedId]),
    );

    await db.delete(swapRequests).where(eq(swapRequests.id, draftListed));
    const auditBefore = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        inArray(auditTrail.shiftInstanceId, [
          draftForOffer.shiftId,
          noRoster.shiftId,
          locked.shiftId,
        ]),
      );
    await expect(
      callerFor(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: draftForOffer.shiftId,
        fromAssignmentId: draftForOffer.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await db
        .select({ id: swapRequests.id })
        .from(swapRequests)
        .where(eq(swapRequests.fromAssignmentId, draftForOffer.assignmentId)),
    ).toHaveLength(0);

    await expect(
      caller().accept({ swapRequestId: noRosterId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const noRosterRows = await db
      .select({ status: swapRequests.status, version: swapRequests.version })
      .from(swapRequests)
      .where(eq(swapRequests.id, noRosterId));
    expect(noRosterRows).toEqual([{ status: "PENDING", version: 1 }]);
    expect(
      await db
        .select({ id: monthlyRosters.id })
        .from(monthlyRosters)
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, noRosterMonth),
          ),
        ),
    ).toHaveLength(0);

    await db
      .update(swapRequests)
      .set({
        status: "ACCEPTED",
        toProfessionalId: actor.professionalId,
        toUserId: actor.userId,
        version: 2,
      })
      .where(eq(swapRequests.id, lockedId));
    await expect(
      callerFor(source).approveByOwner({ swapRequestId: lockedId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const [lockedSwap] = await db
      .select({ status: swapRequests.status, version: swapRequests.version })
      .from(swapRequests)
      .where(eq(swapRequests.id, lockedId));
    expect(lockedSwap).toEqual({ status: "ACCEPTED", version: 2 });
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          inArray(auditTrail.shiftInstanceId, [
            draftForOffer.shiftId,
            noRoster.shiftId,
            locked.shiftId,
          ]),
        ),
    ).toEqual(auditBefore);
  });
});
