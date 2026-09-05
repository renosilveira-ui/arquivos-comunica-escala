/**
 * Guarda permanente: dois createSwapOffer concorrentes no mesmo
 * fromAssignmentId não podem deixar duas ofertas LIVE (PENDING|ACCEPTED).
 *
 * As duas chamadas usam o pool getDb() — cada db.transaction pega conexão
 * MySQL independente (não compartilham snapshot/TX).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
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
import { createSwapOffer } from "../server/swap-offer-create";
import { yearMonthBrt } from "../server/local-time";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = {
  userId: number;
  professionalId: number;
  sessionVersion: number;
  name: string;
};

const LIVE = ["PENDING", "ACCEPTED"] as const;
const RACE_TIMEOUT_MS = 60_000;

function actorOf(identity: Identity, institutionId: number) {
  return {
    userId: identity.userId,
    professionalId: identity.professionalId,
    expectedSessionVersion: identity.sessionVersion,
    institutionId,
  };
}

async function barrierPair<T>(
  left: () => Promise<T>,
  right: () => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = async (fn: () => Promise<T>) => {
    await gate;
    return fn();
  };
  const first = run(left);
  const second = run(right);
  await Promise.resolve();
  release();
  return Promise.allSettled([first, second]);
}

describe("createSwapOffer: concorrência ≤1 LIVE por fromAssignmentId", () => {
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
  let dayCursor = 0;

  const at = (hour: number, dayOffset: number): Date => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 780 + dayOffset);
    value.setUTCHours(hour, 0, 0, 0);
    return value;
  };

  async function createIdentity(label: string): Promise<Identity> {
    const name = `swap-dbl-${stamp}-${label}`;
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

  async function occupyShift(owner: Identity, label: string) {
    dayCursor += 1;
    const startAt = at(19, dayCursor);
    const endAt = at(7, dayCursor + 1);
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
        scheduleContextId,
        label,
        startAt,
        endAt,
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
        professionalId: owner.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    return { shiftId: shift.id, assignmentId: assignment.id };
  }

  async function liveRows(assignmentId: number) {
    return db
      .select({
        id: swapRequests.id,
        type: swapRequests.type,
        status: swapRequests.status,
      })
      .from(swapRequests)
      .where(
        and(
          eq(swapRequests.fromAssignmentId, assignmentId),
          inArray(swapRequests.status, [...LIVE]),
        ),
      );
  }

  async function offerSignalKeys(swapId: number) {
    return db
      .select({ dedupKey: notifications.dedupKey })
      .from(notifications)
      .where(like(notifications.dedupKey, `swap-offer:${swapId}:%`));
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
      const shiftIds = shifts.map((row) => row.id);
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
  });

  async function assertSerializedRace(
    results: PromiseSettledResult<{ id: number }>[],
    assignmentId: number,
  ) {
    const ok = results.filter(
      (row): row is PromiseFulfilledResult<{ id: number }> =>
        row.status === "fulfilled",
    );
    const failed = results.filter(
      (row): row is PromiseRejectedResult => row.status === "rejected",
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const conflict = failed[0].reason as { code?: string; message?: string };
    expect(conflict.code).toBe("CONFLICT");
    expect(String(conflict.message)).toMatch(/Já existe uma oferta aberta/);
    const live = await liveRows(assignmentId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(ok[0].value.id);
    const winnerSignals = await offerSignalKeys(ok[0].value.id);
    expect(winnerSignals.length).toBeGreaterThan(0);
    const loserId =
      live[0].id === ok[0].value.id
        ? undefined
        : live.find((row) => row.id !== ok[0].value.id)?.id;
    if (typeof loserId === "number") {
      expect(await offerSignalKeys(loserId)).toHaveLength(0);
    }
    const extraLive = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(
        and(
          eq(swapRequests.fromAssignmentId, assignmentId),
          inArray(swapRequests.status, [...LIVE]),
        ),
      );
    expect(extraLive).toHaveLength(1);
  }

  it("controle sequencial: segundo create → CONFLICT e 1 LIVE", async () => {
    const source = await occupyShift(offerer, `seq-${stamp}`);
    const first = await createSwapOffer(
      {
        type: "CESSAO",
        fromShiftInstanceId: source.shiftId,
        fromAssignmentId: source.assignmentId,
      },
      actorOf(offerer, institutionId),
    );
    await expect(
      createSwapOffer(
        {
          type: "CESSAO",
          fromShiftInstanceId: source.shiftId,
          fromAssignmentId: source.assignmentId,
        },
        actorOf(offerer, institutionId),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await liveRows(source.assignmentId)).toEqual([
      expect.objectContaining({ id: first.id, status: "PENDING" }),
    ]);
  });

  it(
    "OPEN × OPEN em conexões independentes: 1 sucesso, 1 CONFLICT, 1 LIVE, 1 conjunto de sinais",
    async () => {
      for (let i = 0; i < 20; i++) {
        const source = await occupyShift(offerer, `c1-${i}-${stamp}`);
        const input = {
          type: "CESSAO" as const,
          fromShiftInstanceId: source.shiftId,
          fromAssignmentId: source.assignmentId,
        };
        const results = await barrierPair(
          () => createSwapOffer(input, actorOf(offerer, institutionId)),
          () => createSwapOffer(input, actorOf(offerer, institutionId)),
        );
        await assertSerializedRace(results, source.assignmentId);
      }
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "OPEN × DIRECTED: 1 LIVE independentemente do modo",
    async () => {
      for (let i = 0; i < 12; i++) {
        const source = await occupyShift(offerer, `c2-${i}-${stamp}`);
        const results = await barrierPair(
          () =>
            createSwapOffer(
              {
                type: "CESSAO",
                fromShiftInstanceId: source.shiftId,
                fromAssignmentId: source.assignmentId,
              },
              actorOf(offerer, institutionId),
            ),
          () =>
            createSwapOffer(
              {
                type: "CESSAO",
                fromShiftInstanceId: source.shiftId,
                fromAssignmentId: source.assignmentId,
                toProfessionalId: peer.professionalId,
              },
              actorOf(offerer, institutionId),
            ),
        );
        await assertSerializedRace(results, source.assignmentId);
      }
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "SWAP × CESSAO/TRANSFER: 1 LIVE no mesmo fromAssignmentId",
    async () => {
      for (let i = 0; i < 12; i++) {
        const from = await occupyShift(offerer, `c6-from-${i}-${stamp}`);
        const to = await occupyShift(peer, `c6-to-${i}-${stamp}`);
        const cessaoType = i % 2 === 0 ? "CESSAO" : "TRANSFER";
        const results = await barrierPair(
          () =>
            createSwapOffer(
              {
                type: "SWAP",
                fromShiftInstanceId: from.shiftId,
                fromAssignmentId: from.assignmentId,
                toShiftInstanceId: to.shiftId,
              },
              actorOf(offerer, institutionId),
            ),
          () =>
            createSwapOffer(
              {
                type: cessaoType,
                fromShiftInstanceId: from.shiftId,
                fromAssignmentId: from.assignmentId,
              },
              actorOf(offerer, institutionId),
            ),
        );
        await assertSerializedRace(results, from.assignmentId);
      }
    },
    RACE_TIMEOUT_MS,
  );
});
