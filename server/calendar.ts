import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { dayKeyBrt, dayWindowBrt, monthWindowBrt } from "./local-time";
import { dateFromExecute, rowsFromExecute } from "./_core/db-results";
import { assertMonthEditableForUpdate } from "./month-guards";
import { yearMonthFromDate } from "../lib/date-utils";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { shiftInstances } from "../drizzle/schema";
import { auditLog } from "./audit-log";
import { recordAudit } from "./audit-trail";
import {
  actorCapabilities,
  assertCanEditScheduleDate,
  assertManagerScopeAccess,
  assertManagerScopeAccessForUpdate,
  getTenantActorFromContext,
  type TenantActor,
} from "./_core/policy";
import { assertInstitutionHierarchy } from "./_core/tenant";

/**
 * Calendar Router
 * 
 * Endpoints para visualização do calendário mensal:
 * - getMonthGrid: retorna grid do mês com status M/T/N por dia
 * - getDay: retorna 3 turnos do dia com slots e assignments
 */

// Helper: verifica RBAC para acesso ao calendário
async function checkCalendarAccess(
  actor: TenantActor,
  institutionId: number,
  hospitalId: number,
  sectorId: number,
  yearMonth: string
): Promise<{
  canAccess: boolean;
  canAutoCreateShifts: boolean;
  monthStatus: "DRAFT" | "PUBLISHED" | "LOCKED";
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const capabilities = actorCapabilities(actor);

  // Valida a hierarquia para todos os papéis antes de consultar o roster.
  // Gestores passam também pela sua jurisdição; Gestor+/admin continuam com
  // escopo amplo apenas dentro do tenant ativo.
  if (capabilities.canCreateShift) {
    await assertManagerScopeAccess(actor, hospitalId, sectorId);
  } else {
    await assertInstitutionHierarchy(
      { institutionId: actor.institutionId, hospitalId, sectorId },
      { db },
    );
  }

  // 1. Buscar status do mês
  const rosterResult = await db.execute<any>(
    sql`SELECT status FROM monthly_rosters 
        WHERE institution_id = ${institutionId} 
        AND hospital_id = ${hospitalId} 
        AND ${sql.identifier("year_month")} = ${yearMonth}
        LIMIT 1`
  );
  const rosterRows = rowsFromExecute<any>(rosterResult);
  const monthStatus = (rosterRows[0]?.status || "DRAFT") as "DRAFT" | "PUBLISHED" | "LOCKED";

  // USER institucional pode consultar estados finais publicados; LOCKED é
  // somente uma restrição de escrita, não revoga a visibilidade da escala.
  if (!capabilities.canCreateShift) {
    return {
      canAccess: monthStatus === "PUBLISHED" || monthStatus === "LOCKED",
      canAutoCreateShifts: false,
      monthStatus,
    };
  }

  return { canAccess: true, canAutoCreateShifts: true, monthStatus };
}

// Helper: agrupa shifts por dia e label
function groupShiftsByDay(shifts: { start_at: Date | string; label: string; status: string }[]): Record<string, Record<string, string>> {
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
      "Manhã": "M",
      "Tarde": "T",
      "Noite": "N",
      "Cinderela": "C"
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
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/), // YYYY-MM
      })
    )
    .query(async ({ ctx, input }) => {
      const { institutionId, hospitalId, sectorId, yearMonth } = input;
      if (institutionId !== ctx.institutionId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "institutionId inválido para tenant ativo" });
      }
      const actor = await getTenantActorFromContext(ctx);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // 1. Verificar RBAC
      const { canAccess, monthStatus } = await checkCalendarAccess(
        actor,
        institutionId,
        hospitalId,
        sectorId,
        yearMonth
      );

      if (!canAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Você não tem permissão para acessar este calendário",
        });
      }

      // 2. Calcular range do mês no relógio do hospital (-03:00), fim exclusivo.
      const { start: startOfMonth, end: endOfMonth } = monthWindowBrt(yearMonth);

      // 3. Buscar shift_instances do hospital+setor no range
      const shiftResult = await db.execute<any>(
        sql`SELECT id, label, start_at, end_at, status
            FROM shift_instances
            WHERE institution_id = ${institutionId}
            AND hospital_id = ${hospitalId} AND sector_id = ${sectorId}
            AND start_at >= ${startOfMonth} AND start_at < ${endOfMonth}
            ORDER BY start_at ASC`
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
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
      })
    )
    .query(async ({ ctx, input }) => {
      const { institutionId, hospitalId, sectorId, date } = input;
      if (institutionId !== ctx.institutionId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "institutionId inválido para tenant ativo" });
      }
      const actor = await getTenantActorFromContext(ctx);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // 1. Extrair yearMonth da data
      const yearMonth = yearMonthFromDate(new Date(date));

      // 2. Verificar RBAC
      const { canAccess, canAutoCreateShifts, monthStatus } = await checkCalendarAccess(
        actor,
        institutionId,
        hospitalId,
        sectorId,
        yearMonth
      );

      if (!canAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Você não tem permissão para acessar este dia",
        });
      }

      // 3. Buscar shift_instances do dia
      // Dia no relógio do hospital (-03:00), fim exclusivo (auditoria M6).
      const { start: startOfDay, end: endOfDay } = dayWindowBrt(date);

      const shiftResult = await db.execute<any>(
        sql`SELECT id, label, start_at, end_at, status
            FROM shift_instances
            WHERE institution_id = ${institutionId}
            AND hospital_id = ${hospitalId} AND sector_id = ${sectorId}
            AND start_at >= ${startOfDay} AND start_at < ${endOfDay}
            ORDER BY start_at ASC`
      );
      const shiftRows = rowsFromExecute<any>(shiftResult);

      // 4. Para cada shift, buscar assignments
      const shifts = await Promise.all(
        shiftRows.map(async (shift: { id: number; label: string; start_at: Date | string; end_at: Date | string; status: string }) => {
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
                ORDER BY sa.assignment_type ASC`
          );
          const assignmentRows = rowsFromExecute<any>(assignmentResult);

          // Criar slots (ON_DUTY, BACKUP, ON_CALL)
          const slotTypes = ["ON_DUTY", "BACKUP", "ON_CALL"];
          const slots = slotTypes.map((type) => {
            const assignment = assignmentRows.find((a: any) => a.assignmentType === type);
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
        })
      );

      // 5. Se gestor contextual e não existir turno, criar automaticamente
      // como VAGO — mas SÓ se este gestor pudesse criar esses turnos pelo
      // editor: janela do mês corrente (GESTOR_MEDICO) e mês em DRAFT.
      // Abrir um dia de mês publicado/trancado ou fora da alçada numa
      // *query* gravava 3 turnos sem auditoria (auditoria 22/08, M1).
      let mayAutoCreate = canAutoCreateShifts && shifts.length === 0 && monthStatus === "DRAFT";
      const dayStart = new Date(`${date}T00:00:00-03:00`);
      if (mayAutoCreate) {
        try {
          assertCanEditScheduleDate(actor, dayStart);
        } catch {
          mayAutoCreate = false;
        }
      }
      if (mayAutoCreate) {
        // Criar 3 turnos padrão (Manhã, Tarde, Noite)
        const defaultShifts = [
          { label: "Manhã", startHour: 7, endHour: 13 },
          { label: "Tarde", startHour: 13, endHour: 19 },
          { label: "Noite", startHour: 19, endHour: 7 },
        ];

        const createdShifts = await db.transaction(async (tx) => {
          // A linha mensal é a trava de serialização: publicação/lock e outra
          // auto-criação do mesmo mês precisam concluir antes desta decisão.
          await assertMonthEditableForUpdate(
            tx,
            { user: { id: ctx.user.id } },
            institutionId,
            hospitalId,
            dayStart,
          );

          const existingQuery = tx
            .select({ id: shiftInstances.id })
            .from(shiftInstances)
            .where(
              and(
                eq(shiftInstances.institutionId, institutionId),
                eq(shiftInstances.hospitalId, hospitalId),
                eq(shiftInstances.sectorId, sectorId),
                gte(shiftInstances.startAt, startOfDay),
                lt(shiftInstances.startAt, endOfDay),
              ),
            )
            .limit(1);
          const existing = await existingQuery.for("update");
          if (existing.length > 0) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Os turnos deste dia foram criados por outra operação.",
            });
          }

          const actorRole = await assertManagerScopeAccessForUpdate(
            tx,
            actor,
            ctx.user.sessionVersion,
            hospitalId,
            sectorId,
            [dayStart],
          );
          const created = [] as {
            shiftInstanceId: number;
            label: string;
            startAt: string;
            endAt: string;
            status: string;
            slots: { assignmentType: string; status: string }[];
          }[];

          for (const def of defaultShifts) {
            // Horário de PAREDE do hospital (America/Sao_Paulo, UTC-3 fixo) —
            // mesma convenção de shifts-crud.buildShiftTimestamps.
            const pad = (hour: number) => String(hour).padStart(2, "0");
            const startAt = new Date(`${date}T${pad(def.startHour)}:00:00-03:00`);
            let endAt = new Date(`${date}T${pad(def.endHour)}:00:00-03:00`);
            if (endAt <= startAt) endAt = new Date(endAt.getTime() + 24 * 60 * 60 * 1000);

            const [inserted] = await tx.insert(shiftInstances).values({
              institutionId,
              hospitalId,
              sectorId,
              label: def.label,
              startAt,
              endAt,
              status: "VAGO",
              createdBy: ctx.user.id,
            });
            const shiftInstanceId = Number(inserted.insertId);

            await auditLog(
              {
                event: "SHIFT_CREATED",
                shiftInstanceId,
                institutionId,
                professionalId: actor.professionalId,
                reason: "Criação automática ao abrir o dia",
                metadata: { autoCreated: true, date, sectorId, label: def.label },
              },
              { db: tx },
            );
            await recordAudit(
              {
                actorUserId: ctx.user.id,
                actorRole,
                actorName: ctx.user.name ?? undefined,
                action: "SHIFT_CREATED",
                entityType: "SHIFT_INSTANCE",
                entityId: shiftInstanceId,
                description: `Turno ${def.label} criado automaticamente em ${date}`,
                institutionId,
                hospitalId,
                sectorId,
                shiftInstanceId,
                metadata: { autoCreated: true },
              },
              { db: tx, strict: true },
            );

            created.push({
              shiftInstanceId,
              label: def.label,
              startAt: startAt.toISOString(),
              endAt: endAt.toISOString(),
              status: "VAGO",
              slots: [
                { assignmentType: "ON_DUTY", status: "EMPTY" },
                { assignmentType: "BACKUP", status: "EMPTY" },
                { assignmentType: "ON_CALL", status: "EMPTY" },
              ],
            });
          }
          return created;
        });
        shifts.push(...createdShifts);
      }

      return {
        date,
        monthStatus,
        shifts,
      };
    }),
});
