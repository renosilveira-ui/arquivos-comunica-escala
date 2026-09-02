import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import {
  addDaysToKey,
  dayKeyBrt,
  dayWindowBrt,
  mondayOfKey,
  monthWindowBrt,
  weekdayOfKey,
  yearMonthBrt,
} from "./local-time";
import { eq, and, gte, lte, lt, inArray, isNull, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { TRPCError } from "@trpc/server";
import {
  shiftInstances,
  shiftTemplates,
  shiftAssignmentsV2,
  professionals,
  hospitals,
  institutions,
  sectors,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  scheduleContexts,
  users,
} from "../drizzle/schema";
import { enqueueDutySyncIntervalRewrite } from "./sso/duty-sync-lifecycle";
import { auditLog } from "./audit-log";
import { recordAudit } from "./audit-trail";
import {
  assertMonthEditableForUpdate,
  assertMonthNotLockedForUpdate,
  assertMonthsEditableForUpdate,
  lockMonthsForUpdate,
  lockMonth,
  publishMonth,
} from "./month-guards";
import {
  ASSIGNMENT_WRITE_TRANSACTION_CONFIG,
  assertAssignmentWritesAllowedForUpdate,
  assertShiftAssignmentCapacityForUpdate,
  checkTimeConflictForProfessional,
  type AssignmentWriteCandidate,
} from "./shift-validations-v2";
import {
  assertCanEditScheduleDate,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  assertManagerScopeAccessForUpdate,
  getTenantActorFromContext,
} from "./_core/policy";
import { assertInstitutionHierarchy } from "./_core/tenant";
import {
  assertActorCanReadShiftScheduleContext,
  assertActiveScheduleContextTopology,
  listReadableScheduleContexts,
  resolveScheduleContextForShiftCreation,
} from "./schedule-contexts";
import { pickShiftTemplatesForSector } from "../lib/shift-template-options";
import { buildShiftTimestamps as buildHospitalShiftTimestamps } from "../lib/hospital-time";
import {
  planOpenMonthShifts,
  type OpenMonthShiftsMode,
} from "../lib/open-month-shifts";
import {
  ensureDefaultShiftTemplates,
  planMissingDefaultShiftTemplates,
} from "./sector-scale";
import { deriveShiftStatus } from "./shift-status";
import {
  enqueueVacancyAvailableSignals,
  recentVacancyBroadcastExists,
} from "./vacancy-broadcast-signal";

/**
 * Combine a "YYYY-MM-DD" date string with a "HH:MM:SS" time string into a Date.
 * For overnight shifts (endTime < startTime), the end date is advanced by 1 day.
 */
// Horários de escala são operacionais locais (Fortaleza/Brasil), não UTC do servidor.
const SCHEDULE_TIME_ZONE_OFFSET = "-03:00";

function buildShiftTimestamps(
  date: string,
  startTime: string,
  endTime: string,
): [Date, Date] {
  const startAt = new Date(`${date}T${startTime}${SCHEDULE_TIME_ZONE_OFFSET}`);
  const endAt = new Date(`${date}T${endTime}${SCHEDULE_TIME_ZONE_OFFSET}`);
  if (endAt <= startAt) {
    endAt.setDate(endAt.getDate() + 1);
  }
  return [startAt, endAt];
}

// Modalidade estruturada (docs/product/escala-ux.md §5).
// Schema reutilizado por shifts.create e shifts.update. Todos os
// campos são opcionais nos endpoints (defaults vivem no DB), mas se
// o caller mandar coverageType para um SOBREAVISO bloqueamos com 400
// porque é semanticamente inconsistente — sobreaviso não tem cobertura.
const modalityFields = z.object({
  modality: z.enum(["PLANTAO", "SOBREAVISO"]).optional(),
  coverageType: z
    .enum(["URGENCIA_EMERGENCIA", "ELETIVAS"])
    .nullable()
    .optional(),
  paymentModel: z
    .enum([
      "FIXO",
      "FIXO_PRODUTIVIDADE_TETO",
      "FIXO_PRODUTIVIDADE_SEM_TETO",
      "PRODUTIVIDADE_PURA",
    ])
    .optional(),
  // BRL como string ("1500.00") para evitar perda de precisão de Number
  // em valores monetários grandes. Drizzle armazena decimal como string
  // no inferType, então segue o mesmo formato no transporte.
  productivityCapBrl: z
    .string()
    .regex(
      /^\d+(\.\d{1,2})?$/,
      'productivityCapBrl deve ser BRL no formato "1500.00"',
    )
    .nullable()
    .optional(),
});

type ModalityInput = z.infer<typeof modalityFields>;

/**
 * Valida combinações inválidas de modalidade + cobertura. SOBREAVISO
 * não admite coverageType (regra de §5: cobertura só faz sentido em
 * PLANTAO). productivityCapBrl só faz sentido com paymentModel que
 * tem teto, mas não bloqueamos — o caller pode preencher por
 * antecipação e mudar o modelo depois.
 */
function assertModalityCoherent(
  input: ModalityInput,
  existingModality?: "PLANTAO" | "SOBREAVISO",
): void {
  const effectiveModality = input.modality ?? existingModality ?? "PLANTAO";
  if (effectiveModality === "SOBREAVISO" && input.coverageType != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "SOBREAVISO não admite coverageType (apenas PLANTAO usa cobertura)",
    });
  }
}

// ---------------------------------------------------------------------
// Replicação de período (semana/mês)
// ---------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const replicateRangeInput = z.object({
  hospitalId: z.number().int(),
  sectorId: z.number().int().optional(),
  from: z.object({
    start: z.string().regex(DATE_ONLY, "YYYY-MM-DD"),
    granularity: z.enum(["week", "month"]),
  }),
  to: z.object({ start: z.string().regex(DATE_ONLY, "YYYY-MM-DD") }),
  includeAssignments: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
  /** Obrigatório (≥ 5 caracteres) para Gestor+ replicar sobre mês PUBLISHED/LOCKED. */
  reason: z.string().max(500).optional(),
});

type ReplicateRangeInput = z.infer<typeof replicateRangeInput>;

const calendarReplicationInput = z.object({
  hospitalId: z.number().int().positive(),
  sectorId: z.number().int().positive().optional(),
  scheduleContextId: z.number().int().positive().optional(),
  sourceMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
  targetMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
  rule: z.enum([
    "FULL",
    "REMOVE_WEEKENDS",
    "REMOVE_NIGHTS",
    "REMOVE_DAYS",
    "CUSTOM",
  ]),
  includeShiftIds: z.array(z.number().int().positive()).max(500).optional(),
  dryRun: z.boolean().optional().default(false),
});

type CalendarReplicationInput = z.infer<typeof calendarReplicationInput>;

const openMonthShiftsInput = z.object({
  hospitalId: z.number().int().positive(),
  sectorId: z.number().int().positive(),
  scheduleContextId: z.number().int().positive().optional(),
  yearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
  mode: z.enum(["all-applicable", "nights-only", "weekends-only", "custom"]),
  templateNames: z
    .array(z.enum(["Manhã", "Tarde", "Noite"]))
    .max(3)
    .optional(),
  dryRun: z.boolean().optional().default(false),
});

/**
 * Recibo opcional durante a transição de clientes. Quando presente, a
 * publicação usa a fence transacional e não aceita um hash ou conjunto de
 * pendências desatualizado. A remoção da compatibilidade legada será uma
 * mudança de versão própria, depois de todos os clientes adotarem a tela.
 */
const readinessAcknowledgementInput = z
  .object({
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    issueCodes: z.array(z.string().regex(/^[A-Z0-9_]{3,96}$/)).max(100),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.issueCodes).size !== input.issueCodes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["issueCodes"],
        message: "issueCodes não pode conter códigos repetidos",
      });
    }
  });

type OpenMonthShiftsInput = z.infer<typeof openMonthShiftsInput>;

/** Instante UTC da meia-noite local (-03:00) de um dia "YYYY-MM-DD". */
function localDayStart(date: string): Date {
  return new Date(`${date}T00:00:00${SCHEDULE_TIME_ZONE_OFFSET}`);
}

// Fortaleza/Brasil não tem horário de verão: somar dias em ms preserva
// a hora local. Se isso mudar, trocar por aritmética com Intl.
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Dia da semana LOCAL (0 = domingo) de um instante: hora local = UTC − 3h. */
function localWeekday(d: Date): number {
  return new Date(d.getTime() - 3 * 60 * 60 * 1000).getUTCDay();
}

function firstMondayOnOrAfter(d: Date): Date {
  const dow = localWeekday(d);
  return addDays(d, (8 - dow) % 7);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface ReplicationWindow {
  fromStart: Date;
  fromEnd: Date;
  targetStart: Date;
  targetEnd: Date;
  offsetDays: number;
}

/**
 * Janela de origem [fromStart, fromEnd), janela de destino e o
 * deslocamento em dias locais.
 *
 * - week: 7 dias a partir de from.start → 7 dias a partir de to.start.
 * - month: mês civil de from.start → mês civil de to.start. O
 *   deslocamento alinha a primeira segunda-feira da origem à primeira
 *   segunda-feira do destino, para que cada turno caia no MESMO DIA DA
 *   SEMANA (escala hospitalar é semanal por natureza). Turnos que, com
 *   esse deslocamento, caem fora do mês de destino não são copiados e
 *   contam em outOfRange.
 */
function resolveReplicationWindow(
  from: ReplicateRangeInput["from"],
  to: ReplicateRangeInput["to"],
): ReplicationWindow {
  if (from.granularity === "week") {
    const fromStart = localDayStart(from.start);
    const targetStart = localDayStart(to.start);
    return {
      fromStart,
      fromEnd: addDays(fromStart, 7),
      targetStart,
      targetEnd: addDays(targetStart, 7),
      offsetDays: Math.round(
        (targetStart.getTime() - fromStart.getTime()) / DAY_MS,
      ),
    };
  }

  const [fy, fm] = from.start.split("-").map(Number);
  const [ty, tm] = to.start.split("-").map(Number);
  const monthStart = (y: number, m: number) =>
    localDayStart(`${y}-${pad2(m)}-01`);
  const nextMonthStart = (y: number, m: number) =>
    m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1);

  const fromStart = monthStart(fy, fm);
  const targetStart = monthStart(ty, tm);
  const offsetDays = Math.round(
    (firstMondayOnOrAfter(targetStart).getTime() -
      firstMondayOnOrAfter(fromStart).getTime()) /
      DAY_MS,
  );
  return {
    fromStart,
    fromEnd: nextMonthStart(fy, fm),
    targetStart,
    targetEnd: nextMonthStart(ty, tm),
    offsetDays,
  };
}

function naturalKey(x: {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  startAt: Date;
  endAt: Date;
  label: string;
}): string {
  return JSON.stringify([
    x.institutionId,
    x.hospitalId,
    x.sectorId,
    x.scheduleContextId,
    x.startAt.getTime(),
    x.endAt.getTime(),
    x.label,
  ]);
}

type ReplicateCtx = {
  user: {
    id: number;
    role: string;
    name?: string | null;
    sessionVersion: number;
  };
  institutionId: number;
};

async function replicateRange(ctx: ReplicateCtx, input: ReplicateRangeInput) {
  const actor = await getTenantActorFromContext(ctx as any);
  assertCanManageInstitutionSchedule(actor);
  await assertManagerScopeAccess(actor, input.hospitalId, input.sectorId);

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const win = resolveReplicationWindow(input.from, input.to);
  if (win.offsetDays === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Origem e destino são o mesmo período.",
    });
  }

  const sourceShifts = await db
    .select()
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, ctx.institutionId),
        eq(shiftInstances.hospitalId, input.hospitalId),
        ...(input.sectorId
          ? [eq(shiftInstances.sectorId, input.sectorId)]
          : []),
        gte(shiftInstances.startAt, win.fromStart),
        lt(shiftInstances.startAt, win.fromEnd),
      ),
    );

  if (sourceShifts.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Nenhum turno encontrado no período de origem.",
    });
  }

  // Sem sectorId no filtro, a origem pode conter mais de um setor. Cada
  // tupla é revalidada antes do planejamento para não replicar registros
  // legados que satisfaçam as FKs isoladas, mas cruzem a hierarquia.
  const sourceHierarchies = new Map(
    sourceShifts.map((source) => [
      `${source.institutionId}|${source.hospitalId}|${source.sectorId}|${source.scheduleContextId ?? "legacy"}`,
      {
        institutionId: source.institutionId,
        hospitalId: source.hospitalId,
        sectorId: source.sectorId,
        scheduleContextId: source.scheduleContextId,
      },
    ]),
  );
  for (const hierarchy of sourceHierarchies.values()) {
    await assertInstitutionHierarchy(hierarchy, { db });
    await assertActiveScheduleContextTopology({ ...hierarchy, db });
  }

  // Candidatos deslocados; os que caem fora do destino (só no modo mês)
  // não entram.
  const candidates = sourceShifts.map((source) => ({
    source,
    startAt: addDays(source.startAt, win.offsetDays),
    endAt: addDays(source.endAt, win.offsetDays),
  }));
  const inRange = candidates.filter(
    (c) => c.startAt >= win.targetStart && c.startAt < win.targetEnd,
  );
  const outOfRange = candidates.length - inRange.length;

  // Permissão por data: falha ANTES de qualquer escrita (sem cópia parcial).
  for (const c of inRange) assertCanEditScheduleDate(actor, c.startAt);
  // Idempotência pela chave natural canônica
  // (instituição, hospital, setor, escala, início, fim, label).
  const existing = await db
    .select({
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      label: shiftInstances.label,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, ctx.institutionId),
        eq(shiftInstances.hospitalId, input.hospitalId),
        gte(shiftInstances.startAt, win.targetStart),
        lt(shiftInstances.startAt, win.targetEnd),
      ),
    );
  const seen = new Set(existing.map(naturalKey));
  const toCreate: typeof candidates = [];
  let skipped = 0;
  for (const c of inRange) {
    const key = naturalKey({
      institutionId: c.source.institutionId,
      hospitalId: c.source.hospitalId,
      sectorId: c.source.sectorId,
      scheduleContextId: c.source.scheduleContextId,
      startAt: c.startAt,
      endAt: c.endAt,
      label: c.source.label,
    });
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    toCreate.push(c);
  }

  // Alocações: só copia quando o profissional está livre no destino.
  type SourceAssignment = typeof shiftAssignmentsV2.$inferSelect;
  const plannedAssignments: {
    sourceShiftId: number;
    assignment: SourceAssignment;
    candidate: AssignmentWriteCandidate;
  }[] = [];
  let conflicts = 0;
  if (input.includeAssignments && toCreate.length > 0) {
    const sourceAssignments = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          inArray(
            shiftAssignmentsV2.shiftInstanceId,
            toCreate.map((c) => c.source.id),
          ),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    const linkedProfessionals =
      sourceAssignments.length > 0
        ? await db
            .select({ professionalId: professionalInstitutions.professionalId })
            .from(professionalInstitutions)
            .innerJoin(
              professionals,
              and(
                eq(professionals.id, professionalInstitutions.professionalId),
                eq(professionals.userId, professionalInstitutions.userId),
              ),
            )
            .where(
              and(
                eq(professionalInstitutions.institutionId, ctx.institutionId),
                eq(professionalInstitutions.active, true),
                inArray(
                  professionalInstitutions.professionalId,
                  Array.from(
                    new Set(
                      sourceAssignments.map(
                        (assignment) => assignment.professionalId,
                      ),
                    ),
                  ),
                ),
              ),
            )
        : [];
    const linkedProfessionalIds = new Set(
      linkedProfessionals.map((row) => row.professionalId),
    );
    for (const a of sourceAssignments) {
      const c = toCreate.find((x) => x.source.id === a.shiftInstanceId);
      if (!c) continue;
      if (
        a.institutionId !== c.source.institutionId ||
        a.hospitalId !== c.source.hospitalId ||
        a.sectorId !== c.source.sectorId ||
        !linkedProfessionalIds.has(a.professionalId)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Alocação de origem fora da hierarquia institucional",
        });
      }
      const [activeAccess] = await db
        .select({ id: professionalAccess.id })
        .from(professionalAccess)
        .where(
          and(
            eq(professionalAccess.professionalId, a.professionalId),
            eq(professionalAccess.institutionId, c.source.institutionId),
            eq(professionalAccess.hospitalId, c.source.hospitalId),
            eq(professionalAccess.canAccess, true),
            or(
              isNull(professionalAccess.sectorId),
              eq(professionalAccess.sectorId, c.source.sectorId),
            ),
          ),
        )
        .limit(1);
      if (!activeAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Profissional da origem sem acesso ativo ao hospital/setor de destino",
        });
      }
      const conflict = await checkTimeConflictForProfessional(
        a.professionalId,
        c.startAt,
        c.endAt,
      );
      if (conflict.hasConflict) {
        conflicts++;
        continue;
      }
      const candidate: AssignmentWriteCandidate = {
        professionalId: a.professionalId,
        institutionId: c.source.institutionId,
        hospitalId: c.source.hospitalId,
        sectorId: c.source.sectorId,
        scheduleContextId: c.source.scheduleContextId,
        startAt: c.startAt,
        endAt: c.endAt,
      };
      const conflictsWithBatch = plannedAssignments.some(
        (planned) =>
          planned.candidate.professionalId === candidate.professionalId &&
          planned.candidate.startAt < candidate.endAt &&
          planned.candidate.endAt > candidate.startAt,
      );
      if (conflictsWithBatch) {
        conflicts++;
        continue;
      }
      plannedAssignments.push({
        sourceShiftId: c.source.id,
        assignment: a,
        candidate,
      });
    }
  }

  const summary = {
    created: toCreate.length,
    skipped,
    conflicts,
    outOfRange,
    assignmentsCopied: plannedAssignments.length,
    dryRun: input.dryRun,
    targetRange: {
      start: win.targetStart.toISOString(),
      end: win.targetEnd.toISOString(),
    },
  };
  if (input.dryRun || toCreate.length === 0) return summary;

  await db.transaction(async (tx) => {
    await lockMonthsForUpdate(tx, [
      ...toCreate.map((candidate) => ({
        institutionId: candidate.source.institutionId,
        hospitalId: candidate.source.hospitalId,
        date: candidate.source.startAt,
      })),
      ...toCreate.map((candidate) => ({
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        date: candidate.startAt,
      })),
    ]);
    await assertMonthsEditableForUpdate(
      tx,
      { user: { id: ctx.user.id } },
      toCreate.map((candidate) => ({
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        date: candidate.startAt,
        reason: input.reason,
      })),
    );

    // O planejamento acima é deliberadamente read-only (também alimenta o
    // dry-run). Depois de conquistar as linhas mensais, refazemos as provas
    // load-bearing antes de escrever: idempotência, fonte ainda atual e
    // elegibilidade/conflitos dos profissionais.
    const currentTargetShifts = await tx
      .select({
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        sectorId: shiftInstances.sectorId,
        scheduleContextId: shiftInstances.scheduleContextId,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
        label: shiftInstances.label,
      })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, ctx.institutionId),
          eq(shiftInstances.hospitalId, input.hospitalId),
          gte(shiftInstances.startAt, win.targetStart),
          lt(shiftInstances.startAt, win.targetEnd),
        ),
      )
      .for("update");
    const currentTargetKeys = new Set(currentTargetShifts.map(naturalKey));
    if (
      toCreate.some((candidate) =>
        currentTargetKeys.has(
          naturalKey({
            institutionId: candidate.source.institutionId,
            hospitalId: candidate.source.hospitalId,
            sectorId: candidate.source.sectorId,
            scheduleContextId: candidate.source.scheduleContextId,
            startAt: candidate.startAt,
            endAt: candidate.endAt,
            label: candidate.source.label,
          }),
        ),
      )
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "O período de destino mudou durante a replicação; atualize e tente novamente.",
      });
    }

    const orderedSources = [
      ...new Map(
        toCreate.map(
          (candidate) => [candidate.source.id, candidate.source] as const,
        ),
      ).values(),
    ].sort((left, right) => left.id - right.id);
    for (const source of orderedSources) {
      const [lockedSource] = await tx
        .select({ shift: shiftInstances })
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, source.id),
            eq(shiftInstances.institutionId, source.institutionId),
            eq(shiftInstances.hospitalId, source.hospitalId),
            eq(shiftInstances.sectorId, source.sectorId),
          ),
        )
        .limit(1)
        .for("update");
      const current = lockedSource?.shift;
      if (
        !current ||
        current.label !== source.label ||
        current.scheduleContextId !== source.scheduleContextId ||
        current.specialty !== source.specialty ||
        current.startAt.getTime() !== source.startAt.getTime() ||
        current.endAt.getTime() !== source.endAt.getTime() ||
        current.status !== source.status ||
        current.modality !== source.modality ||
        current.coverageType !== source.coverageType ||
        current.paymentModel !== source.paymentModel ||
        current.productivityCapBrl !== source.productivityCapBrl
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Um turno de origem mudou durante a replicação; atualize e tente novamente.",
        });
      }
      await assertInstitutionHierarchy(
        {
          institutionId: current.institutionId,
          hospitalId: current.hospitalId,
          sectorId: current.sectorId,
        },
        { db: tx, lockForShare: true },
      );
      await assertActiveScheduleContextTopology({
        institutionId: current.institutionId,
        hospitalId: current.hospitalId,
        sectorId: current.sectorId,
        scheduleContextId: current.scheduleContextId,
        db: tx,
      });
    }

    for (const planned of [...plannedAssignments].sort(
      (left, right) => left.assignment.id - right.assignment.id,
    )) {
      const source = planned.assignment;
      const [lockedAssignment] = await tx
        .select({ id: shiftAssignmentsV2.id })
        .from(shiftAssignmentsV2)
        .where(
          and(
            eq(shiftAssignmentsV2.id, source.id),
            eq(shiftAssignmentsV2.shiftInstanceId, source.shiftInstanceId),
            eq(shiftAssignmentsV2.institutionId, source.institutionId),
            eq(shiftAssignmentsV2.hospitalId, source.hospitalId),
            eq(shiftAssignmentsV2.sectorId, source.sectorId),
            eq(shiftAssignmentsV2.professionalId, source.professionalId),
            eq(shiftAssignmentsV2.assignmentType, source.assignmentType),
            eq(shiftAssignmentsV2.status, source.status),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        )
        .limit(1)
        .for("update");
      if (!lockedAssignment) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Uma alocação de origem mudou durante a replicação; atualize e tente novamente.",
        });
      }
    }

    await assertAssignmentWritesAllowedForUpdate(
      tx,
      plannedAssignments.map((planned) => planned.candidate),
      {
        additionalProfessionalIds: actor.professionalId
          ? [actor.professionalId]
          : [],
      },
    );
    await assertManagerScopeAccessForUpdate(
      tx,
      actor,
      ctx.user.sessionVersion,
      input.hospitalId,
      input.sectorId,
      toCreate.map((candidate) => candidate.startAt),
    );

    let firstCreatedId = 0;
    for (const c of toCreate) {
      const mine = plannedAssignments.filter(
        (p) => p.sourceShiftId === c.source.id,
      );
      const status =
        mine.length === 0
          ? "VAGO"
          : mine.some((p) => p.assignment.status === "OCUPADO")
            ? "OCUPADO"
            : "PENDENTE";

      const [row] = await tx
        .insert(shiftInstances)
        .values({
          institutionId: c.source.institutionId,
          hospitalId: c.source.hospitalId,
          sectorId: c.source.sectorId,
          scheduleContextId: c.source.scheduleContextId,
          label: c.source.label,
          specialty: c.source.specialty,
          startAt: c.startAt,
          endAt: c.endAt,
          status,
          modality: c.source.modality,
          coverageType: c.source.coverageType,
          paymentModel: c.source.paymentModel,
          productivityCapBrl: c.source.productivityCapBrl,
          createdBy: ctx.user.id,
        })
        .$returningId();
      if (!firstCreatedId) firstCreatedId = row.id;

      if (mine.length > 0) {
        await assertShiftAssignmentCapacityForUpdate(tx, {
          shiftInstanceId: row.id,
          institutionId: c.source.institutionId,
          hospitalId: c.source.hospitalId,
          sectorId: c.source.sectorId,
          activeDelta: mine.length,
          expectedCurrentActiveCount: 0,
        });
        await tx.insert(shiftAssignmentsV2).values(
          mine.map(({ assignment }) => ({
            shiftInstanceId: row.id,
            institutionId: assignment.institutionId,
            hospitalId: assignment.hospitalId,
            sectorId: assignment.sectorId,
            professionalId: assignment.professionalId,
            assignmentType: assignment.assignmentType,
            status: assignment.status,
            isActive: true,
            createdBy: ctx.user.id,
          })),
        );
      }
    }

    await recordAudit(
      {
        actorUserId: ctx.user.id,
        actorRole: actor.roleInInstitution,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: firstCreatedId,
        description: `Replicou ${summary.created} turnos de ${input.from.start} (${input.from.granularity === "week" ? "semana" : "mês"}) para ${input.to.start}; ${skipped} já existiam; ${plannedAssignments.length} alocações copiadas; ${conflicts} com conflito`,
        metadata: {
          replication: true,
          ...summary,
          from: input.from,
          to: input.to,
        },
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
      },
      { db: tx as any, strict: true },
    );
  }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

  return summary;
}

function localHourBrt(date: Date): number {
  return new Date(date.getTime() - 3 * 60 * 60 * 1000).getUTCHours();
}

function isNightShiftBrt(startAt: Date): boolean {
  const hour = localHourBrt(startAt);
  return hour >= 18 || hour < 6;
}

function selectCalendarReplicationCandidates(
  shifts: readonly (typeof shiftInstances.$inferSelect)[],
  input: CalendarReplicationInput,
) {
  if (input.rule === "CUSTOM") {
    const selected = new Set(input.includeShiftIds ?? []);
    if (selected.size === 0) {
      if (input.dryRun) return shifts;
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Selecione ao menos um turno para a cópia personalizada.",
      });
    }
    const validIds = new Set(shifts.map((shift) => shift.id));
    if ([...selected].some((id) => !validIds.has(id))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A seleção personalizada contém turno fora do mês de origem.",
      });
    }
    return shifts.filter((shift) => selected.has(shift.id));
  }
  return shifts.filter((shift) => {
    if (input.rule === "REMOVE_WEEKENDS") {
      const weekday = weekdayOfKey(dayKeyBrt(shift.startAt));
      return weekday !== 0 && weekday !== 6;
    }
    if (input.rule === "REMOVE_NIGHTS") return !isNightShiftBrt(shift.startAt);
    if (input.rule === "REMOVE_DAYS") return isNightShiftBrt(shift.startAt);
    return true;
  });
}

function dayKeysInMonth(yearMonth: string): string[] {
  const [year, month] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: string[] = [];
  for (let day = 1; day <= lastDay; day++) {
    days.push(
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    );
  }
  return days;
}

function clockFromTemplate(value: unknown): string {
  if (typeof value === "string") {
    const clock = value.length === 5 ? `${value}:00` : value;
    return clock.slice(0, 8);
  }
  if (value instanceof Date) {
    return [
      String(value.getUTCHours()).padStart(2, "0"),
      String(value.getUTCMinutes()).padStart(2, "0"),
      String(value.getUTCSeconds()).padStart(2, "0"),
    ].join(":");
  }
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "Modelo de horário com hora inválida.",
  });
}

type MonthCalendarWriteCandidate = {
  sourceShiftId: number;
  label: string;
  startAt: Date;
  endAt: Date;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  specialty: string | null;
  modality?: (typeof shiftInstances.$inferSelect)["modality"];
  coverageType?: (typeof shiftInstances.$inferSelect)["coverageType"];
  paymentModel?: (typeof shiftInstances.$inferSelect)["paymentModel"];
  productivityCapBrl?: (typeof shiftInstances.$inferSelect)["productivityCapBrl"];
};

function applyCalendarMonthRule<T extends { startAt: Date }>(
  candidates: readonly T[],
  rule: CalendarReplicationInput["rule"],
): T[] {
  return candidates.filter((candidate) => {
    if (rule === "REMOVE_WEEKENDS") {
      const weekday = weekdayOfKey(dayKeyBrt(candidate.startAt));
      return weekday !== 0 && weekday !== 6;
    }
    if (rule === "REMOVE_NIGHTS") return !isNightShiftBrt(candidate.startAt);
    if (rule === "REMOVE_DAYS") return isNightShiftBrt(candidate.startAt);
    return true;
  });
}

async function buildTemplateMonthCandidates(
  ctx: ReplicateCtx,
  input: CalendarReplicationInput,
): Promise<MonthCalendarWriteCandidate[]> {
  if (!input.sectorId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Selecione um setor para criar o primeiro calendário a partir dos modelos de horário.",
    });
  }
  if (input.rule === "CUSTOM") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Sem escala anterior, escolha um modelo de mês (mês inteiro, sem fins de semana…).",
    });
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const templates = await db
    .select()
    .from(shiftTemplates)
    .where(
      and(
        eq(shiftTemplates.institutionId, ctx.institutionId),
        eq(shiftTemplates.hospitalId, input.hospitalId),
        eq(shiftTemplates.isActive, true),
      ),
    );
  const picked = pickShiftTemplatesForSector(
    templates,
    input.hospitalId,
    input.sectorId,
  );
  if (!picked.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        "Não há modelos de horário neste setor. Cadastre os horários antes de abrir o primeiro mês.",
    });
  }

  const context = await resolveScheduleContextForShiftCreation({
    institutionId: ctx.institutionId,
    scheduleContextId: input.scheduleContextId,
    hospitalId: input.hospitalId,
    sectorId: input.sectorId,
    templateSectorId: picked[0].sectorId ?? null,
    db,
  });
  for (const template of picked) {
    if (template.sectorId != null && template.sectorId !== context.sectorId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "O template informado pertence a outro setor.",
      });
    }
  }

  const raw: MonthCalendarWriteCandidate[] = [];
  for (const dayKey of dayKeysInMonth(input.targetMonth)) {
    for (const template of picked) {
      const [startAt, endAt] = buildShiftTimestamps(
        dayKey,
        clockFromTemplate(template.startTime),
        clockFromTemplate(template.endTime),
      );
      raw.push({
        sourceShiftId: template.id,
        label: template.name,
        startAt,
        endAt,
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        sectorId: context.sectorId,
        scheduleContextId: context.id,
        specialty: context.qualificationName,
      });
    }
  }
  return applyCalendarMonthRule(raw, input.rule);
}

/**
 * Cria um calendário mensal explicitamente escolhido, sempre sem alocações.
 * Sem escala no mês de origem (primeiro mês da instituição), usa os modelos
 * de horário do setor. Esta rota não reutiliza o comportamento legado de
 * replicateRange, que pode copiar alocações e tolera destino parcialmente
 * preenchido.
 */
async function replicateMonthCalendar(
  ctx: ReplicateCtx,
  input: CalendarReplicationInput,
) {
  const actor = await getTenantActorFromContext(ctx as any);
  assertCanManageInstitutionSchedule(actor);
  await assertManagerScopeAccess(actor, input.hospitalId, input.sectorId);

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const sourceWindow = monthWindowBrt(input.sourceMonth);
  const targetWindow = monthWindowBrt(input.targetMonth);
  const sourceShifts = await db
    .select()
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, ctx.institutionId),
        eq(shiftInstances.hospitalId, input.hospitalId),
        ...(input.sectorId
          ? [eq(shiftInstances.sectorId, input.sectorId)]
          : []),
        gte(shiftInstances.startAt, sourceWindow.start),
        lt(shiftInstances.startAt, sourceWindow.end),
      ),
    );
  const origin = sourceShifts.length > 0 ? "previous-month" : "templates";
  if (origin === "previous-month" && input.sourceMonth === input.targetMonth) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Origem e destino não podem ser o mesmo mês.",
    });
  }

  let candidates: MonthCalendarWriteCandidate[];
  if (origin === "templates") {
    candidates = await buildTemplateMonthCandidates(ctx, input);
  } else {
    for (const shift of sourceShifts) {
      await assertInstitutionHierarchy(
        {
          institutionId: shift.institutionId,
          hospitalId: shift.hospitalId,
          sectorId: shift.sectorId,
        },
        { db },
      );
      await assertActiveScheduleContextTopology({
        institutionId: shift.institutionId,
        hospitalId: shift.hospitalId,
        sectorId: shift.sectorId,
        scheduleContextId: shift.scheduleContextId,
        db,
      });
    }
    const selected = selectCalendarReplicationCandidates(sourceShifts, input);
    const offsetDays = Math.round(
      (firstMondayOnOrAfter(targetWindow.start).getTime() -
        firstMondayOnOrAfter(sourceWindow.start).getTime()) /
        DAY_MS,
    );
    candidates = selected
      .map((source) => ({
        sourceShiftId: source.id,
        label: source.label,
        startAt: addDays(source.startAt, offsetDays),
        endAt: addDays(source.endAt, offsetDays),
        institutionId: source.institutionId,
        hospitalId: source.hospitalId,
        sectorId: source.sectorId,
        scheduleContextId: source.scheduleContextId,
        specialty: source.specialty,
        modality: source.modality,
        coverageType: source.coverageType,
        paymentModel: source.paymentModel,
        productivityCapBrl: source.productivityCapBrl,
      }))
      .filter(
        (candidate) =>
          candidate.startAt >= targetWindow.start &&
          candidate.startAt < targetWindow.end,
      );
  }
  for (const candidate of candidates)
    assertCanEditScheduleDate(actor, candidate.startAt);

  const targetConflictMessage = input.sectorId
    ? "O mês de destino deste setor já contém turnos. Nenhuma cópia foi feita."
    : "O mês de destino deste hospital já contém turnos. Nenhuma cópia foi feita.";
  const targetRaceMessage = input.sectorId
    ? "O mês de destino deste setor foi preenchido durante a cópia. Atualize e tente novamente."
    : "O mês de destino deste hospital foi preenchido durante a cópia. Atualize e tente novamente.";
  const existingTarget = async (tx: typeof db) =>
    tx
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, ctx.institutionId),
          eq(shiftInstances.hospitalId, input.hospitalId),
          ...(input.sectorId
            ? [eq(shiftInstances.sectorId, input.sectorId)]
            : []),
          gte(shiftInstances.startAt, targetWindow.start),
          lt(shiftInstances.startAt, targetWindow.end),
        ),
      );
  const existing = await existingTarget(db);
  if (existing.length) {
    throw new TRPCError({ code: "CONFLICT", message: targetConflictMessage });
  }
  const summary = {
    created: candidates.length,
    sourceCount: sourceShifts.length,
    origin,
    rule: input.rule,
    targetMonth: input.targetMonth,
    candidates: candidates.map((candidate) => ({
      sourceShiftId: candidate.sourceShiftId,
      label: candidate.label,
      startAt: candidate.startAt.toISOString(),
      endAt: candidate.endAt.toISOString(),
    })),
    dryRun: input.dryRun,
  };
  if (input.dryRun) return summary;

  await db.transaction(async (tx) => {
    await lockMonthsForUpdate(tx, [
      {
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        date: targetWindow.start,
      },
    ]);
    await assertMonthsEditableForUpdate(
      tx,
      { user: { id: ctx.user.id } },
      [
        {
          institutionId: ctx.institutionId,
          hospitalId: input.hospitalId,
          date: targetWindow.start,
        },
      ],
      { kind: "vacantCreate" },
    );
    await assertManagerScopeAccessForUpdate(
      tx,
      actor,
      ctx.user.sessionVersion,
      input.hospitalId,
      input.sectorId,
      candidates.map((candidate) => candidate.startAt),
    );
    if ((await existingTarget(tx as unknown as typeof db)).length) {
      throw new TRPCError({ code: "CONFLICT", message: targetRaceMessage });
    }
    for (const candidate of candidates) {
      await tx.insert(shiftInstances).values({
        institutionId: candidate.institutionId,
        hospitalId: candidate.hospitalId,
        sectorId: candidate.sectorId,
        scheduleContextId: candidate.scheduleContextId,
        label: candidate.label,
        specialty: candidate.specialty,
        startAt: candidate.startAt,
        endAt: candidate.endAt,
        status: "VAGO",
        ...(candidate.modality !== undefined
          ? { modality: candidate.modality }
          : {}),
        ...(candidate.coverageType !== undefined
          ? { coverageType: candidate.coverageType }
          : {}),
        ...(candidate.paymentModel !== undefined
          ? { paymentModel: candidate.paymentModel }
          : {}),
        ...(candidate.productivityCapBrl !== undefined
          ? { productivityCapBrl: candidate.productivityCapBrl }
          : {}),
        createdBy: ctx.user.id,
      });
    }
    await recordAudit(
      {
        actorUserId: ctx.user.id,
        actorRole: actor.roleInInstitution,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: 0,
        description:
          origin === "templates"
            ? `Criou ${candidates.length} turnos vagos em ${input.targetMonth} a partir dos modelos de horário.`
            : `Criou ${candidates.length} turnos vagos em ${input.targetMonth} a partir de ${input.sourceMonth}.`,
        metadata: {
          calendarReplication: true,
          ...summary,
          sourceMonth: input.sourceMonth,
          sectorId: input.sectorId,
        },
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
      },
      { db: tx as any, strict: true },
    );
  }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);
  return summary;
}

/**
 * Abre os plantões vagos do mês a partir dos templates do setor.
 * Sem modelos, cria o blueprint padrão (manhã/tarde/noite) e segue.
 * Idempotente pela chave label+início+fim. Tenant = ctx.institutionId.
 */
async function openMonthShifts(ctx: ReplicateCtx, input: OpenMonthShiftsInput) {
  const actor = await getTenantActorFromContext(ctx as any);
  assertCanManageInstitutionSchedule(actor);
  await assertManagerScopeAccess(actor, input.hospitalId, input.sectorId);

  let planned: ReturnType<typeof planOpenMonthShifts>;
  try {
    planned = planOpenMonthShifts({
      yearMonth: input.yearMonth,
      mode: input.mode as OpenMonthShiftsMode,
      templateNames: input.templateNames,
    });
  } catch (err) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: (err as Error).message,
    });
  }
  if (!planned.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Nenhum plantão se encaixa neste recorte do mês.",
    });
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await assertInstitutionHierarchy(
    {
      institutionId: ctx.institutionId,
      hospitalId: input.hospitalId,
      sectorId: input.sectorId,
    },
    { db },
  );

  const targetWindow = monthWindowBrt(input.yearMonth);
  const loadExisting = async (conn: typeof db) =>
    conn
      .select({
        id: shiftInstances.id,
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        sectorId: shiftInstances.sectorId,
        scheduleContextId: shiftInstances.scheduleContextId,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
        label: shiftInstances.label,
      })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, ctx.institutionId),
          eq(shiftInstances.hospitalId, input.hospitalId),
          eq(shiftInstances.sectorId, input.sectorId),
          gte(shiftInstances.startAt, targetWindow.start),
          lt(shiftInstances.startAt, targetWindow.end),
        ),
      );

  return db.transaction(async (tx) => {
    const templates = await tx
      .select()
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, ctx.institutionId),
          eq(shiftTemplates.hospitalId, input.hospitalId),
          eq(shiftTemplates.isActive, true),
        ),
      );
    const indexByName = (
      rows: {
        id?: number;
        hospitalId: number;
        sectorId: number | null;
        name: string;
        startTime: string;
        endTime: string;
        priority?: number | null;
      }[],
    ) => {
      const picked = pickShiftTemplatesForSector(
        rows.map((row, index) => ({
          id: row.id ?? -(index + 1),
          hospitalId: row.hospitalId,
          sectorId: row.sectorId,
          name: row.name,
          startTime: row.startTime,
          endTime: row.endTime,
          priority: row.priority,
        })),
        input.hospitalId,
        input.sectorId,
      );
      const templateByName = new Map<string, (typeof picked)[number]>();
      for (const template of picked) {
        if (!templateByName.has(template.name)) {
          templateByName.set(template.name, template);
        }
      }
      return { picked, templateByName };
    };

    let { picked, templateByName } = indexByName(templates);
    const plannedNames = [
      ...new Set(planned.map((slot) => slot.template.name)),
    ];
    if (plannedNames.some((name) => !templateByName.has(name))) {
      if (input.dryRun) {
        const virtual = planMissingDefaultShiftTemplates(templates, {
          institutionId: ctx.institutionId,
          hospitalId: input.hospitalId,
          sectorId: input.sectorId,
        });
        ({ picked, templateByName } = indexByName([...templates, ...virtual]));
      } else {
        await ensureDefaultShiftTemplates(tx, {
          institutionId: ctx.institutionId,
          hospitalId: input.hospitalId,
          sectorId: input.sectorId,
        });
        const reloaded = await tx
          .select()
          .from(shiftTemplates)
          .where(
            and(
              eq(shiftTemplates.institutionId, ctx.institutionId),
              eq(shiftTemplates.hospitalId, input.hospitalId),
              eq(shiftTemplates.isActive, true),
            ),
          );
        ({ picked, templateByName } = indexByName(reloaded));
      }
    }
    const missing = plannedNames.filter((name) => !templateByName.has(name));
    if (missing.length) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message:
          "Não há modelo de horário neste setor. Crie a escala do setor para gerar os turnos padrão.",
      });
    }

    const context = await resolveScheduleContextForShiftCreation({
      institutionId: ctx.institutionId,
      scheduleContextId: input.scheduleContextId,
      hospitalId: input.hospitalId,
      sectorId: input.sectorId,
      templateSectorId: picked[0]?.sectorId ?? null,
      db: tx,
    });
    for (const template of templateByName.values()) {
      if (template.sectorId != null && template.sectorId !== context.sectorId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "O template informado pertence a outro setor.",
        });
      }
    }

    const candidates = planned.map((slot) => {
      const template = templateByName.get(slot.template.name)!;
      const [startAt, endAt] = buildHospitalShiftTimestamps(
        slot.dayKey,
        clockFromTemplate(template.startTime),
        clockFromTemplate(template.endTime),
      );
      return {
        label: template.name,
        startAt,
        endAt,
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        sectorId: context.sectorId,
        scheduleContextId: context.id,
        specialty: context.qualificationName,
      };
    });
    for (const candidate of candidates) {
      assertCanEditScheduleDate(actor, candidate.startAt);
    }

    const existingKeys = new Set(
      (await loadExisting(tx as unknown as typeof db)).map((row) =>
        naturalKey(row),
      ),
    );
    const toCreate = candidates.filter(
      (candidate) => !existingKeys.has(naturalKey(candidate)),
    );
    const skipped = candidates.length - toCreate.length;
    const summary = {
      created: toCreate.length,
      skipped,
      planned: candidates.length,
      mode: input.mode,
      yearMonth: input.yearMonth,
      dryRun: input.dryRun,
    };
    if (input.dryRun || toCreate.length === 0) return summary;

    await lockMonthsForUpdate(tx, [
      {
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        date: targetWindow.start,
      },
    ]);
    await assertMonthsEditableForUpdate(
      tx,
      { user: { id: ctx.user.id } },
      [
        {
          institutionId: ctx.institutionId,
          hospitalId: input.hospitalId,
          date: targetWindow.start,
        },
      ],
      { kind: "vacantCreate" },
    );
    await assertManagerScopeAccessForUpdate(
      tx,
      actor,
      ctx.user.sessionVersion,
      input.hospitalId,
      input.sectorId,
      toCreate.map((candidate) => candidate.startAt),
    );

    const currentKeys = new Set(
      (await loadExisting(tx as unknown as typeof db)).map((row) =>
        naturalKey(row),
      ),
    );
    let created = 0;
    let skippedNow = skipped;
    for (const candidate of toCreate) {
      if (currentKeys.has(naturalKey(candidate))) {
        skippedNow += 1;
        continue;
      }
      await tx.insert(shiftInstances).values({
        institutionId: candidate.institutionId,
        hospitalId: candidate.hospitalId,
        sectorId: candidate.sectorId,
        scheduleContextId: candidate.scheduleContextId,
        label: candidate.label,
        specialty: candidate.specialty,
        startAt: candidate.startAt,
        endAt: candidate.endAt,
        status: "VAGO",
        createdBy: ctx.user.id,
      });
      created += 1;
      currentKeys.add(naturalKey(candidate));
    }
    await recordAudit(
      {
        actorUserId: ctx.user.id,
        actorRole: actor.roleInInstitution,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: 0,
        description: `Abriu ${created} plantões vagos em ${input.yearMonth}.`,
        metadata: {
          openMonthShifts: true,
          created,
          skipped: skippedNow,
          mode: input.mode,
          yearMonth: input.yearMonth,
          sectorId: input.sectorId,
        },
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
      },
      { db: tx as any, strict: true },
    );
    return {
      created,
      skipped: skippedNow,
      planned: candidates.length,
      mode: input.mode,
      yearMonth: input.yearMonth,
      dryRun: false,
    };
  }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);
}

export const shiftsRouter = router({
  // ------------------------------------------------------------------
  // shifts.create — admin/manager only
  // Creates a shiftInstance from a template + date.
  // ------------------------------------------------------------------
  create: protectedProcedure
    .input(
      z
        .object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "date deve ser YYYY-MM-DD"),
          shiftTemplateId: z.number().int(),
          scheduleContextId: z.number().int().positive().optional(),
          sectorId: z.number().int().optional(),
          /** Só entra em LOCKED (Gestor+). Criar vago em PUBLISHED não exige motivo. */
          reason: z.string().max(500).optional(),
        })
        .merge(modalityFields),
    )
    .mutation(async ({ input, ctx }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [template] = await db
        .select()
        .from(shiftTemplates)
        .where(eq(shiftTemplates.id, input.shiftTemplateId));

      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template de turno não encontrado",
        });
      }
      if (template.institutionId !== ctx.institutionId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Template fora do tenant ativo",
        });
      }
      if (!template.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Template de turno inativo",
        });
      }
      const requestedSectorId =
        input.sectorId ?? template.sectorId ?? undefined;
      if (!input.scheduleContextId && !requestedSectorId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "sectorId obrigatório (template não possui setor padrão)",
        });
      }
      const selectedContext = await resolveScheduleContextForShiftCreation({
        institutionId: ctx.institutionId,
        scheduleContextId: input.scheduleContextId,
        hospitalId: template.hospitalId,
        sectorId: requestedSectorId,
        templateSectorId: template.sectorId,
        db,
      });
      const sectorId = selectedContext.sectorId;
      await assertManagerScopeAccess(actor, template.hospitalId, sectorId);

      assertModalityCoherent(input);

      const [startAt, endAt] = buildShiftTimestamps(
        input.date,
        template.startTime,
        template.endTime,
      );
      assertCanEditScheduleDate(actor, startAt);
      const insertId = await db.transaction(async (tx) => {
        await assertMonthEditableForUpdate(
          tx,
          { user: { id: ctx.user.id } },
          template.institutionId,
          template.hospitalId,
          startAt,
          input.reason,
          { kind: "vacantCreate" },
        );
        const activeContext = await resolveScheduleContextForShiftCreation({
          institutionId: ctx.institutionId,
          scheduleContextId: input.scheduleContextId,
          hospitalId: template.hospitalId,
          sectorId: requestedSectorId,
          templateSectorId: template.sectorId,
          db: tx,
        });
        if (
          activeContext.id !== selectedContext.id ||
          activeContext.sectorId !== selectedContext.sectorId ||
          activeContext.medicalSpecialtyId !==
            selectedContext.medicalSpecialtyId ||
          activeContext.operationalProfileCode !==
            selectedContext.operationalProfileCode
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A escala selecionada mudou durante a criação do turno.",
          });
        }
        const proposedKey = naturalKey({
          institutionId: template.institutionId,
          hospitalId: template.hospitalId,
          sectorId,
          scheduleContextId: selectedContext.id,
          startAt,
          endAt,
          label: template.name,
        });
        const [duplicate] = await tx
          .select({
            id: shiftInstances.id,
            institutionId: shiftInstances.institutionId,
            hospitalId: shiftInstances.hospitalId,
            sectorId: shiftInstances.sectorId,
            scheduleContextId: shiftInstances.scheduleContextId,
            startAt: shiftInstances.startAt,
            endAt: shiftInstances.endAt,
            label: shiftInstances.label,
          })
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.institutionId, template.institutionId),
              eq(shiftInstances.hospitalId, template.hospitalId),
              eq(shiftInstances.sectorId, sectorId),
              eq(shiftInstances.scheduleContextId, selectedContext.id),
              eq(shiftInstances.startAt, startAt),
              eq(shiftInstances.endAt, endAt),
              eq(shiftInstances.label, template.name),
            ),
          )
          .limit(1)
          .for("update");
        // Ordem global: mês → recurso operacional (natural key do shift) →
        // identidade/PI/ACL. Admin de e-mail trava o shift antes da identidade;
        // inverter estes dois mutexes aqui recria o ciclo shift↔user.
        await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          template.hospitalId,
          sectorId,
          [startAt],
        );
        if (duplicate && naturalKey(duplicate) === proposedKey) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Já existe um turno com o mesmo horário, setor e identificação.",
          });
        }
        const [result] = await tx.insert(shiftInstances).values({
          institutionId: template.institutionId,
          hospitalId: template.hospitalId,
          sectorId,
          scheduleContextId: selectedContext.id,
          label: template.name,
          specialty: activeContext.qualificationName,
          startAt,
          endAt,
          status: "VAGO",
          createdBy: ctx.user.id,
          // Defaults aplicados pelo DB se não passados: modality=PLANTAO,
          // paymentModel=FIXO. coverageType e productivityCapBrl ficam
          // null por padrão.
          ...(input.modality !== undefined ? { modality: input.modality } : {}),
          ...(input.coverageType !== undefined
            ? { coverageType: input.coverageType }
            : {}),
          ...(input.paymentModel !== undefined
            ? { paymentModel: input.paymentModel }
            : {}),
          ...(input.productivityCapBrl !== undefined
            ? { productivityCapBrl: input.productivityCapBrl }
            : {}),
        });
        const createdId = Number(result.insertId);
        await auditLog(
          {
            event: "SHIFT_CREATED",
            shiftInstanceId: createdId,
            institutionId: ctx.institutionId,
            professionalId: null,
            metadata: {
              createdBy: ctx.user.id,
              templateId: input.shiftTemplateId,
              scheduleContextId: selectedContext.id,
              date: input.date,
            },
          },
          { db: tx },
        );
        await recordAudit(
          {
            actorUserId: ctx.user.id,
            actorRole: actor.roleInInstitution,
            actorName: ctx.user.name ?? undefined,
            action: "SHIFT_CREATED",
            entityType: "SHIFT_INSTANCE",
            entityId: createdId,
            description:
              "Turno criado (" + template.name + " em " + input.date + ")",
            institutionId: ctx.institutionId,
            hospitalId: template.hospitalId,
            sectorId,
            shiftInstanceId: createdId,
          },
          { db: tx, strict: true },
        );
        return createdId;
      });

      const [created] = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.id, insertId));

      return created;
    }),

  // ------------------------------------------------------------------
  // shifts.get — any authenticated user
  // Returns the shiftInstance with template details and assignments.
  // ------------------------------------------------------------------
  get: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const actor = await getTenantActorFromContext(ctx);

      const [instance] = await db
        .select({
          id: shiftInstances.id,
          institutionId: shiftInstances.institutionId,
          hospitalId: shiftInstances.hospitalId,
          sectorId: shiftInstances.sectorId,
          scheduleContextId: shiftInstances.scheduleContextId,
          label: shiftInstances.label,
          specialty: shiftInstances.specialty,
          startAt: shiftInstances.startAt,
          endAt: shiftInstances.endAt,
          status: shiftInstances.status,
          modality: shiftInstances.modality,
          coverageType: shiftInstances.coverageType,
          paymentModel: shiftInstances.paymentModel,
          productivityCapBrl: shiftInstances.productivityCapBrl,
          createdBy: shiftInstances.createdBy,
          createdAt: shiftInstances.createdAt,
          updatedAt: shiftInstances.updatedAt,
          hospitalName: hospitals.name,
          sectorName: sectors.name,
          sectorCategory: sectors.category,
          sectorColor: sectors.color,
        })
        .from(shiftInstances)
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
            eq(sectors.institutionId, shiftInstances.institutionId),
            eq(sectors.hospitalId, shiftInstances.hospitalId),
          ),
        )
        .where(
          and(
            eq(shiftInstances.id, input.id),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        );

      if (!instance) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Turno não encontrado",
        });
      }

      await assertActorCanReadShiftScheduleContext({
        actor,
        shift: instance,
        db,
      });

      // Load the template that matches this instance's hospital + sector + label
      const [template] = await db
        .select()
        .from(shiftTemplates)
        .where(
          and(
            eq(shiftTemplates.institutionId, ctx.institutionId),
            eq(shiftTemplates.hospitalId, instance.hospitalId),
            eq(shiftTemplates.sectorId, instance.sectorId),
            eq(shiftTemplates.name, instance.label),
          ),
        )
        .limit(1);

      const assignments = await db
        .select({
          id: shiftAssignmentsV2.id,
          shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
          institutionId: shiftAssignmentsV2.institutionId,
          hospitalId: shiftAssignmentsV2.hospitalId,
          sectorId: shiftAssignmentsV2.sectorId,
          professionalId: shiftAssignmentsV2.professionalId,
          assignmentType: shiftAssignmentsV2.assignmentType,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
          createdBy: shiftAssignmentsV2.createdBy,
          createdAt: shiftAssignmentsV2.createdAt,
          updatedAt: shiftAssignmentsV2.updatedAt,
          professionalName: professionals.name,
          userId: professionals.userId,
        })
        .from(shiftAssignmentsV2)
        .innerJoin(
          professionals,
          eq(shiftAssignmentsV2.professionalId, professionals.id),
        )
        .innerJoin(
          professionalInstitutions,
          and(
            eq(professionalInstitutions.professionalId, professionals.id),
            eq(professionalInstitutions.userId, professionals.userId),
            eq(
              professionalInstitutions.institutionId,
              shiftAssignmentsV2.institutionId,
            ),
            eq(professionalInstitutions.active, true),
          ),
        )
        .innerJoin(
          users,
          and(
            eq(users.id, professionals.userId),
            eq(users.approvalStatus, "APPROVED"),
            isNull(users.deletedAt),
          ),
        )
        .where(
          and(
            eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
            eq(shiftAssignmentsV2.shiftInstanceId, input.id),
            eq(shiftAssignmentsV2.hospitalId, instance.hospitalId),
            eq(shiftAssignmentsV2.sectorId, instance.sectorId),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        );

      return { ...instance, template: template ?? null, assignments };
    }),

  /**
   * Aviso deliberado do gestor: push aos plantonistas elegíveis deste
   * plantão vago. Não dispara em markVacant / unassignDirect.
   * Input só o shiftInstanceId — tenant, hospital, setor e destinatários
   * saem do plantão + actor.
   */
  notifyVacancy: protectedProcedure
    .input(z.object({ shiftInstanceId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Autenticação necessária",
        });
      }
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      const managerId = actor.professionalId;
      if (!managerId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Profissional não encontrado",
        });
      }

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [shift] = await db
        .select({
          id: shiftInstances.id,
          institutionId: shiftInstances.institutionId,
          hospitalId: shiftInstances.hospitalId,
          sectorId: shiftInstances.sectorId,
          scheduleContextId: shiftInstances.scheduleContextId,
          label: shiftInstances.label,
          startAt: shiftInstances.startAt,
          endAt: shiftInstances.endAt,
          status: shiftInstances.status,
        })
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, input.shiftInstanceId),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        )
        .limit(1);
      if (!shift) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Turno não encontrado",
        });
      }

      await assertInstitutionHierarchy(
        {
          institutionId: shift.institutionId,
          hospitalId: shift.hospitalId,
          sectorId: shift.sectorId,
        },
        { db },
      );
      await assertManagerScopeAccess(actor, shift.hospitalId, shift.sectorId);
      assertCanEditScheduleDate(actor, shift.startAt);

      if (shift.status !== "VAGO") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Este plantão não está mais vago.",
        });
      }
      if (shift.startAt.getTime() <= Date.now()) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Este plantão já começou.",
        });
      }

      return db.transaction(async (tx) => {
        await assertMonthNotLockedForUpdate(
          tx,
          shift.institutionId,
          shift.hospitalId,
          shift.startAt,
        );
        const [locked] = await tx
          .select({
            id: shiftInstances.id,
            institutionId: shiftInstances.institutionId,
            hospitalId: shiftInstances.hospitalId,
            sectorId: shiftInstances.sectorId,
            scheduleContextId: shiftInstances.scheduleContextId,
            label: shiftInstances.label,
            startAt: shiftInstances.startAt,
            endAt: shiftInstances.endAt,
            status: shiftInstances.status,
          })
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.id, input.shiftInstanceId),
              eq(shiftInstances.institutionId, ctx.institutionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!locked) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "O turno não está mais disponível.",
          });
        }
        await assertActiveScheduleContextTopology({
          institutionId: locked.institutionId,
          hospitalId: locked.hospitalId,
          sectorId: locked.sectorId,
          scheduleContextId: locked.scheduleContextId,
          db: tx,
        });
        const actorRole = await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          locked.hospitalId,
          locked.sectorId,
          [locked.startAt],
        );
        if (locked.status !== "VAGO") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Este plantão não está mais vago.",
          });
        }
        const activeAssignments = await tx
          .select({ status: shiftAssignmentsV2.status })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.shiftInstanceId, locked.id),
              eq(shiftAssignmentsV2.institutionId, locked.institutionId),
              eq(shiftAssignmentsV2.hospitalId, locked.hospitalId),
              eq(shiftAssignmentsV2.sectorId, locked.sectorId),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          );
        if (
          activeAssignments.length > 0 ||
          deriveShiftStatus(activeAssignments.map((row) => row.status)) !==
            "VAGO"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Este plantão não está mais vago.",
          });
        }

        const now = new Date();
        if (
          await recentVacancyBroadcastExists(
            tx,
            { id: locked.id, institutionId: locked.institutionId },
            now,
          )
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Este aviso já foi enviado há pouco. Aguarde 15 minutos para enviar de novo.",
          });
        }

        const notifiedCount = await enqueueVacancyAvailableSignals({
          db: tx,
          shift: {
            id: locked.id,
            institutionId: locked.institutionId,
            hospitalId: locked.hospitalId,
            sectorId: locked.sectorId,
            startAt: locked.startAt,
            endAt: locked.endAt,
            label: locked.label,
          },
          now,
        });

        await auditLog(
          {
            event: "VACANCY_BROADCAST",
            shiftInstanceId: locked.id,
            institutionId: locked.institutionId,
            professionalId: managerId,
            metadata: { notifiedCount, actorUserId: userId },
          },
          { db: tx },
        );
        await recordAudit(
          {
            actorUserId: userId,
            actorRole,
            actorName: ctx.user.name ?? undefined,
            action: "PUSH_DISPATCHED",
            entityType: "SHIFT_INSTANCE",
            entityId: locked.id,
            description: "Aviso de plantão vago enviado aos médicos elegíveis",
            institutionId: locked.institutionId,
            shiftInstanceId: locked.id,
            hospitalId: locked.hospitalId,
            sectorId: locked.sectorId,
            metadata: { notifiedCount },
          },
          { db: tx, strict: true },
        );

        return { notifiedCount };
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);
    }),

  // ------------------------------------------------------------------
  // shifts.update — admin/manager only
  // Updates status and/or timestamps; records audit entry.
  // ------------------------------------------------------------------
  update: protectedProcedure
    .input(
      z
        .object({
          id: z.number().int(),
          // `status` saiu do input: o status do turno é DERIVADO das
          // alocações ativas (shift-status.ts). Gravar "VAGO" num turno com
          // titular o devolvia a "Plantões em aberto" (auditoria 22/08, M2).
          startAt: z.string().optional(),
          endAt: z.string().optional(),
          /** Obrigatório (≥ 5 caracteres) para Gestor+ editar mês PUBLISHED/LOCKED. */
          reason: z.string().max(500).optional(),
        })
        .merge(modalityFields),
    )
    .mutation(async ({ input, ctx }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [existing] = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, input.id),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        );

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Turno não encontrado",
        });
      }
      await assertManagerScopeAccess(
        actor,
        existing.hospitalId,
        existing.sectorId,
      );

      assertModalityCoherent(input, existing.modality);

      const patch: Partial<typeof shiftInstances.$inferInsert> = {};
      if (input.startAt !== undefined) patch.startAt = new Date(input.startAt);
      if (input.endAt !== undefined) patch.endAt = new Date(input.endAt);
      if (input.modality !== undefined) patch.modality = input.modality;
      if (input.coverageType !== undefined)
        patch.coverageType = input.coverageType;
      if (input.paymentModel !== undefined)
        patch.paymentModel = input.paymentModel;
      if (input.productivityCapBrl !== undefined)
        patch.productivityCapBrl = input.productivityCapBrl;

      // Mantém o invariante "SOBREAVISO ⇒ coverageType IS NULL". Se a
      // transição é PLANTAO → SOBREAVISO sem coverageType explícito no
      // patch, o valor antigo seria preservado (URGENCIA_EMERGENCIA ou
      // ELETIVAS) e a row ficaria inconsistente. Auto-null defensivo.
      const effectiveModality = patch.modality ?? existing.modality;
      if (
        effectiveModality === "SOBREAVISO" &&
        input.coverageType === undefined &&
        existing.coverageType !== null
      ) {
        patch.coverageType = null;
      }

      if (Object.keys(patch).length === 0) {
        return existing;
      }
      // Data ATUAL e data nova: validar só o destino deixava GESTOR_MEDICO
      // puxar um turno de outro mês para o corrente (auditoria 22/08, M2).
      assertCanEditScheduleDate(actor, existing.startAt);
      if (patch.startAt) assertCanEditScheduleDate(actor, patch.startAt);
      const monthCtx = { user: { id: ctx.user.id } };
      const targetDates = [existing.startAt];
      if (
        patch.startAt &&
        yearMonthBrt(patch.startAt) !== yearMonthBrt(existing.startAt)
      ) {
        targetDates.push(patch.startAt);
      }
      const policyDates =
        patch.startAt && patch.startAt.getTime() !== existing.startAt.getTime()
          ? [existing.startAt, patch.startAt]
          : [existing.startAt];

      await db.transaction(async (tx) => {
        await assertMonthsEditableForUpdate(
          tx,
          monthCtx,
          targetDates.map((date) => ({
            institutionId: ctx.institutionId,
            hospitalId: existing.hospitalId,
            date,
            reason: input.reason,
          })),
        );
        const [locked] = await tx
          .select()
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.id, input.id),
              eq(shiftInstances.institutionId, ctx.institutionId),
            ),
          )
          .limit(1)
          .for("update");
        if (
          !locked ||
          locked.hospitalId !== existing.hospitalId ||
          locked.sectorId !== existing.sectorId ||
          locked.scheduleContextId !== existing.scheduleContextId ||
          locked.startAt.getTime() !== existing.startAt.getTime() ||
          locked.endAt.getTime() !== existing.endAt.getTime() ||
          locked.modality !== existing.modality ||
          locked.coverageType !== existing.coverageType ||
          locked.paymentModel !== existing.paymentModel ||
          locked.productivityCapBrl !== existing.productivityCapBrl
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "O turno mudou enquanto a edição era processada.",
          });
        }

        const effectiveStartAt = patch.startAt ?? locked.startAt;
        const effectiveEndAt = patch.endAt ?? locked.endAt;
        if (
          !Number.isFinite(effectiveStartAt.getTime()) ||
          !Number.isFinite(effectiveEndAt.getTime()) ||
          effectiveEndAt <= effectiveStartAt
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "O fim do turno deve ser posterior ao início.",
          });
        }
        const proposedKey = naturalKey({
          institutionId: locked.institutionId,
          hospitalId: locked.hospitalId,
          sectorId: locked.sectorId,
          scheduleContextId: locked.scheduleContextId,
          startAt: effectiveStartAt,
          endAt: effectiveEndAt,
          label: locked.label,
        });
        const [duplicate] = await tx
          .select({
            id: shiftInstances.id,
            institutionId: shiftInstances.institutionId,
            hospitalId: shiftInstances.hospitalId,
            sectorId: shiftInstances.sectorId,
            scheduleContextId: shiftInstances.scheduleContextId,
            startAt: shiftInstances.startAt,
            endAt: shiftInstances.endAt,
            label: shiftInstances.label,
          })
          .from(shiftInstances)
          .where(
            and(
              ne(shiftInstances.id, locked.id),
              eq(shiftInstances.institutionId, locked.institutionId),
              eq(shiftInstances.hospitalId, locked.hospitalId),
              eq(shiftInstances.sectorId, locked.sectorId),
              ...(locked.scheduleContextId === null
                ? [isNull(shiftInstances.scheduleContextId)]
                : [
                    eq(
                      shiftInstances.scheduleContextId,
                      locked.scheduleContextId,
                    ),
                  ]),
              eq(shiftInstances.startAt, effectiveStartAt),
              eq(shiftInstances.endAt, effectiveEndAt),
              eq(shiftInstances.label, locked.label),
            ),
          )
          .limit(1)
          .for("update");
        if (duplicate && naturalKey(duplicate) === proposedKey) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Já existe um turno com o mesmo horário, setor e identificação.",
          });
        }
        const windowChanged =
          effectiveStartAt.getTime() !== locked.startAt.getTime() ||
          effectiveEndAt.getTime() !== locked.endAt.getTime();
        const activeAssignments = windowChanged
          ? await tx
              .select({
                id: shiftAssignmentsV2.id,
                professionalId: shiftAssignmentsV2.professionalId,
                institutionId: shiftAssignmentsV2.institutionId,
                hospitalId: shiftAssignmentsV2.hospitalId,
                sectorId: shiftAssignmentsV2.sectorId,
              })
              .from(shiftAssignmentsV2)
              .where(
                and(
                  eq(shiftAssignmentsV2.shiftInstanceId, locked.id),
                  eq(shiftAssignmentsV2.isActive, true),
                ),
              )
              .for("update")
          : [];

        await assertAssignmentWritesAllowedForUpdate(
          tx,
          activeAssignments.map((assignment) => ({
            professionalId: assignment.professionalId,
            institutionId: locked.institutionId,
            hospitalId: locked.hospitalId,
            sectorId: locked.sectorId,
            scheduleContextId: locked.scheduleContextId,
            startAt: effectiveStartAt,
            endAt: effectiveEndAt,
            excludeAssignmentIds: [assignment.id],
          })),
          {
            additionalProfessionalIds: actor.professionalId
              ? [actor.professionalId]
              : [],
          },
        );
        await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          locked.hospitalId,
          locked.sectorId,
          policyDates,
        );
        if (windowChanged) {
          await assertShiftAssignmentCapacityForUpdate(tx, {
            shiftInstanceId: locked.id,
            institutionId: locked.institutionId,
            hospitalId: locked.hospitalId,
            sectorId: locked.sectorId,
            activeDelta: 0,
            expectedCurrentActiveCount: activeAssignments.length,
          });
        }

        await tx
          .update(shiftInstances)
          .set(patch)
          .where(eq(shiftInstances.id, input.id));
        const nextDutyType =
          (patch.modality ?? locked.modality) === "SOBREAVISO"
            ? "SOBREAVISO"
            : "PLANTAO";
        const previousDutyType =
          locked.modality === "SOBREAVISO" ? "SOBREAVISO" : "PLANTAO";
        if (windowChanged || nextDutyType !== previousDutyType) {
          await enqueueDutySyncIntervalRewrite(tx, {
            institutionId: locked.institutionId,
            shiftInstanceId: locked.id,
            previousSnapshot: {
              institutionId: locked.institutionId,
              hospitalId: locked.hospitalId,
              sectorId: locked.sectorId,
              label: locked.label,
              startAt: locked.startAt.toISOString(),
              endAt: locked.endAt.toISOString(),
            },
            nextSnapshot: {
              institutionId: locked.institutionId,
              hospitalId: locked.hospitalId,
              sectorId: locked.sectorId,
              label: locked.label,
              startAt: effectiveStartAt.toISOString(),
              endAt: effectiveEndAt.toISOString(),
            },
            previousDutyType,
            nextDutyType,
            previousServiceName: locked.specialty,
            nextServiceName: locked.specialty,
          });
        }
        await auditLog(
          {
            event: "SHIFT_UPDATED",
            shiftInstanceId: input.id,
            institutionId: ctx.institutionId,
            professionalId: null,
            metadata: { updatedBy: ctx.user.id, changes: patch },
          },
          { db: tx },
        );
        await recordAudit(
          {
            actorUserId: ctx.user.id,
            actorRole: actor.roleInInstitution,
            actorName: ctx.user.name ?? undefined,
            action: "SHIFT_UPDATED",
            entityType: "SHIFT_INSTANCE",
            entityId: input.id,
            description: "Turno atualizado",
            institutionId: ctx.institutionId,
            shiftInstanceId: input.id,
            hospitalId: existing.hospitalId,
            sectorId: existing.sectorId,
            metadata: { changes: patch },
          },
          { db: tx, strict: true },
        );
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

      const [updated] = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, input.id),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        );

      return updated;
    }),

  // ------------------------------------------------------------------
  // shifts.listByPeriod — any authenticated user
  // Returns all shiftInstances whose startAt falls within [startDate, endDate].
  // ------------------------------------------------------------------
  listByPeriod: protectedProcedure
    .input(
      z.object({
        startDate: z.string(),
        endDate: z.string(),
        scheduleContextId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const actor = await getTenantActorFromContext(ctx);
      const readableContexts = await listReadableScheduleContexts(actor, db);
      const readableContextIds = new Set(
        readableContexts.map((context) => context.id),
      );
      if (
        input.scheduleContextId !== undefined &&
        !readableContextIds.has(input.scheduleContextId)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Escala fora do acesso do usuário neste tenant.",
        });
      }

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const instanceRows = await db
        .select({
          instance: shiftInstances,
          activeScheduleContextId: scheduleContexts.id,
        })
        .from(shiftInstances)
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
            eq(sectors.institutionId, shiftInstances.institutionId),
            eq(sectors.hospitalId, shiftInstances.hospitalId),
          ),
        )
        .leftJoin(
          scheduleContexts,
          and(
            eq(scheduleContexts.id, shiftInstances.scheduleContextId),
            eq(scheduleContexts.institutionId, shiftInstances.institutionId),
            eq(scheduleContexts.hospitalId, shiftInstances.hospitalId),
            eq(scheduleContexts.sectorId, shiftInstances.sectorId),
            eq(scheduleContexts.active, true),
          ),
        )
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            gte(shiftInstances.startAt, start),
            lte(shiftInstances.startAt, end),
            ...(input.scheduleContextId !== undefined
              ? [eq(shiftInstances.scheduleContextId, input.scheduleContextId)]
              : []),
          ),
        );

      if (instanceRows.length === 0) return [];

      // Attach active assignments (with professional name) to each instance
      const instanceIds = instanceRows.map(({ instance }) => instance.id);
      const allAssignments = await db
        .select({
          id: shiftAssignmentsV2.id,
          shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
          professionalId: shiftAssignmentsV2.professionalId,
          assignmentType: shiftAssignmentsV2.assignmentType,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
          professionalName: professionals.name,
          userId: professionals.userId,
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
            eq(sectors.institutionId, shiftInstances.institutionId),
            eq(sectors.hospitalId, shiftInstances.hospitalId),
          ),
        )
        .innerJoin(
          professionals,
          eq(shiftAssignmentsV2.professionalId, professionals.id),
        )
        .innerJoin(
          professionalInstitutions,
          and(
            eq(professionalInstitutions.professionalId, professionals.id),
            eq(professionalInstitutions.userId, professionals.userId),
            eq(
              professionalInstitutions.institutionId,
              shiftAssignmentsV2.institutionId,
            ),
            eq(professionalInstitutions.active, true),
          ),
        )
        .innerJoin(
          users,
          and(
            eq(users.id, professionals.userId),
            eq(users.approvalStatus, "APPROVED"),
            isNull(users.deletedAt),
          ),
        )
        .where(
          and(
            eq(shiftAssignmentsV2.isActive, true),
            eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
            eq(shiftInstances.institutionId, ctx.institutionId),
            inArray(shiftInstances.id, instanceIds),
          ),
        );

      const assignmentsByShift = new Map<number, typeof allAssignments>();
      for (const a of allAssignments) {
        const list = assignmentsByShift.get(a.shiftInstanceId) ?? [];
        list.push(a);
        assignmentsByShift.set(a.shiftInstanceId, list);
      }

      return instanceRows
        .filter(({ instance, activeScheduleContextId }) => {
          if (input.scheduleContextId !== undefined) {
            return activeScheduleContextId === input.scheduleContextId;
          }
          if (
            activeScheduleContextId !== null &&
            readableContextIds.has(activeScheduleContextId)
          ) {
            return true;
          }
          // Exceção própria e exata; não transforma a alocação em acesso ao
          // restante do setor/contexto.
          return (assignmentsByShift.get(instance.id) ?? []).some(
            (assignment) =>
              assignment.professionalId === actor.professionalId &&
              assignment.userId === actor.userId,
          );
        })
        .map(({ instance }) => ({
          ...instance,
          assignments: assignmentsByShift.get(instance.id) ?? [],
        }));
    }),

  // ------------------------------------------------------------------
  // shifts.listAgenda — any authenticated user (tenant-scoped)
  //
  // Endpoint dedicado para a tela "Agenda" unificada (substitui Calendar
  // + Weekly do menu). Retorna shifts agrupados server-side por
  // (semana → dia → grupo hospital+setor+contexto) — pronto pra renderizar sem
  // pós-processamento no cliente.
  //
  // - scope = "geral": plantões das escalas ativas do tenant (quem está
  //   alocado). Praticar/gerir continua na allowlist.
  // - scope = "minha": filtra onde o profissional do user logado está
  //   ativo em alguma assignment
  //
  // Hospital e setor vêm via JOIN; ordering: hospitalName ASC, sectorName
  // ASC, startAt ASC.
  // ------------------------------------------------------------------
  listAgenda: protectedProcedure
    .input(
      z.object({
        startDate: z.string(), // YYYY-MM-DD (Monday das semanas)
        weeks: z.number().int().min(1).max(12).default(4),
        scope: z.enum(["geral", "minha"]).default("geral"),
        scheduleContextId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const actor = await getTenantActorFromContext(ctx);
      const readableContexts = await listReadableScheduleContexts(actor, db);
      const readableContextsById = new Map(
        readableContexts.map((context) => [context.id, context] as const),
      );
      if (
        input.scope === "geral" &&
        input.scheduleContextId !== undefined &&
        !readableContextsById.has(input.scheduleContextId)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Escala fora do acesso do usuário neste tenant.",
        });
      }

      // Janela em dias do hospital (-03:00): o servidor roda em UTC e o
      // parse sem offset começava a semana às 21h do dia anterior (M6).
      const start = dayWindowBrt(input.startDate).start;
      const end = dayWindowBrt(
        addDaysToKey(input.startDate, input.weeks * 7),
      ).start;

      const assignedProfessionals = alias(
        professionals,
        "agenda_assigned_professionals",
      );
      const assignedMemberships = alias(
        professionalInstitutions,
        "agenda_assigned_memberships",
      );
      const assignedUsers = alias(users, "agenda_assigned_users");

      // Uma única query revalida o ator e traz shifts + assignments. O ator
      // é a tabela raiz para ainda haver uma linha sentinela quando o período
      // está vazio; vínculo revogado ou instituição inativa continuam
      // distinguíveis de uma agenda legitimamente vazia.
      const joinedRows = await db
        .select({
          actorProfessionalId: professionalInstitutions.professionalId,
          id: shiftInstances.id,
          rawScheduleContextId: shiftInstances.scheduleContextId,
          scheduleContextId: scheduleContexts.id,
          hospitalId: shiftInstances.hospitalId,
          sectorId: shiftInstances.sectorId,
          label: shiftInstances.label,
          specialty: shiftInstances.specialty,
          startAt: shiftInstances.startAt,
          endAt: shiftInstances.endAt,
          status: shiftInstances.status,
          modality: shiftInstances.modality,
          coverageType: shiftInstances.coverageType,
          hospitalName: hospitals.name,
          sectorName: sectors.name,
          assignmentId: shiftAssignmentsV2.id,
          assignmentProfessionalId: assignedMemberships.professionalId,
          professionalName: assignedProfessionals.name,
          assignmentUserId: assignedUsers.id,
        })
        .from(professionalInstitutions)
        .innerJoin(
          professionals,
          and(
            eq(professionals.id, professionalInstitutions.professionalId),
            eq(professionals.userId, professionalInstitutions.userId),
          ),
        )
        .innerJoin(
          users,
          and(
            eq(users.id, professionalInstitutions.userId),
            eq(users.id, ctx.user.id),
            eq(users.approvalStatus, "APPROVED"),
            isNull(users.deletedAt),
          ),
        )
        .innerJoin(
          institutions,
          and(
            eq(institutions.id, professionalInstitutions.institutionId),
            eq(institutions.id, ctx.institutionId),
            eq(institutions.isActive, true),
          ),
        )
        .leftJoin(
          shiftInstances,
          and(
            eq(shiftInstances.institutionId, institutions.id),
            gte(shiftInstances.startAt, start),
            lt(shiftInstances.startAt, end),
            ...(input.scheduleContextId !== undefined
              ? [eq(shiftInstances.scheduleContextId, input.scheduleContextId)]
              : []),
          ),
        )
        .leftJoin(
          scheduleContexts,
          and(
            eq(scheduleContexts.id, shiftInstances.scheduleContextId),
            eq(scheduleContexts.institutionId, shiftInstances.institutionId),
            eq(scheduleContexts.hospitalId, shiftInstances.hospitalId),
            eq(scheduleContexts.sectorId, shiftInstances.sectorId),
          ),
        )
        .leftJoin(
          hospitals,
          and(
            eq(hospitals.id, shiftInstances.hospitalId),
            eq(hospitals.institutionId, shiftInstances.institutionId),
          ),
        )
        .leftJoin(
          sectors,
          and(
            eq(sectors.id, shiftInstances.sectorId),
            eq(sectors.institutionId, shiftInstances.institutionId),
            eq(sectors.hospitalId, shiftInstances.hospitalId),
          ),
        )
        .leftJoin(
          shiftAssignmentsV2,
          and(
            eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id),
            eq(shiftAssignmentsV2.institutionId, shiftInstances.institutionId),
            eq(shiftAssignmentsV2.hospitalId, shiftInstances.hospitalId),
            eq(shiftAssignmentsV2.sectorId, shiftInstances.sectorId),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        )
        .leftJoin(
          assignedProfessionals,
          eq(assignedProfessionals.id, shiftAssignmentsV2.professionalId),
        )
        .leftJoin(
          assignedMemberships,
          and(
            eq(assignedMemberships.professionalId, assignedProfessionals.id),
            eq(assignedMemberships.userId, assignedProfessionals.userId),
            eq(
              assignedMemberships.institutionId,
              shiftAssignmentsV2.institutionId,
            ),
            eq(assignedMemberships.active, true),
          ),
        )
        .leftJoin(
          assignedUsers,
          and(
            eq(assignedUsers.id, assignedProfessionals.userId),
            eq(assignedUsers.approvalStatus, "APPROVED"),
            isNull(assignedUsers.deletedAt),
          ),
        )
        .where(
          and(
            eq(professionalInstitutions.userId, ctx.user.id),
            eq(professionalInstitutions.institutionId, ctx.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        );

      if (joinedRows.length === 0) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Usuário sem vínculo ativo para a instituição",
        });
      }

      const myProfessionalId = joinedRows[0].actorProfessionalId;
      if (
        ctx.tenantProfessionalId !== undefined &&
        ctx.tenantProfessionalId !== myProfessionalId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Vínculo profissional mudou durante a consulta",
        });
      }

      type AgendaRow = {
        id: number;
        rawScheduleContextId: number | null;
        scheduleContextId: number | null;
        hospitalId: number;
        sectorId: number;
        label: string;
        specialty: string | null;
        startAt: Date;
        endAt: Date;
        status: typeof shiftInstances.$inferSelect.status;
        modality: typeof shiftInstances.$inferSelect.modality;
        coverageType: typeof shiftInstances.$inferSelect.coverageType;
        hospitalName: string;
        sectorName: string;
      };
      const rowsById = new Map<number, AgendaRow>();
      for (const row of joinedRows) {
        if (
          row.id === null ||
          row.hospitalId === null ||
          row.sectorId === null ||
          row.hospitalName === null ||
          row.sectorName === null
        ) {
          continue;
        }
        // FK isolada não prova topologia composta. Contexto não-null que não
        // fecha com instituição/hospital/setor é descartado fail-closed.
        if (
          row.rawScheduleContextId !== null &&
          row.scheduleContextId === null
        ) {
          continue;
        }
        if (!rowsById.has(row.id)) {
          rowsById.set(row.id, {
            id: row.id,
            rawScheduleContextId: row.rawScheduleContextId,
            scheduleContextId: row.scheduleContextId,
            hospitalId: row.hospitalId,
            sectorId: row.sectorId,
            label: row.label!,
            specialty: row.specialty,
            startAt: row.startAt!,
            endAt: row.endAt!,
            status: row.status!,
            modality: row.modality!,
            coverageType: row.coverageType,
            hospitalName: row.hospitalName,
            sectorName: row.sectorName,
          });
        }
      }
      const rows = Array.from(rowsById.values());

      const assignByShift = new Map<
        number,
        {
          assignmentId: number;
          professionalId: number;
          professionalName: string | null;
        }[]
      >();
      for (const row of joinedRows) {
        if (
          row.id === null ||
          row.assignmentId === null ||
          row.assignmentProfessionalId === null ||
          row.assignmentUserId === null
        ) {
          continue;
        }
        const list = assignByShift.get(row.id) ?? [];
        list.push({
          assignmentId: row.assignmentId,
          professionalId: row.assignmentProfessionalId,
          professionalName: row.professionalName,
        });
        assignByShift.set(row.id, list);
      }
      for (const assignments of assignByShift.values()) {
        assignments.sort(
          (left, right) => left.assignmentId - right.assignmentId,
        );
      }

      // 3. Filtra por escopo se "minha".
      const scoped = rows.filter((r) => {
        if (input.scope === "geral") {
          return (
            r.scheduleContextId !== null &&
            readableContextsById.has(r.scheduleContextId)
          );
        }
        const my = assignByShift.get(r.id) ?? [];
        return my.some((a) => a.professionalId === myProfessionalId);
      });

      // 4. Agrupa por week → day → hospital+sector+context.
      type AgendaShift = {
        id: number;
        scheduleContextId: number | null;
        label: string;
        startAt: Date;
        endAt: Date;
        status: string;
        modality: string;
        coverageType: string | null;
        professionalNames: string[];
        isMine: boolean;
      };
      type AgendaGroup = {
        hospitalId: number;
        hospitalName: string;
        sectorId: number;
        sectorName: string;
        scheduleContextId: number | null;
        qualificationName: string;
        shifts: AgendaShift[];
      };
      type AgendaDay = {
        date: string; // YYYY-MM-DD
        dow: number; // 0=Sun..6=Sat
        groups: AgendaGroup[];
      };
      type AgendaWeek = {
        weekStart: string; // YYYY-MM-DD (segunda da semana)
        days: AgendaDay[];
      };

      // Chaves de dia/semana sempre no relógio do hospital (-03:00), por
      // aritmética de chave — sem getters locais do servidor (UTC).

      // Bucket: Map<weekKey, Map<dayKey, Map<groupKey, AgendaGroup>>>
      const weekMap = new Map<string, Map<string, Map<string, AgendaGroup>>>();

      for (const r of scoped) {
        const dayKey = dayKeyBrt(new Date(r.startAt));
        const wkKey = mondayOfKey(dayKey);
        const groupKey = `${r.hospitalId}-${r.sectorId}-${r.scheduleContextId ?? "legacy"}`;

        let dayMap = weekMap.get(wkKey);
        if (!dayMap) {
          dayMap = new Map();
          weekMap.set(wkKey, dayMap);
        }
        let groupMap = dayMap.get(dayKey);
        if (!groupMap) {
          groupMap = new Map();
          dayMap.set(dayKey, groupMap);
        }
        let group = groupMap.get(groupKey);
        if (!group) {
          group = {
            hospitalId: r.hospitalId,
            hospitalName: r.hospitalName ?? "—",
            sectorId: r.sectorId,
            sectorName: r.sectorName ?? "—",
            scheduleContextId: r.scheduleContextId,
            qualificationName:
              (r.scheduleContextId !== null
                ? readableContextsById.get(r.scheduleContextId)
                    ?.qualificationName
                : null) ??
              r.specialty ??
              "Escala não classificada",
            shifts: [],
          };
          groupMap.set(groupKey, group);
        }
        const myList = assignByShift.get(r.id) ?? [];
        const isMine =
          myProfessionalId != null &&
          myList.some((a) => a.professionalId === myProfessionalId);
        group.shifts.push({
          id: r.id,
          scheduleContextId: r.scheduleContextId,
          label: r.label,
          startAt: r.startAt,
          endAt: r.endAt,
          status: r.status,
          modality: r.modality,
          coverageType: r.coverageType,
          professionalNames: myList
            .map((a) => a.professionalName ?? "—")
            .filter((n) => n.trim().length > 0),
          isMine,
        });
      }

      // 5. Constrói weeks completas (incluindo dias vazios) na ordem de input.
      const weeksOut: AgendaWeek[] = [];
      const baseMon = mondayOfKey(input.startDate);
      for (let w = 0; w < input.weeks; w++) {
        const wkKey = addDaysToKey(baseMon, w * 7);
        const dayMap = weekMap.get(wkKey);
        const days: AgendaDay[] = [];
        for (let d = 0; d < 7; d++) {
          const dayKey = addDaysToKey(wkKey, d);
          const groupMap = dayMap?.get(dayKey);
          const groups: AgendaGroup[] = groupMap
            ? Array.from(groupMap.values())
                .sort((a, b) => {
                  const h = a.hospitalName.localeCompare(
                    b.hospitalName,
                    "pt-BR",
                  );
                  if (h !== 0) return h;
                  const s = a.sectorName.localeCompare(b.sectorName, "pt-BR");
                  if (s !== 0) return s;
                  return a.qualificationName.localeCompare(
                    b.qualificationName,
                    "pt-BR",
                  );
                })
                .map((g) => ({
                  ...g,
                  shifts: g.shifts.slice().sort((a, b) => {
                    const t =
                      new Date(a.startAt).getTime() -
                      new Date(b.startAt).getTime();
                    if (t !== 0) return t;
                    return a.label.localeCompare(b.label, "pt-BR");
                  }),
                }))
            : [];
          days.push({ date: dayKey, dow: weekdayOfKey(dayKey), groups });
        }
        weeksOut.push({ weekStart: wkKey, days });
      }

      return {
        weeks: weeksOut,
        scope: input.scope,
        myProfessionalId,
      };
    }),

  // ------------------------------------------------------------------
  // shifts.listTemplates — any authenticated user
  // Returns all active shift templates (used by create-shift form).
  // ------------------------------------------------------------------
  listTemplates: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return db
      .select()
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, ctx.institutionId),
          eq(shiftTemplates.isActive, true),
        ),
      );
  }),

  // ------------------------------------------------------------------
  // shifts.getActiveShift — any authenticated user
  // Returns the shift that is currently in progress for the logged-in user.
  // Resolves: user.id → professionals.id → shiftAssignmentsV2 → shiftInstances
  // ------------------------------------------------------------------
  getActiveShift: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const actor = await getTenantActorFromContext(ctx);
    if (!actor.professionalId) return null;

    const now = new Date();

    const rows = await db
      .select({ instance: shiftInstances })
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
          eq(sectors.institutionId, shiftInstances.institutionId),
          eq(sectors.hospitalId, shiftInstances.hospitalId),
        ),
      )
      .innerJoin(
        professionals,
        eq(professionals.id, shiftAssignmentsV2.professionalId),
      )
      .innerJoin(
        professionalInstitutions,
        and(
          eq(professionalInstitutions.professionalId, professionals.id),
          eq(professionalInstitutions.userId, professionals.userId),
          eq(
            professionalInstitutions.institutionId,
            shiftInstances.institutionId,
          ),
          eq(professionalInstitutions.active, true),
        ),
      )
      .innerJoin(
        users,
        and(
          eq(users.id, professionals.userId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      )
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, actor.professionalId),
          eq(professionals.userId, actor.userId),
          eq(shiftAssignmentsV2.isActive, true),
          eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
          eq(shiftInstances.institutionId, ctx.institutionId),
          lte(shiftInstances.startAt, now),
          gte(shiftInstances.endAt, now),
        ),
      )
      .limit(1);

    return rows.length > 0 ? rows[0].instance : null;
  }),

  // ------------------------------------------------------------------
  // shifts.getNextShift — o plantão que importa AGORA para o usuário:
  // o que está em andamento ou, se não houver, o próximo futuro.
  // Alimenta o card "Próximo plantão" no topo da Agenda.
  // ------------------------------------------------------------------
  getNextShift: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const actor = await getTenantActorFromContext(ctx);
    if (!actor.professionalId) return null;

    const now = new Date();
    const rows = await db
      .select({
        id: shiftInstances.id,
        label: shiftInstances.label,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
        status: shiftInstances.status,
        modality: shiftInstances.modality,
        sectorName: sectors.name,
        hospitalName: hospitals.name,
        assignmentId: shiftAssignmentsV2.id,
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
        sectors,
        and(
          eq(sectors.id, shiftInstances.sectorId),
          eq(sectors.institutionId, shiftInstances.institutionId),
          eq(sectors.hospitalId, shiftInstances.hospitalId),
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
        professionals,
        eq(professionals.id, shiftAssignmentsV2.professionalId),
      )
      .innerJoin(
        professionalInstitutions,
        and(
          eq(professionalInstitutions.professionalId, professionals.id),
          eq(professionalInstitutions.userId, professionals.userId),
          eq(
            professionalInstitutions.institutionId,
            shiftInstances.institutionId,
          ),
          eq(professionalInstitutions.active, true),
        ),
      )
      .innerJoin(
        users,
        and(
          eq(users.id, professionals.userId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      )
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, actor.professionalId),
          eq(professionals.userId, actor.userId),
          eq(shiftAssignmentsV2.isActive, true),
          eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
          eq(shiftInstances.institutionId, ctx.institutionId),
          // Em andamento (terminou depois de agora) ou futuro.
          gte(shiftInstances.endAt, now),
        ),
      )
      .orderBy(shiftInstances.startAt)
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    return { ...row, inProgress: row.startAt.getTime() <= now.getTime() };
  }),

  // ------------------------------------------------------------------
  // shifts.publish — DRAFT → PUBLISHED
  // ------------------------------------------------------------------
  publish: protectedProcedure
    .input(
      z.object({
        institutionId: z.number().int(),
        hospitalId: z.number().int(),
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
        readinessAcknowledgement: readinessAcknowledgementInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      if (input.institutionId !== ctx.institutionId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "institutionId inválido para tenant ativo",
        });
      }
      await assertManagerScopeAccess(actor, input.hospitalId);
      await publishMonth(
        input.institutionId,
        input.hospitalId,
        input.yearMonth,
        actor,
        ctx.user.sessionVersion,
        ctx.user.name ?? undefined,
        input.readinessAcknowledgement,
      );

      return { ok: true };
    }),

  // ------------------------------------------------------------------
  // shifts.rosterStatus — estado do mês (DRAFT quando não há registro)
  // para o menu de ações do gestor decidir o que oferecer.
  // ------------------------------------------------------------------
  rosterStatus: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int(),
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await assertInstitutionHierarchy(
        { institutionId: ctx.institutionId, hospitalId: input.hospitalId },
        { db },
      );
      const [roster] = await db
        .select({
          status: monthlyRosters.status,
          publishedAt: monthlyRosters.publishedAt,
          lockedAt: monthlyRosters.lockedAt,
        })
        .from(monthlyRosters)
        .where(
          and(
            eq(monthlyRosters.institutionId, ctx.institutionId),
            eq(monthlyRosters.hospitalId, input.hospitalId),
            eq(monthlyRosters.yearMonth, input.yearMonth),
          ),
        )
        .limit(1);
      return {
        status: (roster?.status ?? "DRAFT") as "DRAFT" | "PUBLISHED" | "LOCKED",
        publishedAt: roster?.publishedAt ?? null,
        lockedAt: roster?.lockedAt ?? null,
      };
    }),

  hasMonthShifts: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int().positive(),
        sectorId: z.number().int().positive(),
        yearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      await assertManagerScopeAccess(actor, input.hospitalId, input.sectorId);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await assertInstitutionHierarchy(
        {
          institutionId: ctx.institutionId,
          hospitalId: input.hospitalId,
          sectorId: input.sectorId,
        },
        { db },
      );
      const window = monthWindowBrt(input.yearMonth);
      const [row] = await db
        .select({ id: shiftInstances.id })
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            eq(shiftInstances.hospitalId, input.hospitalId),
            eq(shiftInstances.sectorId, input.sectorId),
            gte(shiftInstances.startAt, window.start),
            lt(shiftInstances.startAt, window.end),
          ),
        )
        .limit(1);
      return { hasShifts: !!row };
    }),

  // ------------------------------------------------------------------
  // shifts.lock — PUBLISHED → LOCKED
  // ------------------------------------------------------------------
  lock: protectedProcedure
    .input(
      z.object({
        institutionId: z.number().int(),
        hospitalId: z.number().int(),
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      if (input.institutionId !== ctx.institutionId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "institutionId inválido para tenant ativo",
        });
      }
      await assertManagerScopeAccess(actor, input.hospitalId);
      await lockMonth(
        input.institutionId,
        input.hospitalId,
        input.yearMonth,
        actor,
        ctx.user.sessionVersion,
        ctx.user.name ?? undefined,
      );

      return { ok: true };
    }),

  // ------------------------------------------------------------------
  // shifts.replicateRange — admin/manager only
  // Copia os turnos (e, opcionalmente, as alocações) de uma semana ou
  // de um mês para outro período. Idempotente: turnos que já existem
  // no destino (mesma chave natural) são pulados; dryRun só conta.
  // ------------------------------------------------------------------
  replicateRange: protectedProcedure
    .input(replicateRangeInput)
    .mutation(async ({ ctx, input }) => replicateRange(ctx, input)),

  replicateMonthCalendar: protectedProcedure
    .input(calendarReplicationInput)
    .mutation(async ({ ctx, input }) => replicateMonthCalendar(ctx, input)),

  openMonthShifts: protectedProcedure
    .input(openMonthShiftsInput)
    .mutation(async ({ ctx, input }) => openMonthShifts(ctx, input)),

  // Compatibilidade: wrapper fino sobre replicateRange (semana).
  replicateWeek: protectedProcedure
    .input(
      z.object({
        fromStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        toStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        hospitalId: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      replicateRange(ctx, {
        hospitalId: input.hospitalId,
        from: { start: input.fromStartDate, granularity: "week" },
        to: { start: input.toStartDate },
        includeAssignments: false,
        dryRun: false,
      }),
    ),
});
