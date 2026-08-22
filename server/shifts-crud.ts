import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { addDaysToKey, dayKeyBrt, dayWindowBrt, mondayOfKey, weekdayOfKey, yearMonthBrt } from "./local-time";
import { eq, and, gte, lte, lt, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  shiftInstances,
  shiftTemplates,
  shiftAssignmentsV2,
  professionals,
  hospitals,
  sectors,
  monthlyRosters,
} from "../drizzle/schema";
import { auditLog } from "./audit-log";
import { recordAudit } from "./audit-trail";
import { assertMonthEditable, lockMonth, publishMonth } from "./month-guards";
import { checkTimeConflictForProfessional } from "./shift-validations-v2";
import {
  assertCanEditScheduleDate,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  getTenantActorFromContext,
} from "./_core/policy";

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
  coverageType: z.enum(["URGENCIA_EMERGENCIA", "ELETIVAS"]).nullable().optional(),
  paymentModel: z
    .enum(["FIXO", "FIXO_PRODUTIVIDADE_TETO", "FIXO_PRODUTIVIDADE_SEM_TETO", "PRODUTIVIDADE_PURA"])
    .optional(),
  // BRL como string ("1500.00") para evitar perda de precisão de Number
  // em valores monetários grandes. Drizzle armazena decimal como string
  // no inferType, então segue o mesmo formato no transporte.
  productivityCapBrl: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "productivityCapBrl deve ser BRL no formato \"1500.00\"")
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
function assertModalityCoherent(input: ModalityInput, existingModality?: "PLANTAO" | "SOBREAVISO"): void {
  const effectiveModality = input.modality ?? existingModality ?? "PLANTAO";
  if (effectiveModality === "SOBREAVISO" && input.coverageType != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "SOBREAVISO não admite coverageType (apenas PLANTAO usa cobertura)",
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
      offsetDays: Math.round((targetStart.getTime() - fromStart.getTime()) / DAY_MS),
    };
  }

  const [fy, fm] = from.start.split("-").map(Number);
  const [ty, tm] = to.start.split("-").map(Number);
  const monthStart = (y: number, m: number) => localDayStart(`${y}-${pad2(m)}-01`);
  const nextMonthStart = (y: number, m: number) =>
    m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1);

  const fromStart = monthStart(fy, fm);
  const targetStart = monthStart(ty, tm);
  const offsetDays = Math.round(
    (firstMondayOnOrAfter(targetStart).getTime() - firstMondayOnOrAfter(fromStart).getTime()) /
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
  hospitalId: number;
  sectorId: number;
  startAt: Date;
  endAt: Date;
  label: string;
}): string {
  return `${x.hospitalId}|${x.sectorId}|${x.startAt.getTime()}|${x.endAt.getTime()}|${x.label}`;
}

type ReplicateCtx = {
  user: { id: number; role: string; name?: string | null };
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
    throw new TRPCError({ code: "BAD_REQUEST", message: "Origem e destino são o mesmo período." });
  }

  const sourceShifts = await db
    .select()
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, ctx.institutionId),
        eq(shiftInstances.hospitalId, input.hospitalId),
        ...(input.sectorId ? [eq(shiftInstances.sectorId, input.sectorId)] : []),
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
  // Mês de destino PUBLISHED/LOCKED: só Gestor+ com motivo (um check por mês
  // alvo; em dryRun não há escrita nem auditoria de override).
  if (!input.dryRun) {
    const checked = new Set<string>();
    for (const c of inRange) {
      const ym = yearMonthBrt(c.startAt);
      if (checked.has(ym)) continue;
      checked.add(ym);
      await assertMonthEditable({ user: { id: ctx.user.id } }, ctx.institutionId, input.hospitalId, c.startAt, input.reason);
    }
  }

  // Idempotência pela chave natural (hospital, setor, início, fim, label).
  const existing = await db
    .select({
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
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
      hospitalId: c.source.hospitalId,
      sectorId: c.source.sectorId,
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
  const plannedAssignments: { sourceShiftId: number; assignment: SourceAssignment }[] = [];
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
    for (const a of sourceAssignments) {
      const c = toCreate.find((x) => x.source.id === a.shiftInstanceId);
      if (!c) continue;
      const conflict = await checkTimeConflictForProfessional(a.professionalId, c.startAt, c.endAt);
      if (conflict.hasConflict) {
        conflicts++;
        continue;
      }
      plannedAssignments.push({ sourceShiftId: c.source.id, assignment: a });
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
    let firstCreatedId = 0;
    for (const c of toCreate) {
      const mine = plannedAssignments.filter((p) => p.sourceShiftId === c.source.id);
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
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: firstCreatedId,
        description: `Replicou ${summary.created} turnos de ${input.from.start} (${input.from.granularity === "week" ? "semana" : "mês"}) para ${input.to.start}; ${skipped} já existiam; ${plannedAssignments.length} alocações copiadas; ${conflicts} com conflito`,
        metadata: { replication: true, ...summary, from: input.from, to: input.to },
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
      },
      { db: tx as any, strict: true },
    );
  });

  return summary;
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
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date deve ser YYYY-MM-DD"),
          shiftTemplateId: z.number().int(),
          sectorId: z.number().int().optional(),
          /** Obrigatório (≥ 5 caracteres) para Gestor+ criar em mês PUBLISHED/LOCKED. */
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
        throw new TRPCError({ code: "NOT_FOUND", message: "Template de turno não encontrado" });
      }
      if (template.institutionId !== ctx.institutionId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Template fora do tenant ativo" });
      }
      await assertManagerScopeAccess(actor, template.hospitalId, template.sectorId ?? input.sectorId);

      const sectorId = input.sectorId ?? template.sectorId;
      if (!sectorId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "sectorId obrigatório (template não possui setor padrão)" });
      }

      assertModalityCoherent(input);

      const [startAt, endAt] = buildShiftTimestamps(
        input.date,
        template.startTime,
        template.endTime,
      );
      assertCanEditScheduleDate(actor, startAt);
      // Mês PUBLISHED/LOCKED: só Gestor+ com motivo (mesma regra do editor).
      await assertMonthEditable({ user: { id: ctx.user.id } }, template.institutionId, template.hospitalId, startAt, input.reason);

      const [result] = await db.insert(shiftInstances).values({
        institutionId: template.institutionId,
        hospitalId: template.hospitalId,
        sectorId,
        label: template.name,
        startAt,
        endAt,
        status: "VAGO",
        createdBy: ctx.user.id,
        // Defaults aplicados pelo DB se não passados: modality=PLANTAO,
        // paymentModel=FIXO. coverageType e productivityCapBrl ficam
        // null por padrão.
        ...(input.modality !== undefined ? { modality: input.modality } : {}),
        ...(input.coverageType !== undefined ? { coverageType: input.coverageType } : {}),
        ...(input.paymentModel !== undefined ? { paymentModel: input.paymentModel } : {}),
        ...(input.productivityCapBrl !== undefined ? { productivityCapBrl: input.productivityCapBrl } : {}),
      });

      const insertId = (result as any).insertId as number;

      await auditLog({
        event: "SHIFT_CREATED",
        shiftInstanceId: insertId,
        professionalId: null,
        metadata: { createdBy: ctx.user.id, templateId: input.shiftTemplateId, date: input.date },
      });

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: insertId,
        description: "Turno criado (" + template.name + " em " + input.date + ")",
        institutionId: ctx.institutionId,
        hospitalId: template.hospitalId,
        sectorId: sectorId,
        shiftInstanceId: insertId,
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

      const [instance] = await db
        .select({
          id: shiftInstances.id,
          institutionId: shiftInstances.institutionId,
          hospitalId: shiftInstances.hospitalId,
          sectorId: shiftInstances.sectorId,
          label: shiftInstances.label,
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
        .leftJoin(hospitals, eq(shiftInstances.hospitalId, hospitals.id))
        .leftJoin(sectors, eq(shiftInstances.sectorId, sectors.id))
        .where(
          and(
            eq(shiftInstances.id, input.id),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        );

      if (!instance) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Turno não encontrado" });
      }

      // Load the template that matches this instance's hospital + sector + label
      const [template] = await db
        .select()
        .from(shiftTemplates)
        .where(
          and(
            eq(shiftTemplates.institutionId, ctx.institutionId),
            eq(shiftTemplates.hospitalId, instance.hospitalId),
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
        .leftJoin(professionals, eq(shiftAssignmentsV2.professionalId, professionals.id))
        .where(
          and(
            eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
            eq(shiftAssignmentsV2.shiftInstanceId, input.id),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        );

      return { ...instance, template: template ?? null, assignments };
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
        throw new TRPCError({ code: "NOT_FOUND", message: "Turno não encontrado" });
      }
      await assertManagerScopeAccess(actor, existing.hospitalId, existing.sectorId);

      assertModalityCoherent(input, existing.modality);

      const patch: Partial<typeof shiftInstances.$inferInsert> = {};
      if (input.startAt !== undefined) patch.startAt = new Date(input.startAt);
      if (input.endAt !== undefined) patch.endAt = new Date(input.endAt);
      if (input.modality !== undefined) patch.modality = input.modality;
      if (input.coverageType !== undefined) patch.coverageType = input.coverageType;
      if (input.paymentModel !== undefined) patch.paymentModel = input.paymentModel;
      if (input.productivityCapBrl !== undefined) patch.productivityCapBrl = input.productivityCapBrl;

      // Mantém o invariante "SOBREAVISO ⇒ coverageType IS NULL". Se a
      // transição é PLANTAO → SOBREAVISO sem coverageType explícito no
      // patch, o valor antigo seria preservado (URGENCIA_EMERGENCIA ou
      // ELETIVAS) e a row ficaria inconsistente. Auto-null defensivo.
      const effectiveModality = patch.modality ?? existing.modality;
      if (effectiveModality === "SOBREAVISO" && input.coverageType === undefined && existing.coverageType !== null) {
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
      await assertMonthEditable(monthCtx, ctx.institutionId, existing.hospitalId, existing.startAt, input.reason);
      if (patch.startAt && yearMonthBrt(patch.startAt) !== yearMonthBrt(existing.startAt)) {
        await assertMonthEditable(monthCtx, ctx.institutionId, existing.hospitalId, patch.startAt, input.reason);
      }

      await db
        .update(shiftInstances)
        .set(patch)
        .where(eq(shiftInstances.id, input.id));

      await auditLog({
        event: "SHIFT_UPDATED",
        shiftInstanceId: input.id,
        professionalId: null,
        metadata: { updatedBy: ctx.user.id, changes: patch },
      });

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
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
      });

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
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const instances = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            gte(shiftInstances.startAt, start),
            lte(shiftInstances.startAt, end),
          ),
        );

      if (instances.length === 0) return [];

      // Attach active assignments (with professional name) to each instance
      const instanceIds = instances.map((i) => i.id);
      const allAssignments = await db
        .select({
          id: shiftAssignmentsV2.id,
          shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
          professionalId: shiftAssignmentsV2.professionalId,
          assignmentType: shiftAssignmentsV2.assignmentType,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
          professionalName: professionals.name,
        })
        .from(shiftAssignmentsV2)
        .leftJoin(professionals, eq(shiftAssignmentsV2.professionalId, professionals.id))
        .where(
          and(
            eq(shiftAssignmentsV2.isActive, true),
            eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
            inArray(shiftAssignmentsV2.shiftInstanceId, instanceIds),
          ),
        );

      const assignmentsByShift = new Map<number, typeof allAssignments>();
      for (const a of allAssignments) {
        const list = assignmentsByShift.get(a.shiftInstanceId) ?? [];
        list.push(a);
        assignmentsByShift.set(a.shiftInstanceId, list);
      }

      return instances.map((instance) => ({
        ...instance,
        assignments: assignmentsByShift.get(instance.id) ?? [],
      }));
    }),

  // ------------------------------------------------------------------
  // shifts.listAgenda — any authenticated user (tenant-scoped)
  //
  // Endpoint dedicado para a tela "Agenda" unificada (substitui Calendar
  // + Weekly do menu). Retorna shifts agrupados server-side por
  // (semana → dia → grupo hospital+setor) — pronto pra renderizar sem
  // pós-processamento no cliente.
  //
  // - scope = "geral": todos os shifts do tenant no período
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
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Janela em dias do hospital (-03:00): o servidor roda em UTC e o
      // parse sem offset começava a semana às 21h do dia anterior (M6).
      const start = dayWindowBrt(input.startDate).start;
      const end = dayWindowBrt(addDaysToKey(input.startDate, input.weeks * 7)).start;

      // Resolve professional do user logado uma vez (usado em scope=minha
      // e também útil pra eventual marcação "é um shift meu" no client).
      let myProfessionalId: number | null = null;
      const [me] = await db
        .select({ id: professionals.id })
        .from(professionals)
        .where(eq(professionals.userId, ctx.user.id));
      if (me) myProfessionalId = me.id;

      // 1. Shifts do tenant + hospital/sector via JOIN.
      const rows = await db
        .select({
          id: shiftInstances.id,
          hospitalId: shiftInstances.hospitalId,
          sectorId: shiftInstances.sectorId,
          label: shiftInstances.label,
          startAt: shiftInstances.startAt,
          endAt: shiftInstances.endAt,
          status: shiftInstances.status,
          modality: shiftInstances.modality,
          coverageType: shiftInstances.coverageType,
          hospitalName: hospitals.name,
          sectorName: sectors.name,
        })
        .from(shiftInstances)
        .leftJoin(hospitals, eq(shiftInstances.hospitalId, hospitals.id))
        .leftJoin(sectors, eq(shiftInstances.sectorId, sectors.id))
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            gte(shiftInstances.startAt, start),
            lt(shiftInstances.startAt, end),
          ),
        );

      // 2. Assignments ativos pra cada shift (com nome do profissional).
      const ids = rows.map((r) => r.id);
      const assignments =
        ids.length > 0
          ? await db
              .select({
                shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
                professionalId: shiftAssignmentsV2.professionalId,
                professionalName: professionals.name,
              })
              .from(shiftAssignmentsV2)
              .leftJoin(
                professionals,
                eq(shiftAssignmentsV2.professionalId, professionals.id),
              )
              .where(
                and(
                  eq(shiftAssignmentsV2.isActive, true),
                  eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
                  inArray(shiftAssignmentsV2.shiftInstanceId, ids),
                ),
              )
          : [];

      const assignByShift = new Map<
        number,
        { professionalId: number; professionalName: string | null }[]
      >();
      for (const a of assignments) {
        const list = assignByShift.get(a.shiftInstanceId) ?? [];
        list.push({
          professionalId: a.professionalId,
          professionalName: a.professionalName,
        });
        assignByShift.set(a.shiftInstanceId, list);
      }

      // 3. Filtra por escopo se "minha".
      const scoped = rows.filter((r) => {
        if (input.scope === "geral") return true;
        if (myProfessionalId == null) return false;
        const my = assignByShift.get(r.id) ?? [];
        return my.some((a) => a.professionalId === myProfessionalId);
      });

      // 4. Agrupa por week → day → hospital+sector.
      type AgendaShift = {
        id: number;
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
        const groupKey = `${r.hospitalId}-${r.sectorId}`;

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
                  const h = a.hospitalName.localeCompare(b.hospitalName, "pt-BR");
                  if (h !== 0) return h;
                  return a.sectorName.localeCompare(b.sectorName, "pt-BR");
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

    const [professional] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, ctx.user.id));

    if (!professional) return null;

    const now = new Date();

    const rows = await db
      .select({ instance: shiftInstances })
      .from(shiftAssignmentsV2)
      .innerJoin(
        shiftInstances,
        eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id),
      )
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, professional.id),
          eq(shiftAssignmentsV2.isActive, true),
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

    const [professional] = await db
      .select({ id: professionals.id })
      .from(professionals)
      .where(eq(professionals.userId, ctx.user.id));
    if (!professional) return null;

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
      .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
      .innerJoin(sectors, eq(shiftInstances.sectorId, sectors.id))
      .innerJoin(hospitals, eq(shiftInstances.hospitalId, hospitals.id))
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, professional.id),
          eq(shiftAssignmentsV2.isActive, true),
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      if (input.institutionId !== ctx.institutionId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "institutionId inválido para tenant ativo" });
      }
      await assertManagerScopeAccess(actor, input.hospitalId);
      await publishMonth(
        input.institutionId,
        input.hospitalId,
        input.yearMonth,
        ctx.user.id,
      );

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "ROSTER_PUBLISHED",
        entityType: "MONTHLY_ROSTER",
        entityId: 0,
        description: "Escala publicada (" + input.yearMonth + ")",
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
      });

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
      const [roster] = await db
        .select({ status: monthlyRosters.status, publishedAt: monthlyRosters.publishedAt, lockedAt: monthlyRosters.lockedAt })
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
        throw new TRPCError({ code: "FORBIDDEN", message: "institutionId inválido para tenant ativo" });
      }
      await assertManagerScopeAccess(actor, input.hospitalId);
      await lockMonth(
        input.institutionId,
        input.hospitalId,
        input.yearMonth,
        ctx.user.id,
      );

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "ROSTER_LOCKED",
        entityType: "MONTHLY_ROSTER",
        entityId: 0,
        description: "Escala trancada (" + input.yearMonth + ")",
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
      });

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
