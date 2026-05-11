import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and, gte, lte, lt, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  shiftInstances,
  shiftTemplates,
  shiftAssignmentsV2,
  professionals,
  hospitals,
  sectors,
} from "../drizzle/schema";
import { auditLog } from "./audit-log";
import { recordAudit } from "./audit-trail";
import { notifyVacancyOpened } from "./integrations/comunica-plus";
import { publishMonth, lockMonth } from "./month-guards";
import {
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
          status: z.enum(["VAGO", "PENDENTE", "OCUPADO"]).optional(),
          startAt: z.string().optional(),
          endAt: z.string().optional(),
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
      if (input.status !== undefined) patch.status = input.status;
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
        shiftInstanceId: input.id,
        hospitalId: existing.hospitalId,
        sectorId: existing.sectorId,
        metadata: { changes: patch },
      });

      // Fire-and-forget: notify Comunica+ if shift became vacant
      if (input.status === "VAGO" && existing.status !== "VAGO") {
        notifyVacancyOpened({
          shiftInstanceId: input.id,
          startAt: existing.startAt.toISOString(),
          endAt: existing.endAt.toISOString(),
          templateName: existing.label,
          sectorName: null, // TODO: resolve sector name from sectorId
        }).catch((err) =>
          console.error("[Comunica+] notifyVacancyOpened error:", err),
        );
      }

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

      const start = new Date(`${input.startDate}T00:00:00`);
      const end = new Date(start);
      end.setDate(end.getDate() + input.weeks * 7);

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

      // Helper: começo da semana (Mon) de uma data, como string YYYY-MM-DD.
      const dateToKey = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const startOfWeekMon = (d: Date) => {
        const c = new Date(d);
        c.setHours(0, 0, 0, 0);
        const dow = c.getDay();
        const diff = dow === 0 ? -6 : 1 - dow;
        c.setDate(c.getDate() + diff);
        return c;
      };

      // Bucket: Map<weekKey, Map<dayKey, Map<groupKey, AgendaGroup>>>
      const weekMap = new Map<string, Map<string, Map<string, AgendaGroup>>>();

      for (const r of scoped) {
        const startDt = new Date(r.startAt);
        const wkStart = startOfWeekMon(startDt);
        const wkKey = dateToKey(wkStart);
        const dayKey = dateToKey(startDt);
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
          modality: "PLANTAO",
          coverageType: null,
          professionalNames: myList
            .map((a) => a.professionalName ?? "—")
            .filter((n) => n.trim().length > 0),
          isMine,
        });
      }

      // 5. Constrói weeks completas (incluindo dias vazios) na ordem de input.
      const weeksOut: AgendaWeek[] = [];
      const cursor = new Date(start);
      const baseMon = startOfWeekMon(cursor);
      for (let w = 0; w < input.weeks; w++) {
        const wkStart = new Date(baseMon);
        wkStart.setDate(baseMon.getDate() + w * 7);
        const wkKey = dateToKey(wkStart);
        const dayMap = weekMap.get(wkKey);
        const days: AgendaDay[] = [];
        for (let d = 0; d < 7; d++) {
          const dayDate = new Date(wkStart);
          dayDate.setDate(wkStart.getDate() + d);
          const dayKey = dateToKey(dayDate);
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
          days.push({ date: dayKey, dow: dayDate.getDay(), groups });
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
  // shifts.replicateWeek — admin/manager only
  // Copies shiftInstances (without assignments) from one week to another.
  // ------------------------------------------------------------------
  replicateWeek: protectedProcedure
    .input(
      z.object({
        fromStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        toStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        hospitalId: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      await assertManagerScopeAccess(actor, input.hospitalId);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const fromStart = new Date(`${input.fromStartDate}T00:00:00`);
      const fromEnd = new Date(fromStart);
      fromEnd.setDate(fromEnd.getDate() + 7);

      const sourceShifts = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            eq(shiftInstances.hospitalId, input.hospitalId),
            gte(shiftInstances.startAt, fromStart),
            lt(shiftInstances.startAt, fromEnd),
          ),
        );

      if (sourceShifts.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Nenhum turno encontrado na semana de origem" });
      }

      const dayOffsetMs =
        new Date(`${input.toStartDate}T00:00:00`).getTime() -
        new Date(`${input.fromStartDate}T00:00:00`).getTime();

      let created = 0;
      for (const shift of sourceShifts) {
        const newStart = new Date(shift.startAt.getTime() + dayOffsetMs);
        const newEnd = new Date(shift.endAt.getTime() + dayOffsetMs);

        await db.insert(shiftInstances).values({
          institutionId: shift.institutionId,
          hospitalId: shift.hospitalId,
          sectorId: shift.sectorId,
          label: shift.label,
          startAt: newStart,
          endAt: newEnd,
          status: "VAGO",
          createdBy: ctx.user.id,
        });
        created++;
      }

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: 0,
        description: `Replicou ${created} turnos de ${input.fromStartDate} para ${input.toStartDate}`,
        hospitalId: input.hospitalId,
      });

      return { created };
    }),
});
