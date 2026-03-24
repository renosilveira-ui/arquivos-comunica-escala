import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { ForbiddenError } from "../shared/_core/errors";
import { yearMonthFromDate } from "../lib/date-utils";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

/**
 * Calendar Router
 * 
 * Endpoints para visualização do calendário mensal:
 * - getMonthGrid: retorna grid do mês com status M/T/N por dia
 * - getDay: retorna 3 turnos do dia com slots e assignments
 */

// Helper: verifica RBAC para acesso ao calendário
async function checkCalendarAccess(
  userId: number,
  institutionId: number,
  hospitalId: number,
  sectorId: number,
  yearMonth: string
): Promise<{ canAccess: boolean; monthStatus: "DRAFT" | "PUBLISHED" | "LOCKED" }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. Buscar status do mês
  const rosterResult = await db.execute<any>(
    sql`SELECT status FROM monthly_rosters 
        WHERE institution_id = ${institutionId} 
        AND hospital_id = ${hospitalId} 
        AND year_month = ${yearMonth}
        LIMIT 1`
  );
  const rosterRows = (rosterResult as any).rows || (rosterResult as any[]);
  const monthStatus = (rosterRows[0]?.status || "DRAFT") as "DRAFT" | "PUBLISHED" | "LOCKED";

  // 2. Buscar profissional do usuário
  const professionalResult = await db.execute<any>(
    sql`SELECT id, user_role FROM professionals WHERE user_id = ${userId} LIMIT 1`
  );
  const professionalRows = (professionalResult as any).rows || (professionalResult as any[]);

  if (!professionalRows[0]) {
    return { canAccess: false, monthStatus };
  }

  const professionalId = professionalRows[0].id;
  const role = professionalRows[0].user_role as string;

  // 3. USER: só pode acessar se mês PUBLISHED
  if (role === "USER") {
    return { canAccess: monthStatus === "PUBLISHED", monthStatus };
  }

  // 4. GESTOR_PLUS: vê tudo
  if (role === "GESTOR_PLUS") {
    return { canAccess: true, monthStatus };
  }

  // 5. GESTOR_MEDICO: precisa estar em manager_scope (hospital OU setor)
  const scopeResult = await db.execute<any>(
    sql`SELECT COUNT(*) as count FROM manager_scope
        WHERE manager_professional_id = ${professionalId}
        AND institution_id = ${institutionId}
        AND (hospital_id = ${hospitalId} OR sector_id = ${sectorId})`
  );
  const scopeRows = (scopeResult as any).rows || (scopeResult as any[]);
  const hasScope = scopeRows[0]?.count > 0;
  return { canAccess: hasScope, monthStatus };
}

// Helper: agrupa shifts por dia e label
function groupShiftsByDay(shifts: Array<{ start_at: Date; label: string; status: string }>): Record<string, Record<string, string>> {
  const grouped: Record<string, Record<string, string>> = {};

  for (const shift of shifts) {
    const date = shift.start_at.toISOString().split("T")[0]; // YYYY-MM-DD
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
      const userId = ctx.user?.id;
      if (!userId) {
        throw new ForbiddenError("Autenticação necessária");
      }

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // 1. Verificar RBAC
      const { canAccess, monthStatus } = await checkCalendarAccess(
        userId,
        institutionId,
        hospitalId,
        sectorId,
        yearMonth
      );

      if (!canAccess) {
        throw new ForbiddenError("Você não tem permissão para acessar este calendário");
      }

      // 2. Calcular range do mês
      const [year, month] = yearMonth.split("-").map(Number);
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0, 23, 59, 59);

      // 3. Buscar shift_instances do hospital+setor no range
      const shiftResult = await db.execute<any>(
        sql`SELECT id, label, start_at, end_at, status
            FROM shift_instances
            WHERE institution_id = ${institutionId}
            AND hospital_id = ${hospitalId} AND sector_id = ${sectorId}
            AND start_at >= ${startOfMonth} AND start_at <= ${endOfMonth}
            ORDER BY start_at ASC`
      );
      const shiftRows = (shiftResult as any).rows || (shiftResult as any[]);

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
      const userId = ctx.user?.id;
      if (!userId) {
        throw new ForbiddenError("Autenticação necessária");
      }

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // 1. Extrair yearMonth da data
      const yearMonth = yearMonthFromDate(new Date(date));

      // 2. Verificar RBAC
      const { canAccess, monthStatus } = await checkCalendarAccess(
        userId,
        institutionId,
        hospitalId,
        sectorId,
        yearMonth
      );

      if (!canAccess) {
        throw new ForbiddenError("Você não tem permissão para acessar este dia");
      }

      // 3. Buscar shift_instances do dia
      const startOfDay = new Date(date + "T00:00:00");
      const endOfDay = new Date(date + "T23:59:59");

      const shiftResult = await db.execute<any>(
        sql`SELECT id, label, start_at, end_at, status
            FROM shift_instances
            WHERE institution_id = ${institutionId}
            AND hospital_id = ${hospitalId} AND sector_id = ${sectorId}
            AND start_at >= ${startOfDay} AND start_at <= ${endOfDay}
            ORDER BY start_at ASC`
      );
      const shiftRows = (shiftResult as any).rows || (shiftResult as any[]);

      // 4. Buscar role do usuário para decidir se cria turnos automaticamente
      const professionalResult = await db.execute<any>(
        sql`SELECT user_role FROM professionals WHERE user_id = ${userId} LIMIT 1`
      );
      const professionalRows = (professionalResult as any).rows || (professionalResult as any[]);
      const role = professionalRows[0]?.user_role as string;

      // 5. Para cada shift, buscar assignments
      const shifts = await Promise.all(
        shiftRows.map(async (shift: { id: number; label: string; start_at: Date; end_at: Date; status: string }) => {
          const assignmentResult = await db.execute<any>(
            sql`SELECT 
                  sa.id as assignmentId,
                  sa.assignment_type as assignmentType,
                  sa.professional_id as professionalId,
                  sa.status,
                  p.name as professionalName
                FROM shift_assignments_v2 sa
                LEFT JOIN professionals p ON sa.professional_id = p.id
                WHERE sa.shift_instance_id = ${shift.id} AND sa.is_active = true
                ORDER BY sa.assignment_type ASC`
          );
          const assignmentRows = (assignmentResult as any).rows || (assignmentResult as any[]);

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
            startAt: shift.start_at.toISOString(),
            endAt: shift.end_at.toISOString(),
            status: shift.status,
            slots,
          };
        })
      );

      // 6. Se gestor e não existir turno, criar automaticamente como VAGO
      if (role !== "USER" && shifts.length === 0) {
        // Criar 3 turnos padrão (Manhã, Tarde, Noite)
        const defaultShifts = [
          { label: "Manhã", startHour: 7, endHour: 13 },
          { label: "Tarde", startHour: 13, endHour: 19 },
          { label: "Noite", startHour: 19, endHour: 7 },
        ];

        for (const def of defaultShifts) {
          const startAt = new Date(date + `T${String(def.startHour).padStart(2, "0")}:00:00`);
          let endAt: Date;
          if (def.endHour < def.startHour) {
            // Noite: termina no dia seguinte
            endAt = new Date(startAt);
            endAt.setDate(endAt.getDate() + 1);
            endAt.setHours(def.endHour, 0, 0, 0);
          } else {
            endAt = new Date(date + `T${String(def.endHour).padStart(2, "0")}:00:00`);
          }

          await db.execute(
            sql`INSERT INTO shift_instances 
                (institution_id, hospital_id, sector_id, label, start_at, end_at, status)
                VALUES (${institutionId}, ${hospitalId}, ${sectorId}, ${def.label}, ${startAt}, ${endAt}, 'VAGO')`
          );

          const idResult = await db.execute<any>(sql`SELECT LAST_INSERT_ID() as id`);
          const idRows = (idResult as any).rows || (idResult as any[]);
          const shiftInstanceId = idRows[0].id;

          shifts.push({
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
      }

      return {
        date,
        monthStatus,
        shifts,
      };
    }),
});
