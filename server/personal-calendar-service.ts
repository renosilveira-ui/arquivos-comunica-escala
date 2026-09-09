import { createHash } from "node:crypto";

import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
} from "drizzle-orm";

import {
  hospitals,
  institutions,
  personalCalendarAlertRules,
  personalCalendarItems,
  personalCalendarOccurrences,
  personalCalendarOccurrenceExceptions,
  personalCalendarRecurrences,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
  type PersonalCalendarItem,
  type PersonalCalendarRecurrence as StoredPersonalCalendarRecurrence,
} from "../drizzle/schema";
import type { getDb } from "./db";
import {
  generatePersonalCalendarOccurrences,
  personalCalendarAlertOffsetsSchema,
  personalCalendarIntervalsOverlap,
  personalCalendarItemDraftSchema,
  personalCalendarOccurrenceLocalDates,
  personalCalendarOccurrenceLocalEnd,
  personalCalendarRecurrenceSchema,
  validatePersonalCalendarSeries,
  type GeneratedPersonalCalendarOccurrence,
  type PersonalCalendarItemDraft,
  type PersonalCalendarOccurrenceWindow,
  type PersonalCalendarRecurrence,
} from "./personal-calendar-domain";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReadDb = Pick<Db, "select"> | Pick<Tx, "select">;
type WriteTx = Pick<Tx, "select" | "insert" | "update" | "delete">;

const MAX_ACTIVE_SOURCE_ITEMS = 1_000;
const MAX_WINDOW_OCCURRENCES = 10_000;
const MAX_SHIFT_CONFLICT_ROWS = 5_000;
const MAX_CONFLICT_DETAILS = 200;
const MAX_CONFLICT_COMPARISONS = 100_000;
const EMPTY_CONFLICT_FINGERPRINT = createHash("sha256")
  .update("[]")
  .digest("hex");

export const PERSONAL_CALENDAR_TRANSACTION_CONFIG = {
  isolationLevel: "read committed",
} as const;

export type PersonalCalendarStoredBundle = {
  id: number;
  clientMutationId: string;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  item: PersonalCalendarItemDraft;
  recurrence: PersonalCalendarRecurrence | null;
  alertOffsets: number[];
};

export type PersonalCalendarOccurrenceView =
  GeneratedPersonalCalendarOccurrence & {
    itemId: number;
    itemVersion: number;
    title: string;
    kind: PersonalCalendarItemDraft["kind"];
    availability: "BUSY" | "FREE";
    locationLabel: string | null;
    alertOffsets: number[];
    localDateKeys: string[];
    localEndDate: string | null;
    localEndTime: string | null;
    localEndExclusive: boolean;
  };

export type PersonalCalendarShiftConflict = {
  kind: "SHIFT";
  assignmentId: number;
  shiftInstanceId: number;
  institutionId: number;
  institutionName: string;
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  label: string;
  startsAtUtc: Date;
  endsAtUtc: Date;
};

export type PersonalCalendarItemConflict = {
  kind: "PERSONAL_ITEM";
  itemId: number;
  occurrenceKey: string;
  title: string;
  startsAtUtc: Date;
  endsAtUtc: Date;
};

export type PersonalCalendarConflictDetail =
  PersonalCalendarShiftConflict | PersonalCalendarItemConflict;

export type PersonalCalendarConflictResult = {
  hasConflict: boolean;
  fingerprint: string;
  total: number;
  truncated: boolean;
  conflicts: PersonalCalendarConflictDetail[];
};

export type PersonalCalendarWindowResult = {
  occurrences: (PersonalCalendarOccurrenceView & {
    conflict: PersonalCalendarConflictResult;
  })[];
  sourceItemCount: number;
};

type OwnShift = PersonalCalendarShiftConflict;

function storageFailure(): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "A Agenda pessoal contém dados inconsistentes.",
  });
}

function notFound(): never {
  throw new TRPCError({
    code: "NOT_FOUND",
    message: "Compromisso não encontrado.",
  });
}

function versionConflict(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message:
      "Este compromisso foi alterado em outro aparelho. Atualize e tente novamente.",
  });
}

function queryOverload(message: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return Number(
      (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
    );
  }
  return Number(
    (result as { affectedRows?: unknown } | null)?.affectedRows ?? 0,
  );
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) storageFailure();
  return date;
}

function dateString(value: string | Date | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (!Number.isFinite(value.getTime())) storageFailure();
  return value.toISOString().slice(0, 10);
}

function timeString(value: string | null): string | null {
  if (value === null) return null;
  return value.length === 5 ? `${value}:00` : value;
}

function commonDraft(row: PersonalCalendarItem) {
  return {
    title: row.title,
    locationLabel: row.locationLabel,
    locationProvider: row.locationProvider,
    locationExternalId: row.locationExternalId,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    notes: row.notes,
    timeZone: row.timeZone,
  };
}

function draftFromStored(row: PersonalCalendarItem): PersonalCalendarItemDraft {
  let raw: Record<string, unknown>;
  if (row.kind === "BIRTHDAY") {
    raw = {
      ...commonDraft(row),
      kind: "BIRTHDAY",
      allDay: true,
      availability: row.availability,
      birthdayMonth: row.birthdayMonth,
      birthdayDay: row.birthdayDay,
      birthdayYear: row.birthdayYear,
    };
  } else if (row.kind === "REMINDER") {
    raw = {
      ...commonDraft(row),
      kind: "REMINDER",
      allDay: row.allDay,
      availability: row.availability,
      startLocalDate: dateString(row.startLocalDate),
      ...(row.allDay ? {} : { startLocalTime: timeString(row.startLocalTime) }),
    };
  } else {
    raw = {
      ...commonDraft(row),
      kind: "APPOINTMENT",
      allDay: row.allDay,
      availability: row.availability,
      startLocalDate: dateString(row.startLocalDate),
      endLocalDate: dateString(row.endLocalDate),
      ...(row.allDay
        ? {}
        : {
            startLocalTime: timeString(row.startLocalTime),
            endLocalTime: timeString(row.endLocalTime),
          }),
    };
  }

  const parsed = personalCalendarItemDraftSchema.safeParse(raw);
  if (!parsed.success) storageFailure();
  return parsed.data;
}

function recurrenceFromStored(
  row: StoredPersonalCalendarRecurrence,
): PersonalCalendarRecurrence {
  const parsed = personalCalendarRecurrenceSchema.safeParse({
    frequency: row.frequency,
    interval: row.interval,
    weekdaysMask: row.weekdaysMask,
    invalidDatePolicy: row.invalidDatePolicy,
    termination: row.termination,
    untilLocalDate: dateString(row.untilLocalDate),
    occurrenceCount: row.occurrenceCount,
  });
  if (!parsed.success) storageFailure();
  return parsed.data;
}

function itemValues(item: PersonalCalendarItemDraft) {
  const base = {
    kind: item.kind,
    title: item.title,
    locationLabel: item.locationLabel,
    locationProvider: item.locationProvider,
    locationExternalId: item.locationExternalId,
    latitude: item.latitude === null ? null : String(item.latitude),
    longitude: item.longitude === null ? null : String(item.longitude),
    notes: item.notes,
    allDay: item.allDay,
    availability: item.availability,
    timeZone: item.timeZone,
    startLocalDate: null as string | null,
    startLocalTime: null as string | null,
    endLocalDate: null as string | null,
    endLocalTime: null as string | null,
    birthdayMonth: null as number | null,
    birthdayDay: null as number | null,
    birthdayYear: null as number | null,
  };

  if (item.kind === "BIRTHDAY") {
    return {
      ...base,
      birthdayMonth: item.birthdayMonth,
      birthdayDay: item.birthdayDay,
      birthdayYear: item.birthdayYear,
    };
  }
  if (item.kind === "REMINDER") {
    return {
      ...base,
      startLocalDate: item.startLocalDate,
      startLocalTime: item.allDay ? null : item.startLocalTime,
    };
  }
  return {
    ...base,
    startLocalDate: item.startLocalDate,
    startLocalTime: item.allDay ? null : item.startLocalTime,
    endLocalDate: item.endLocalDate,
    endLocalTime: item.allDay ? null : item.endLocalTime,
  };
}

function recurrenceValues(
  itemId: number,
  ownerUserId: number,
  recurrence: PersonalCalendarRecurrence,
) {
  return {
    itemId,
    ownerUserId,
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    weekdaysMask: recurrence.weekdaysMask,
    invalidDatePolicy: recurrence.invalidDatePolicy,
    termination: recurrence.termination,
    untilLocalDate: recurrence.untilLocalDate,
    occurrenceCount: recurrence.occurrenceCount,
  };
}

async function loadChildren(
  db: ReadDb,
  ownerUserId: number,
  itemIds: readonly number[],
): Promise<{
  recurrenceByItemId: Map<number, PersonalCalendarRecurrence>;
  alertsByItemId: Map<number, number[]>;
}> {
  const recurrenceByItemId = new Map<number, PersonalCalendarRecurrence>();
  const alertsByItemId = new Map<number, number[]>();
  if (itemIds.length === 0) return { recurrenceByItemId, alertsByItemId };

  const [unsupportedException] = await db
    .select({ id: personalCalendarOccurrenceExceptions.id })
    .from(personalCalendarOccurrenceExceptions)
    .where(
      and(
        eq(personalCalendarOccurrenceExceptions.ownerUserId, ownerUserId),
        inArray(personalCalendarOccurrenceExceptions.seriesItemId, [
          ...itemIds,
        ]),
      ),
    )
    .limit(1);
  if (unsupportedException) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "A Agenda possui exceções de recorrência que exigem uma versão compatível do aplicativo.",
    });
  }

  const recurrenceRows = await db
    .select()
    .from(personalCalendarRecurrences)
    .where(
      and(
        eq(personalCalendarRecurrences.ownerUserId, ownerUserId),
        inArray(personalCalendarRecurrences.itemId, [...itemIds]),
      ),
    );
  for (const row of recurrenceRows) {
    if (recurrenceByItemId.has(row.itemId)) storageFailure();
    recurrenceByItemId.set(row.itemId, recurrenceFromStored(row));
  }

  const alertRows = await db
    .select({
      itemId: personalCalendarAlertRules.itemId,
      minutesBefore: personalCalendarAlertRules.minutesBefore,
    })
    .from(personalCalendarAlertRules)
    .where(
      and(
        eq(personalCalendarAlertRules.ownerUserId, ownerUserId),
        inArray(personalCalendarAlertRules.itemId, [...itemIds]),
      ),
    )
    .orderBy(
      asc(personalCalendarAlertRules.itemId),
      asc(personalCalendarAlertRules.minutesBefore),
    );
  for (const row of alertRows) {
    const offsets = alertsByItemId.get(row.itemId) ?? [];
    offsets.push(row.minutesBefore);
    alertsByItemId.set(row.itemId, offsets);
  }
  for (const [itemId, offsets] of alertsByItemId) {
    const parsed = personalCalendarAlertOffsetsSchema.safeParse(offsets);
    if (!parsed.success) storageFailure();
    alertsByItemId.set(itemId, parsed.data);
  }
  return { recurrenceByItemId, alertsByItemId };
}

function bundleFromRows(
  row: PersonalCalendarItem,
  recurrenceByItemId: ReadonlyMap<number, PersonalCalendarRecurrence>,
  alertsByItemId: ReadonlyMap<number, number[]>,
): PersonalCalendarStoredBundle {
  let validated: ReturnType<typeof validatePersonalCalendarSeries>;
  try {
    validated = validatePersonalCalendarSeries(
      draftFromStored(row),
      recurrenceByItemId.get(row.id) ?? null,
    );
  } catch {
    storageFailure();
  }
  return {
    id: row.id,
    clientMutationId: row.clientMutationId,
    version: row.version,
    deletedAt: row.deletedAt === null ? null : asDate(row.deletedAt),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
    item: validated.item,
    recurrence: validated.recurrence,
    alertOffsets: alertsByItemId.get(row.id) ?? [],
  };
}

async function loadBundlesFromRows(
  db: ReadDb,
  ownerUserId: number,
  rows: PersonalCalendarItem[],
): Promise<PersonalCalendarStoredBundle[]> {
  const { recurrenceByItemId, alertsByItemId } = await loadChildren(
    db,
    ownerUserId,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    bundleFromRows(row, recurrenceByItemId, alertsByItemId),
  );
}

export async function loadPersonalCalendarItem(
  db: ReadDb,
  ownerUserId: number,
  itemId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<PersonalCalendarStoredBundle | null> {
  const conditions = [
    eq(personalCalendarItems.id, itemId),
    eq(personalCalendarItems.ownerUserId, ownerUserId),
  ];
  if (!options.includeDeleted)
    conditions.push(isNull(personalCalendarItems.deletedAt));
  const [row] = await db
    .select()
    .from(personalCalendarItems)
    .where(and(...conditions))
    .limit(1);
  if (!row) return null;
  const [bundle] = await loadBundlesFromRows(db, ownerUserId, [row]);
  return bundle;
}

async function lockCurrentUser(
  tx: WriteTx,
  ownerUserId: number,
  expectedSessionVersion: number,
): Promise<void> {
  const [user] = await tx
    .select({ id: users.id, sessionVersion: users.sessionVersion })
    .from(users)
    .where(
      and(
        eq(users.id, ownerUserId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!user || user.sessionVersion !== expectedSessionVersion) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "A sessão mudou durante a operação. Entre novamente e repita.",
    });
  }
}

async function replaceChildren(
  tx: WriteTx,
  ownerUserId: number,
  itemId: number,
  recurrence: PersonalCalendarRecurrence | null,
  alertOffsets: readonly number[],
): Promise<void> {
  await tx
    .delete(personalCalendarOccurrences)
    .where(
      and(
        eq(personalCalendarOccurrences.ownerUserId, ownerUserId),
        eq(personalCalendarOccurrences.itemId, itemId),
      ),
    );
  await tx
    .delete(personalCalendarRecurrences)
    .where(
      and(
        eq(personalCalendarRecurrences.ownerUserId, ownerUserId),
        eq(personalCalendarRecurrences.itemId, itemId),
      ),
    );
  await tx
    .delete(personalCalendarAlertRules)
    .where(
      and(
        eq(personalCalendarAlertRules.ownerUserId, ownerUserId),
        eq(personalCalendarAlertRules.itemId, itemId),
      ),
    );

  if (recurrence) {
    await tx
      .insert(personalCalendarRecurrences)
      .values(recurrenceValues(itemId, ownerUserId, recurrence));
  }
  if (alertOffsets.length > 0) {
    await tx.insert(personalCalendarAlertRules).values(
      alertOffsets.map((minutesBefore) => ({
        itemId,
        ownerUserId,
        minutesBefore,
      })),
    );
  }
}

async function assertNoOccurrenceExceptions(
  tx: WriteTx,
  ownerUserId: number,
  itemId: number,
): Promise<void> {
  const [exception] = await tx
    .select({ id: personalCalendarOccurrenceExceptions.id })
    .from(personalCalendarOccurrenceExceptions)
    .where(
      and(
        eq(personalCalendarOccurrenceExceptions.ownerUserId, ownerUserId),
        eq(personalCalendarOccurrenceExceptions.seriesItemId, itemId),
      ),
    )
    .limit(1)
    .for("update");
  if (exception) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Esta série possui exceções individuais e precisa ser atualizada pela versão compatível do aplicativo.",
    });
  }
}

export async function createPersonalCalendarItem(input: {
  db: Db;
  ownerUserId: number;
  expectedSessionVersion: number;
  clientMutationId: string;
  item: PersonalCalendarItemDraft;
  recurrence: PersonalCalendarRecurrence | null;
  alertOffsets: number[];
}): Promise<{ item: PersonalCalendarStoredBundle; replayed: boolean }> {
  const validated = validatePersonalCalendarSeries(
    input.item,
    input.recurrence,
  );
  const alertOffsets = personalCalendarAlertOffsetsSchema.parse(
    input.alertOffsets,
  );
  return input.db.transaction(async (tx) => {
    await lockCurrentUser(tx, input.ownerUserId, input.expectedSessionVersion);
    const [existing] = await tx
      .select()
      .from(personalCalendarItems)
      .where(
        and(
          eq(personalCalendarItems.ownerUserId, input.ownerUserId),
          eq(personalCalendarItems.clientMutationId, input.clientMutationId),
        ),
      )
      .limit(1)
      .for("update");
    if (existing) {
      const [bundle] = await loadBundlesFromRows(tx, input.ownerUserId, [
        existing,
      ]);
      return { item: bundle, replayed: true };
    }

    const [created] = await tx
      .insert(personalCalendarItems)
      .values({
        ownerUserId: input.ownerUserId,
        clientMutationId: input.clientMutationId,
        ...itemValues(validated.item),
        version: 1,
      })
      .$returningId();
    await replaceChildren(
      tx,
      input.ownerUserId,
      created.id,
      validated.recurrence,
      alertOffsets,
    );
    const bundle = await loadPersonalCalendarItem(
      tx,
      input.ownerUserId,
      created.id,
    );
    if (!bundle) storageFailure();
    return { item: bundle, replayed: false };
  }, PERSONAL_CALENDAR_TRANSACTION_CONFIG);
}

export async function updatePersonalCalendarItem(input: {
  db: Db;
  ownerUserId: number;
  expectedSessionVersion: number;
  itemId: number;
  expectedVersion: number;
  item: PersonalCalendarItemDraft;
  recurrence: PersonalCalendarRecurrence | null;
  alertOffsets: number[];
}): Promise<PersonalCalendarStoredBundle> {
  const validated = validatePersonalCalendarSeries(
    input.item,
    input.recurrence,
  );
  const alertOffsets = personalCalendarAlertOffsetsSchema.parse(
    input.alertOffsets,
  );
  return input.db.transaction(async (tx) => {
    await lockCurrentUser(tx, input.ownerUserId, input.expectedSessionVersion);
    const [current] = await tx
      .select()
      .from(personalCalendarItems)
      .where(
        and(
          eq(personalCalendarItems.id, input.itemId),
          eq(personalCalendarItems.ownerUserId, input.ownerUserId),
          isNull(personalCalendarItems.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) notFound();
    if (current.version !== input.expectedVersion) versionConflict();
    await assertNoOccurrenceExceptions(tx, input.ownerUserId, input.itemId);

    const nextVersion = current.version + 1;
    const result = await tx
      .update(personalCalendarItems)
      .set({ ...itemValues(validated.item), version: nextVersion })
      .where(
        and(
          eq(personalCalendarItems.id, current.id),
          eq(personalCalendarItems.ownerUserId, input.ownerUserId),
          eq(personalCalendarItems.version, current.version),
          isNull(personalCalendarItems.deletedAt),
        ),
      );
    if (affectedRows(result) !== 1) versionConflict();
    await replaceChildren(
      tx,
      input.ownerUserId,
      current.id,
      validated.recurrence,
      alertOffsets,
    );
    const bundle = await loadPersonalCalendarItem(
      tx,
      input.ownerUserId,
      current.id,
    );
    if (!bundle) storageFailure();
    return bundle;
  }, PERSONAL_CALENDAR_TRANSACTION_CONFIG);
}

export async function deletePersonalCalendarItem(input: {
  db: Db;
  ownerUserId: number;
  expectedSessionVersion: number;
  itemId: number;
  expectedVersion: number;
}): Promise<{ id: number; version: number; deleted: true; replayed: boolean }> {
  return input.db.transaction(async (tx) => {
    await lockCurrentUser(tx, input.ownerUserId, input.expectedSessionVersion);
    const [current] = await tx
      .select()
      .from(personalCalendarItems)
      .where(
        and(
          eq(personalCalendarItems.id, input.itemId),
          eq(personalCalendarItems.ownerUserId, input.ownerUserId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) notFound();
    if (current.deletedAt !== null) {
      await tx
        .delete(personalCalendarOccurrences)
        .where(
          and(
            eq(personalCalendarOccurrences.ownerUserId, input.ownerUserId),
            eq(personalCalendarOccurrences.itemId, current.id),
          ),
        );
      return {
        id: current.id,
        version: current.version,
        deleted: true,
        replayed: true,
      };
    }
    if (current.version !== input.expectedVersion) versionConflict();
    const nextVersion = current.version + 1;
    const result = await tx
      .update(personalCalendarItems)
      .set({ deletedAt: new Date(), version: nextVersion })
      .where(
        and(
          eq(personalCalendarItems.id, current.id),
          eq(personalCalendarItems.ownerUserId, input.ownerUserId),
          eq(personalCalendarItems.version, current.version),
          isNull(personalCalendarItems.deletedAt),
        ),
      );
    if (affectedRows(result) !== 1) versionConflict();
    await tx
      .delete(personalCalendarOccurrences)
      .where(
        and(
          eq(personalCalendarOccurrences.ownerUserId, input.ownerUserId),
          eq(personalCalendarOccurrences.itemId, current.id),
        ),
      );
    return {
      id: current.id,
      version: nextVersion,
      deleted: true,
      replayed: false,
    };
  }, PERSONAL_CALENDAR_TRANSACTION_CONFIG);
}

async function activeBundlesForWindow(
  db: ReadDb,
  ownerUserId: number,
  window: PersonalCalendarOccurrenceWindow,
): Promise<PersonalCalendarStoredBundle[]> {
  const rows = await db
    .select({ item: personalCalendarItems })
    .from(personalCalendarItems)
    .leftJoin(
      personalCalendarRecurrences,
      and(
        eq(personalCalendarRecurrences.itemId, personalCalendarItems.id),
        eq(
          personalCalendarRecurrences.ownerUserId,
          personalCalendarItems.ownerUserId,
        ),
      ),
    )
    .where(
      and(
        eq(personalCalendarItems.ownerUserId, ownerUserId),
        isNull(personalCalendarItems.deletedAt),
        or(
          and(
            isNotNull(personalCalendarRecurrences.id),
            lte(personalCalendarItems.startLocalDate, window.toDate),
            or(
              ne(personalCalendarRecurrences.termination, "UNTIL"),
              gte(personalCalendarRecurrences.untilLocalDate, window.fromDate),
            ),
          ),
          eq(personalCalendarItems.kind, "BIRTHDAY"),
          and(
            eq(personalCalendarItems.kind, "APPOINTMENT"),
            lte(personalCalendarItems.startLocalDate, window.toDate),
            gte(personalCalendarItems.endLocalDate, window.fromDate),
          ),
          and(
            eq(personalCalendarItems.kind, "REMINDER"),
            gte(personalCalendarItems.startLocalDate, window.fromDate),
            lte(personalCalendarItems.startLocalDate, window.toDate),
          ),
        ),
      ),
    )
    .orderBy(asc(personalCalendarItems.id))
    .limit(MAX_ACTIVE_SOURCE_ITEMS + 1);
  if (rows.length > MAX_ACTIVE_SOURCE_ITEMS) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "A Agenda possui itens demais para uma consulta segura.",
    });
  }
  return loadBundlesFromRows(
    db,
    ownerUserId,
    rows.map((row) => row.item),
  );
}

function occurrenceView(
  bundle: PersonalCalendarStoredBundle,
  occurrence: GeneratedPersonalCalendarOccurrence,
): PersonalCalendarOccurrenceView {
  const localEnd = personalCalendarOccurrenceLocalEnd(bundle.item, occurrence);
  return {
    ...occurrence,
    itemId: bundle.id,
    itemVersion: bundle.version,
    title: bundle.item.title,
    kind: bundle.item.kind,
    availability: bundle.item.availability,
    locationLabel: bundle.item.locationLabel,
    alertOffsets: bundle.alertOffsets,
    localDateKeys: personalCalendarOccurrenceLocalDates(
      bundle.item,
      occurrence,
    ),
    localEndDate: localEnd?.date ?? null,
    localEndTime: localEnd?.time ?? null,
    localEndExclusive: localEnd?.exclusive ?? false,
  };
}

function viewsForWindow(
  bundles: readonly PersonalCalendarStoredBundle[],
  window: PersonalCalendarOccurrenceWindow,
): PersonalCalendarOccurrenceView[] {
  const views: PersonalCalendarOccurrenceView[] = [];
  for (const bundle of bundles) {
    const generated = generatePersonalCalendarOccurrences(
      bundle.item,
      bundle.recurrence,
      window,
    );
    if (views.length + generated.length > MAX_WINDOW_OCCURRENCES) {
      queryOverload(
        "A Agenda gera ocorrências demais para uma consulta segura.",
      );
    }
    for (const occurrence of generated) {
      views.push(occurrenceView(bundle, occurrence));
    }
  }
  return views.sort(
    (left, right) =>
      left.startsAtUtc.getTime() - right.startsAtUtc.getTime() ||
      left.itemId - right.itemId ||
      left.occurrenceKey.localeCompare(right.occurrenceKey),
  );
}

async function loadOwnShifts(
  db: ReadDb,
  ownerUserId: number,
  fromUtc: Date,
  toUtc: Date,
): Promise<OwnShift[]> {
  const rows = await db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      shiftInstanceId: shiftInstances.id,
      institutionId: institutions.id,
      institutionName: institutions.name,
      hospitalId: hospitals.id,
      hospitalName: hospitals.name,
      sectorId: sectors.id,
      sectorName: sectors.name,
      label: shiftInstances.label,
      startsAtUtc: shiftInstances.startAt,
      endsAtUtc: shiftInstances.endAt,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(
      shiftInstances,
      and(
        eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
        eq(shiftInstances.institutionId, shiftAssignmentsV2.institutionId),
        eq(shiftInstances.hospitalId, shiftAssignmentsV2.hospitalId),
        eq(shiftInstances.sectorId, shiftAssignmentsV2.sectorId),
      ),
    )
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, shiftAssignmentsV2.professionalId),
        eq(professionals.userId, ownerUserId),
      ),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, ownerUserId),
        eq(
          professionalInstitutions.institutionId,
          shiftAssignmentsV2.institutionId,
        ),
        eq(professionalInstitutions.active, true),
      ),
    )
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, shiftInstances.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .innerJoin(
      hospitals,
      and(
        eq(hospitals.id, shiftInstances.hospitalId),
        eq(hospitals.institutionId, shiftInstances.institutionId),
      ),
    )
    .innerJoin(
      sectors,
      and(
        eq(sectors.id, shiftInstances.sectorId),
        eq(sectors.hospitalId, shiftInstances.hospitalId),
        eq(sectors.institutionId, shiftInstances.institutionId),
      ),
    )
    .where(
      and(
        eq(shiftAssignmentsV2.isActive, true),
        lt(shiftInstances.startAt, toUtc),
        gt(shiftInstances.endAt, fromUtc),
      ),
    )
    .orderBy(asc(shiftInstances.startAt), asc(shiftAssignmentsV2.id))
    .limit(MAX_SHIFT_CONFLICT_ROWS + 1);

  if (rows.length > MAX_SHIFT_CONFLICT_ROWS) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Há plantões demais no intervalo para uma análise segura.",
    });
  }

  const unique = new Map<number, OwnShift>();
  for (const row of rows) {
    if (unique.has(row.assignmentId)) continue;
    unique.set(row.assignmentId, {
      kind: "SHIFT",
      assignmentId: row.assignmentId,
      shiftInstanceId: row.shiftInstanceId,
      institutionId: row.institutionId,
      institutionName: row.institutionName,
      hospitalId: row.hospitalId,
      hospitalName: row.hospitalName,
      sectorId: row.sectorId,
      sectorName: row.sectorName,
      label: row.label,
      startsAtUtc: asDate(row.startsAtUtc),
      endsAtUtc: asDate(row.endsAtUtc),
    });
  }
  return [...unique.values()];
}

function occurrenceIdentity(
  occurrence: PersonalCalendarOccurrenceView,
): string {
  return `${occurrence.itemId}:${occurrence.occurrenceKey}`;
}

function emptyConflictResult(): PersonalCalendarConflictResult {
  return {
    hasConflict: false,
    fingerprint: EMPTY_CONFLICT_FINGERPRINT,
    total: 0,
    truncated: false,
    conflicts: [],
  };
}

function finalizeConflicts(
  details: readonly PersonalCalendarConflictDetail[],
): PersonalCalendarConflictResult {
  const deduped = new Map<string, PersonalCalendarConflictDetail>();
  for (const detail of details) {
    const key =
      detail.kind === "SHIFT"
        ? `S:${detail.assignmentId}`
        : `P:${detail.itemId}:${detail.occurrenceKey}`;
    if (!deduped.has(key)) deduped.set(key, detail);
  }
  const ordered = [...deduped.values()].sort((left, right) => {
    const time = left.startsAtUtc.getTime() - right.startsAtUtc.getTime();
    if (time !== 0) return time;
    const leftKey =
      left.kind === "SHIFT"
        ? `S:${left.assignmentId}`
        : `P:${left.itemId}:${left.occurrenceKey}`;
    const rightKey =
      right.kind === "SHIFT"
        ? `S:${right.assignmentId}`
        : `P:${right.itemId}:${right.occurrenceKey}`;
    return leftKey.localeCompare(rightKey);
  });
  const fingerprintInput = ordered.map((detail) =>
    detail.kind === "SHIFT"
      ? [
          "SHIFT",
          detail.assignmentId,
          detail.shiftInstanceId,
          detail.startsAtUtc.toISOString(),
          detail.endsAtUtc.toISOString(),
        ]
      : [
          "PERSONAL_ITEM",
          detail.itemId,
          detail.occurrenceKey,
          detail.startsAtUtc.toISOString(),
          detail.endsAtUtc.toISOString(),
        ],
  );
  return {
    hasConflict: ordered.length > 0,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprintInput))
      .digest("hex"),
    total: ordered.length,
    truncated: ordered.length > MAX_CONFLICT_DETAILS,
    conflicts: ordered.slice(0, MAX_CONFLICT_DETAILS),
  };
}

async function conflictsByOccurrence(
  db: ReadDb,
  ownerUserId: number,
  occurrences: readonly PersonalCalendarOccurrenceView[],
): Promise<Map<string, PersonalCalendarConflictResult>> {
  const result = new Map<string, PersonalCalendarConflictDetail[]>();
  const busy = occurrences.filter(
    (occurrence) =>
      occurrence.kind === "APPOINTMENT" && occurrence.availability === "BUSY",
  );
  for (const occurrence of occurrences)
    result.set(occurrenceIdentity(occurrence), []);
  if (busy.length === 0) {
    return new Map(
      occurrences.map((occurrence) => [
        occurrenceIdentity(occurrence),
        emptyConflictResult(),
      ]),
    );
  }

  let fromUtcMs = busy[0].startsAtUtc.getTime();
  let toUtcMs = busy[0].endsAtUtc.getTime();
  for (let index = 1; index < busy.length; index += 1) {
    const occurrence = busy[index];
    fromUtcMs = Math.min(fromUtcMs, occurrence.startsAtUtc.getTime());
    toUtcMs = Math.max(toUtcMs, occurrence.endsAtUtc.getTime());
  }
  const fromUtc = new Date(fromUtcMs);
  const toUtc = new Date(toUtcMs);
  const shifts = await loadOwnShifts(db, ownerUserId, fromUtc, toUtc);
  let comparisonCount = 0;
  const consumeComparison = () => {
    comparisonCount += 1;
    if (comparisonCount > MAX_CONFLICT_COMPARISONS) {
      queryOverload(
        "Há sobreposições demais no intervalo para uma análise segura.",
      );
    }
  };

  for (let leftIndex = 0; leftIndex < busy.length; leftIndex += 1) {
    const left = busy[leftIndex];
    const leftDetails = result.get(occurrenceIdentity(left))!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < busy.length;
      rightIndex += 1
    ) {
      const right = busy[rightIndex];
      if (right.startsAtUtc >= left.endsAtUtc) break;
      consumeComparison();
      if (!personalCalendarIntervalsOverlap(left, right)) continue;
      leftDetails.push({
        kind: "PERSONAL_ITEM",
        itemId: right.itemId,
        occurrenceKey: right.occurrenceKey,
        title: right.title,
        startsAtUtc: right.startsAtUtc,
        endsAtUtc: right.endsAtUtc,
      });
      result.get(occurrenceIdentity(right))!.push({
        kind: "PERSONAL_ITEM",
        itemId: left.itemId,
        occurrenceKey: left.occurrenceKey,
        title: left.title,
        startsAtUtc: left.startsAtUtc,
        endsAtUtc: left.endsAtUtc,
      });
    }
    for (const shift of shifts) {
      if (shift.startsAtUtc >= left.endsAtUtc) break;
      consumeComparison();
      if (shift.endsAtUtc <= left.startsAtUtc) continue;
      if (personalCalendarIntervalsOverlap(left, shift))
        leftDetails.push(shift);
    }
  }

  return new Map(
    [...result].map(([identity, details]) => [
      identity,
      finalizeConflicts(details),
    ]),
  );
}

export async function listPersonalCalendarWindow(input: {
  db: ReadDb;
  ownerUserId: number;
  window: PersonalCalendarOccurrenceWindow;
}): Promise<PersonalCalendarWindowResult> {
  const bundles = await activeBundlesForWindow(
    input.db,
    input.ownerUserId,
    input.window,
  );
  const occurrences = viewsForWindow(bundles, input.window);
  const conflictByIdentity = await conflictsByOccurrence(
    input.db,
    input.ownerUserId,
    occurrences,
  );
  return {
    occurrences: occurrences.map((occurrence) => ({
      ...occurrence,
      conflict:
        conflictByIdentity.get(occurrenceIdentity(occurrence)) ??
        emptyConflictResult(),
    })),
    sourceItemCount: bundles.length,
  };
}

export async function checkPersonalCalendarDraftConflicts(input: {
  db: ReadDb;
  ownerUserId: number;
  item: PersonalCalendarItemDraft;
  recurrence: PersonalCalendarRecurrence | null;
  window: PersonalCalendarOccurrenceWindow;
  excludeItemId?: number;
}): Promise<{
  occurrences: {
    occurrenceKey: string;
    startsAtUtc: Date;
    endsAtUtc: Date;
    conflict: PersonalCalendarConflictResult;
  }[];
}> {
  const validated = validatePersonalCalendarSeries(
    input.item,
    input.recurrence,
  );
  const existing = (
    await activeBundlesForWindow(input.db, input.ownerUserId, input.window)
  ).filter((bundle) => bundle.id !== input.excludeItemId);
  const draftBundle: PersonalCalendarStoredBundle = {
    id: 0,
    clientMutationId: "preview",
    version: 1,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    item: validated.item,
    recurrence: validated.recurrence,
    alertOffsets: [],
  };
  const draftOccurrences = viewsForWindow([draftBundle], input.window);
  const existingOccurrences = viewsForWindow(existing, input.window);
  if (
    draftOccurrences.length + existingOccurrences.length >
    MAX_WINDOW_OCCURRENCES
  ) {
    queryOverload("A Agenda gera ocorrências demais para uma consulta segura.");
  }
  const allOccurrences = [...draftOccurrences, ...existingOccurrences].sort(
    (left, right) =>
      left.startsAtUtc.getTime() - right.startsAtUtc.getTime() ||
      left.itemId - right.itemId ||
      left.occurrenceKey.localeCompare(right.occurrenceKey),
  );
  const conflicts = await conflictsByOccurrence(
    input.db,
    input.ownerUserId,
    allOccurrences,
  );
  return {
    occurrences: draftOccurrences.map((occurrence) => ({
      occurrenceKey: occurrence.occurrenceKey,
      startsAtUtc: occurrence.startsAtUtc,
      endsAtUtc: occurrence.endsAtUtc,
      conflict:
        conflicts.get(occurrenceIdentity(occurrence)) ?? emptyConflictResult(),
    })),
  };
}
