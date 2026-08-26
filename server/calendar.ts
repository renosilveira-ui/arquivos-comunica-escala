import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { dayKeyBrt, dayWindowBrt, monthWindowBrt } from "./local-time";
import { dateFromExecute, rowsFromExecute } from "./_core/db-results";
import { yearMonthFromDate } from "../lib/date-utils";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getTenantActorFromContext, type TenantActor } from "./_core/policy";
import {
  assertTenantHospitalSector,
  listAuthorizedScheduleContexts,
  requireSingleLegacyScheduleContext,
  type AuthorizedScheduleContext,
} from "./schedule-contexts";

/**
 * Calendar Router
 *
 * Endpoints para visualização do calendário mensal:
 * - getMonthGrid: retorna grid do mês com status M/T/N por dia
 * - getDay: retorna 3 turnos do dia com slots e assignments
 */

// Resolve uma única escala operacional antes de qualquer leitura. Em setores
// com mais de uma qualificação, clientes legados precisam informar o ID em
// vez de misturar os plantões silenciosamente.
async function resolveCalendarAccess(
  actor: TenantActor,
  institutionId: number,
  hospitalId: number,
  sectorId: number,
  yearMonth: string,
  requestedScheduleContextId?: number,
): Promise<{
  context: AuthorizedScheduleContext;
  monthStatus: "DRAFT" | "PUBLISHED" | "LOCKED";
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await assertTenantHospitalSector(db, institutionId, hospitalId, sectorId);
  const candidates = (await listAuthorizedScheduleContexts(actor, db)).filter(
    (context) =>
      context.institutionId === institutionId &&
      context.hospitalId === hospitalId &&
      context.sectorId === sectorId,
  );
  const context =
    requestedScheduleContextId === undefined
      ? requireSingleLegacyScheduleContext(candidates)
      : candidates.find(
          (candidate) => candidate.id === requestedScheduleContextId,
        );
  if (!context) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Escala fora do acesso do usuário neste tenant.",
    });
  }

  // 1. Buscar status do mês
  const rosterResult = await db.execute<any>(
    sql`SELECT status FROM monthly_rosters 
        WHERE institution_id = ${institutionId} 
        AND hospital_id = ${hospitalId} 
        AND ${sql.identifier("year_month")} = ${yearMonth}
        LIMIT 1`,
  );
  const rosterRows = rowsFromExecute<any>(rosterResult);
  const monthStatus = (rosterRows[0]?.status || "DRAFT") as
    "DRAFT" | "PUBLISHED" | "LOCKED";

  // Um gestor lendo fora de sua manager_scope pelo próprio vínculo clínico
  // segue a mesma regra de publicação de um USER.
  if (
    !context.canManage &&
    monthStatus !== "PUBLISHED" &&
    monthStatus !== "LOCKED"
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Você não tem permissão para acessar este calendário",
    });
  }

  return { context, monthStatus };
}

// Helper: agrupa shifts por dia e label
function groupShiftsByDay(
  shifts: { start_at: Date | string; label: string; status: string }[],
): Record<string, Record<string, string>> {
  const grouped: Record<string, Record<string, string>> = {};

  for (const shift of shifts) {
    const date = dayKeyBrt(dateFromExecute(shift.start_at)); // YYYY-MM-DD no relógio do hospital
    const label = shift.label;
    const status = shift.status;

    if (!grouped[date]) {
      grouped[date] = {};
    }

    // Mapear label para letra
    const labelMap: Record<string, string> = {
      Manhã: "M",
      Tarde: "T",
      Noite: "N",
      Cinderela: "C",
    };

    const key = labelMap[label] || label;
    grouped[date][key] = status;
  }

  return grouped;
}

// Helper: gera todos os dias do mês
function generateMonthDays(yearMonth: string): string[] {
  const [year, month] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const days: string[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    days.push(dateStr);
  }

  return days;
}

export const calendarRouter = router({
  /**
   * getMonthGrid
   * Retorna grid do mês com status M/T/N por dia
   */
  getMonthGrid: protectedProcedure
    .input(
      z.object({
        institutionId: z.number(),
        hospitalId: z.number(),
        sectorId: z.number(),
        scheduleContextId: z.number().int().positive().optional(),
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/), // YYYY-MM
      }),
    )
    .query(async ({ ctx, input }) => {
      const { institutionId, hospitalId, sectorId, yearMonth } = input;
      if (institutionId !== ctx.institutionId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "institutionId inválido para tenant ativo",
        });
      }
      const actor = await getTenantActorFromContext(ctx);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // 1. Verificar RBAC
      const { context, monthStatus } = await resolveCalendarAccess(
        actor,
        institutionId,
        hospitalId,
        sectorId,
        yearMonth,
        input.scheduleContextId,
      );

      // 2. Calcular range do mês no relógio do hospital (-03:00), fim exclusivo.
      const { start: startOfMonth, end: endOfMonth } =
        monthWindowBrt(yearMonth);

      // 3. Buscar shift_instances do hospital+setor no range
      const shiftResult = await db.execute<any>(
        sql`SELECT si.id, si.label, si.start_at, si.end_at, si.status
            FROM shift_instances si
            INNER JOIN schedule_contexts sc
              ON sc.id = si.schedule_context_id
             AND sc.institution_id = si.institution_id
             AND sc.hospital_id = si.hospital_id
             AND sc.sector_id = si.sector_id
             AND sc.active = true
            WHERE si.institution_id = ${institutionId}
            AND si.hospital_id = ${hospitalId} AND si.sector_id = ${sectorId}
            AND si.schedule_context_id = ${context.id}
            AND si.start_at >= ${startOfMonth} AND si.start_at < ${endOfMonth}
            ORDER BY si.start_at ASC`,
      );
      const shiftRows = rowsFromExecute<any>(shiftResult);

      // 4. Agrupar por dia e label
      const groupedShifts = groupShiftsByDay(shiftRows);

      // 5. Gerar todos os dias do mês
      const allDays = generateMonthDays(yearMonth);

      // 6. Montar output
      const days = allDays.map((date) => {
        const shifts = groupedShifts[date] || {};
        return {
          date,
          shifts: {
            M: shifts.M || "INATIVO",
            T: shifts.T || "INATIVO",
            N: shifts.N || "INATIVO",
            ...(shifts.C ? { C: shifts.C } : {}),
          },
        };
      });

      // 7. Calcular contadores
      const counts = { VAGO: 0, PENDENTE: 0, OCUPADO: 0 };
      for (const shift of shiftRows) {
        if (shift.status === "VAGO") counts.VAGO++;
        else if (shift.status === "PENDENTE") counts.PENDENTE++;
        else if (shift.status === "OCUPADO") counts.OCUPADO++;
      }

      return {
        scheduleContextId: context.id,
        monthStatus,
        days,
        counts,
      };
    }),

  /**
   * getDay
   * Retorna 3 turnos do dia com slots e assignments
   */
  getDay: protectedProcedure
    .input(
      z.object({
        institutionId: z.number(),
        hospitalId: z.number(),
        sectorId: z.number(),
        scheduleContextId: z.number().int().positive().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
      }),
    )
    .query(async ({ ctx, input }) => {
      const { institutionId, hospitalId, sectorId, date } = input;
      if (institutionId !== ctx.institutionId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "institutionId inválido para tenant ativo",
        });
      }
      const actor = await getTenantActorFromContext(ctx);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // 1. Extrair yearMonth da data
      const yearMonth = yearMonthFromDate(new Date(date));

      // 2. Verificar RBAC
      const { context, monthStatus } = await resolveCalendarAccess(
        actor,
        institutionId,
        hospitalId,
        sectorId,
        yearMonth,
        input.scheduleContextId,
      );

      // 3. Buscar shift_instances do dia
      // Dia no relógio do hospital (-03:00), fim exclusivo (auditoria M6).
      const { start: startOfDay, end: endOfDay } = dayWindowBrt(date);

      const shiftResult = await db.execute<any>(
        sql`SELECT si.id, si.label, si.start_at, si.end_at, si.status
            FROM shift_instances si
            INNER JOIN schedule_contexts sc
              ON sc.id = si.schedule_context_id
             AND sc.institution_id = si.institution_id
             AND sc.hospital_id = si.hospital_id
             AND sc.sector_id = si.sector_id
             AND sc.active = true
            WHERE si.institution_id = ${institutionId}
            AND si.hospital_id = ${hospitalId} AND si.sector_id = ${sectorId}
            AND si.schedule_context_id = ${context.id}
            AND si.start_at >= ${startOfDay} AND si.start_at < ${endOfDay}
            ORDER BY si.start_at ASC`,
      );
      const shiftRows = rowsFromExecute<any>(shiftResult);

      // 4. Para cada shift, buscar assignments
      const shifts = await Promise.all(
        shiftRows.map(
          async (shift: {
            id: number;
            label: string;
            start_at: Date | string;
            end_at: Date | string;
            status: string;
          }) => {
            const assignmentResult = await db.execute<any>(
              sql`SELECT
                  sa.id as assignmentId,
                  sa.assignment_type as assignmentType,
                  sa.professional_id as professionalId,
                  sa.status,
                  p.name as professionalName
                FROM shift_assignments_v2 sa
                JOIN professionals p ON sa.professional_id = p.id
                JOIN users u ON u.id = p.user_id
                  AND u.approval_status = 'APPROVED'
                  AND u.deleted_at IS NULL
                JOIN professional_institutions pi ON pi.professional_id = p.id
                  AND pi.user_id = p.user_id
                  AND pi.institution_id = ${institutionId}
                  AND pi.active = true
                WHERE sa.shift_instance_id = ${shift.id}
                  AND sa.institution_id = ${institutionId}
                  AND sa.hospital_id = ${hospitalId}
                  AND sa.sector_id = ${sectorId}
                  AND sa.is_active = true
                ORDER BY sa.assignment_type ASC`,
            );
            const assignmentRows = rowsFromExecute<any>(assignmentResult);

            // Criar slots (ON_DUTY, BACKUP, ON_CALL)
            const slotTypes = ["ON_DUTY", "BACKUP", "ON_CALL"];
            const slots = slotTypes.map((type) => {
              const assignment = assignmentRows.find(
                (a: any) => a.assignmentType === type,
              );
              if (assignment) {
                return {
                  assignmentType: type,
                  assignmentId: assignment.assignmentId,
                  professionalId: assignment.professionalId,
                  professionalName: assignment.professionalName,
                  status: assignment.status,
                };
              } else {
                return {
                  assignmentType: type,
                  status: "EMPTY",
                };
              }
            });

            return {
              shiftInstanceId: shift.id,
              label: shift.label,
              startAt: dateFromExecute(shift.start_at).toISOString(),
              endAt: dateFromExecute(shift.end_at).toISOString(),
              status: shift.status,
              slots,
            };
          },
        ),
      );

      return {
        date,
        scheduleContextId: context.id,
        monthStatus,
        shifts,
      };
    }),
});
