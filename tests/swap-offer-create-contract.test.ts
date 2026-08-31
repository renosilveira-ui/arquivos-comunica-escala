/**
 * Contract: `swaps.offer` (tRPC) e `createSwapOffer` (domain service)
 * devem produzir a mesma oferta canônica — pré-condição do WhatsApp V1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { getDb } from "../server/db";
import { swapRouter } from "../server/swap-router";
import { createSwapOffer } from "../server/swap-offer-create";
import { yearMonthBrt } from "../server/local-time";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = {
  userId: number;
  professionalId: number;
  sessionVersion: number;
  name: string;
};

describe("createSwapOffer ↔ swaps.offer (contract)", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;
  let offerer: Identity;
  let peer: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const stamp = Date.now();

  const at = (dayOffset: number, hour: number): Date => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 620 + dayOffset);
    value.setUTCHours(hour, 0, 0, 0);
    return value;
  };

  async function createIdentity(label: string): Promise<Identity> {
    const name = `offer-contract-${stamp}-${label}`;
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
        medicalSpecialtyId: anesthesiaId,
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
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: professional.id,
      hospitalId,
      sectorId,
      canAccess: true,
    });
    return {
      userId: user.id,
      professionalId: professional.id,
      sessionVersion: 1,
      name,
    };
  }

  function callerFor(identity: Identity) {
    return swapRouter.createCaller({
      user: {
        id: identity.userId,
        name: identity.name,
        email: `${identity.name}@example.test`,
        role: "doctor",
        approvalStatus: "APPROVED" as const,
        sessionVersion: identity.sessionVersion,
      },
      institutionId,
      req: { headers: {}, cookies: {} } as never,
      res: { cookie: () => undefined, clearCookie: () => undefined } as never,
    } as never);
  }

  async function occupyShift(input: {
    owner: Identity;
    startAt: Date;
    endAt: Date;
    label: string;
  }) {
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(input.startAt),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: input.label,
        startAt: input.startAt,
        endAt: input.endAt,
        status: "OCUPADO",
        specialty: "Anestesiologia",
        medicalSpecialtyId: anesthesiaId,
      })
      .$returningId();
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: input.owner.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    return { shiftId: shift.id, assignmentId: assignment.id };
  }

  beforeAll(async () => {
    db = (await getDb())!;
    if (!db) throw new Error("Database not available");
    const [institution] = await db.select().from(institutions).limit(1);
    const [hospital] = await db
      .select()
      .from(hospitals)
      .where(eq(hospitals.institutionId, institution!.id))
      .limit(1);
    const [sector] = await db
      .select()
      .from(sectors)
      .where(eq(sectors.hospitalId, hospital!.id))
      .limit(1);
    institutionId = institution!.id;
    hospitalId = hospital!.id;
    sectorId = sector!.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    offerer = await createIdentity("offerer");
    peer = await createIdentity("peer");
  });

  afterAll(async () => {
    if (!db) return;
    if (professionalIds.length) {
      const shifts = await db
        .select({ id: shiftAssignmentsV2.shiftInstanceId })
        .from(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.professionalId, professionalIds));
      const shiftIds = shifts.map((s) => s.id);
      if (shiftIds.length) {
        await db
          .delete(notifications)
          .where(inArray(notifications.shiftInstanceId, shiftIds));
        await db
          .delete(swapRequests)
          .where(inArray(swapRequests.fromShiftInstanceId, shiftIds));
        await db
          .delete(shiftAssignmentsV2)
          .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
        await db
          .delete(shiftInstances)
          .where(inArray(shiftInstances.id, shiftIds));
      }
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
    if (userIds.length) {
      await db
        .delete(notifications)
        .where(inArray(notifications.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
  });

  it("CESSAO dirigida: service e router gravam a mesma forma", async () => {
    const source = await occupyShift({
      owner: offerer,
      startAt: at(2, 19),
      endAt: at(3, 7),
      label: `contract-cessao-src-${stamp}`,
    });
    const viaService = await createSwapOffer(
      {
        type: "CESSAO",
        fromShiftInstanceId: source.shiftId,
        fromAssignmentId: source.assignmentId,
        toProfessionalId: peer.professionalId,
        reason: `contract-cessao-service-${stamp}`,
        expiresInHours: 48,
      },
      {
        userId: offerer.userId,
        professionalId: offerer.professionalId,
        expectedSessionVersion: offerer.sessionVersion,
        institutionId,
      },
    );
    expect(viaService.status).toBe("PENDING");
    expect(viaService.type).toBe("CESSAO");
    expect(viaService.toProfessionalId).toBe(peer.professionalId);
    expect(viaService.toUserId).toBe(peer.userId);
    expect(viaService.toShiftInstanceId).toBeNull();
    expect(viaService.fromAssignmentId).toBe(source.assignmentId);

    await db
      .update(swapRequests)
      .set({ status: "CANCELLED" })
      .where(eq(swapRequests.id, viaService.id));

    const viaRouter = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: source.shiftId,
      fromAssignmentId: source.assignmentId,
      toProfessionalId: peer.professionalId,
      reason: `contract-cessao-router-${stamp}`,
      expiresInHours: 48,
    });
    expect(viaRouter.status).toBe("PENDING");
    expect(viaRouter.type).toBe("CESSAO");
    expect(viaRouter.toProfessionalId).toBe(peer.professionalId);
    expect(viaRouter.toUserId).toBe(peer.userId);
    expect(viaRouter.toShiftInstanceId).toBeNull();
    expect(viaRouter.fromAssignmentId).toBe(source.assignmentId);
    expect(viaRouter.fromProfessionalId).toBe(viaService.fromProfessionalId);
    expect(viaRouter.institutionId).toBe(viaService.institutionId);
    expect(viaRouter.hospitalId).toBe(viaService.hospitalId);
    expect(viaRouter.sectorId).toBe(viaService.sectorId);
  });

  it("SWAP dirigida: service exige contrapartida do colega", async () => {
    const mine = await occupyShift({
      owner: offerer,
      startAt: at(4, 19),
      endAt: at(5, 7),
      label: `contract-swap-mine-${stamp}`,
    });
    const theirs = await occupyShift({
      owner: peer,
      startAt: at(5, 19),
      endAt: at(6, 7),
      label: `contract-swap-theirs-${stamp}`,
    });
    const created = await createSwapOffer(
      {
        type: "SWAP",
        fromShiftInstanceId: mine.shiftId,
        fromAssignmentId: mine.assignmentId,
        toShiftInstanceId: theirs.shiftId,
        toProfessionalId: peer.professionalId,
        reason: `contract-swap-directed-${stamp}`,
      },
      {
        userId: offerer.userId,
        professionalId: offerer.professionalId,
        expectedSessionVersion: offerer.sessionVersion,
        institutionId,
      },
    );
    expect(created.type).toBe("SWAP");
    expect(created.toShiftInstanceId).toBe(theirs.shiftId);
    expect(created.toProfessionalId).toBe(peer.professionalId);
    expect(created.toUserId).toBe(peer.userId);

    await expect(
      callerFor(offerer).offer({
        type: "SWAP",
        fromShiftInstanceId: mine.shiftId,
        fromAssignmentId: mine.assignmentId,
        toShiftInstanceId: theirs.shiftId,
        toProfessionalId: peer.professionalId,
        reason: `contract-swap-dup-${stamp}`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("target shift que não pertence ao colega: fail-closed", async () => {
    const mine = await occupyShift({
      owner: offerer,
      startAt: at(7, 19),
      endAt: at(8, 7),
      label: `contract-wrong-peer-mine-${stamp}`,
    });
    const notPeers = await occupyShift({
      owner: offerer,
      startAt: at(8, 19),
      endAt: at(9, 7),
      label: `contract-wrong-peer-other-${stamp}`,
    });
    await expect(
      createSwapOffer(
        {
          type: "SWAP",
          fromShiftInstanceId: mine.shiftId,
          fromAssignmentId: mine.assignmentId,
          toShiftInstanceId: notPeers.shiftId,
          toProfessionalId: peer.professionalId,
        },
        {
          userId: offerer.userId,
          professionalId: offerer.professionalId,
          expectedSessionVersion: offerer.sessionVersion,
          institutionId,
        },
      ),
    ).rejects.toBeTruthy();
  });

  it("oferta duplicada no mesmo assignment: CONFLICT", async () => {
    const source = await occupyShift({
      owner: offerer,
      startAt: at(10, 19),
      endAt: at(11, 7),
      label: `contract-dup-src-${stamp}`,
    });
    await createSwapOffer(
      {
        type: "CESSAO",
        fromShiftInstanceId: source.shiftId,
        fromAssignmentId: source.assignmentId,
        toProfessionalId: peer.professionalId,
        reason: `contract-dup-first-${stamp}`,
      },
      {
        userId: offerer.userId,
        professionalId: offerer.professionalId,
        expectedSessionVersion: offerer.sessionVersion,
        institutionId,
      },
    );
    await expect(
      createSwapOffer(
        {
          type: "CESSAO",
          fromShiftInstanceId: source.shiftId,
          fromAssignmentId: source.assignmentId,
          toProfessionalId: peer.professionalId,
          reason: `contract-dup-second-${stamp}`,
        },
        {
          userId: offerer.userId,
          professionalId: offerer.professionalId,
          expectedSessionVersion: offerer.sessionVersion,
          institutionId,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
