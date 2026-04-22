import { getDb } from "./db";
import { yearMonthFromDate } from "../lib/date-utils";
import { auditLog } from "./audit-log";
import { sql, eq, and } from "drizzle-orm";
import { monthlyRosters, professionalInstitutions, users } from "../drizzle/schema";
import { notifyRosterPublished } from "./integrations/comunica-plus";

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

  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ctx.user.id))
    .limit(1);
  const isGlobalAdmin = user?.role === "admin";

  const [membership] = await db
    .select({
      professionalId: professionalInstitutions.professionalId,
      roleInInstitution: professionalInstitutions.roleInInstitution,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, ctx.user.id),
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);

  if (!membership && !isGlobalAdmin) {
    throw new Error("Professional membership not found for tenant");
  }

  const professionalId = membership?.professionalId ?? null;
  const role = isGlobalAdmin ? "GESTOR_PLUS" : (membership?.roleInInstitution as string);

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
      institutionId,
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

  const [rosterRow] = await db
    .select({ version: monthlyRosters.version })
    .from(monthlyRosters)
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonth),
      ),
    )
    .limit(1);
  const rosterVersion = rosterRow?.version ?? 1;

  // Fire-and-forget: notify Comunica+ about published roster
  (async () => {
    try {
      const emailRows = await db.execute<any>(
        sql`SELECT DISTINCT u.email
            FROM shift_instances si
            JOIN shift_assignments_v2 sa ON sa.shift_instance_id = si.id AND sa.is_active = 1
            JOIN professionals p ON p.id = sa.professional_id
            JOIN users u ON u.id = p.user_id
            WHERE si.hospital_id = ${hospitalId}
            AND si.start_at >= ${yearMonth + '-01'}
            AND si.start_at < DATE_ADD(${yearMonth + '-01'}, INTERVAL 1 MONTH)`,
      );
      const rows = (emailRows as any).rows || (emailRows as any[]);
      const emails: string[] = Array.from(
        new Set((rows || []).map((r: any) => r.email).filter(Boolean)),
      ) as string[];
      if (emails.length > 0) {
        await notifyRosterPublished({
          hospitalId,
          yearMonth,
          version: rosterVersion,
          publishedByUserId: userId,
          professionalEmails: emails,
        });
      }
    } catch (err) {
      console.error("[Comunica+] notifyRosterPublished error:", err);
    }
  })();
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
