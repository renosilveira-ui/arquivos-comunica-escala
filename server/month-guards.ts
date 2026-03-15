import { getDb } from "./db";
import { yearMonthFromDate } from "../lib/date-utils";
import { auditLog } from "./audit-log";
import { sql, eq, and } from "drizzle-orm";
import { monthlyRosters } from "../drizzle/schema";

/**
 * Guardrail de edição de mês (usado em TODA mutation de edição de turnos)
 * 
 * Regras:
 * - DRAFT → ok (qualquer gestor pode editar)
 * - PUBLISHED → só GESTOR_PLUS pode editar (exige reason obrigatório, min 5 chars)
 * - LOCKED → só GESTOR_PLUS pode editar (exige reason obrigatório, min 5 chars)
 * 
 * Se editar mês publicado/locked, registra audit RETROACTIVE_EDIT com prefixo [PUBLISHED_MONTH_OVERRIDE]
 */
export async function assertMonthEditable(
  ctx: { user: { id: number } },
  institutionId: number,
  hospitalId: number,
  date: Date,
  reason?: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const yearMonth = yearMonthFromDate(date);

  // Buscar professional do ctx.user usando Drizzle query
  const professionalResult = await db.execute<any>(
    sql`SELECT id, role FROM professionals WHERE user_id = ${ctx.user.id} LIMIT 1`
  );

  const professionalRows = (professionalResult as any).rows || (professionalResult as any[]);
  if (!professionalRows || professionalRows.length === 0) {
    throw new Error("Professional not found");
  }

  const professional = professionalRows[0];
  const professionalId = professional.id;
  const role = professional.role;

  // Buscar monthly_roster usando Drizzle query
  const rosterResult = await db.execute<any>(
    sql`SELECT status FROM monthly_rosters 
        WHERE institution_id = ${institutionId} 
        AND hospital_id = ${hospitalId} 
        AND year_month = ${yearMonth} 
        LIMIT 1`
  );

  const rosterRows = (rosterResult as any).rows || (rosterResult as any[]);
  const roster = rosterRows && rosterRows.length > 0 ? rosterRows[0] : null;
  const status = roster ? roster.status : "DRAFT";

  // DRAFT → ok (qualquer gestor pode editar)
  if (status === "DRAFT") {
    return;
  }

  // PUBLISHED ou LOCKED → só GESTOR_PLUS pode editar
  if (status === "PUBLISHED" || status === "LOCKED") {
    if (role !== "GESTOR_PLUS") {
      throw new Error(
        `Mês ${yearMonth} está ${status}. Apenas Gestor+ pode editar.`
      );
    }

    // Exige reason obrigatório (min 5 chars)
    if (!reason || reason.trim().length < 5) {
      throw new Error(
        `Edição de mês ${status} exige motivo (mínimo 5 caracteres).`
      );
    }

    // Audit: PUBLISHED_MONTH_OVERRIDE (usando RETROACTIVE_EDIT como evento)
    await auditLog({
      event: "RETROACTIVE_EDIT",
      shiftInstanceId: 0, // placeholder (não temos shiftInstanceId específico aqui)
      professionalId: professionalId,
      reason: `[PUBLISHED_MONTH_OVERRIDE] ${reason}`,
      metadata: {
        hospitalId,
        yearMonth,
        previousStatus: status,
      },
    });
  }
}


/**
 * Publica um mês DRAFT → PUBLISHED.
 * Preenche published_at, published_by_user_id e incrementa version.
 */
export async function publishMonth(
  institutionId: number,
  hospitalId: number,
  yearMonth: string,
  userId: number
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .update(monthlyRosters)
    .set({
      status: "PUBLISHED",
      publishedAt: new Date(),
      publishedByUserId: userId,
      version: sql`version + 1`,
    })
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonth),
        eq(monthlyRosters.status, "DRAFT")
      )
    );

  if ((result as any)[0].affectedRows === 0) {
    throw new Error("Mês não encontrado ou não está em DRAFT");
  }
}

/**
 * Tranca um mês PUBLISHED → LOCKED.
 * Preenche locked_at, locked_by_user_id e incrementa version.
 */
export async function lockMonth(
  institutionId: number,
  hospitalId: number,
  yearMonth: string,
  userId: number
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .update(monthlyRosters)
    .set({
      status: "LOCKED",
      lockedAt: new Date(),
      lockedByUserId: userId,
      version: sql`version + 1`,
    })
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonth),
        eq(monthlyRosters.status, "PUBLISHED")
      )
    );

  if ((result as any)[0].affectedRows === 0) {
    throw new Error("Mês não encontrado ou não está PUBLISHED");
  }
}
