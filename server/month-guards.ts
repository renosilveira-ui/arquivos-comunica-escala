import { getDb } from "./db";
import { TRPCError } from "@trpc/server";
import { recordAudit } from "./audit-trail";
import { yearMonthBrt } from "./local-time";
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

  // Mês no relógio do hospital (-03:00): o servidor roda em UTC.
  const yearMonth = yearMonthBrt(date);

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

  const [roster] = await db
    .select({ id: monthlyRosters.id, status: monthlyRosters.status })
    .from(monthlyRosters)
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonth),
      ),
    )
    .limit(1);
  const status = roster ? roster.status : "DRAFT";

  // DRAFT → ok (qualquer gestor pode editar)
  if (status === "DRAFT") {
    return;
  }

  // PUBLISHED ou LOCKED → só GESTOR_PLUS pode editar
  if (status === "PUBLISHED" || status === "LOCKED") {
    if (role !== "GESTOR_PLUS") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Mês ${yearMonth} está ${status}. Apenas Gestor+ pode editar.`,
      });
    }

    // Exige reason obrigatório (min 5 chars)
    if (!reason || reason.trim().length < 5) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Edição de mês ${status} exige motivo (mínimo 5 caracteres).`,
      });
    }

    // Audit do override no audit_trail. (shift_audit_log exige um
    // shift_instance_id real — o placeholder 0 violava a FK e derrubava
    // TODA edição de mês publicado/trancado por Gestor+.)
    await recordAudit(
      {
        actorUserId: ctx.user.id,
        actorRole: role,
        action: "CONFLICT_OVERRIDDEN",
        entityType: "MONTHLY_ROSTER",
        entityId: roster?.id ?? 0,
        description: `[PUBLISHED_MONTH_OVERRIDE] ${reason.trim()}`,
        institutionId,
        hospitalId,
        metadata: { yearMonth, previousStatus: status, professionalId },
      },
      { strict: true },
    );
  }
}


/** Status do mês (DRAFT quando não há roster). */
export async function getMonthStatus(
  institutionId: number,
  hospitalId: number,
  date: Date,
): Promise<"DRAFT" | "PUBLISHED" | "LOCKED"> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [roster] = await db
    .select({ status: monthlyRosters.status })
    .from(monthlyRosters)
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonthBrt(date)),
      ),
    )
    .limit(1);
  return roster?.status ?? "DRAFT";
}

/**
 * Mês LOCKED não aceita mutação de NINGUÉM pelo fluxo normal (assumir vaga,
 * ofertar/efetivar troca). Gestor+ edita mês trancado só pelas mutations do
 * editor, com motivo (assertMonthEditable).
 */
export async function assertMonthNotLocked(institutionId: number, hospitalId: number, date: Date): Promise<void> {
  if ((await getMonthStatus(institutionId, hospitalId, date)) === "LOCKED") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Escala trancada — não é possível alterar este plantão." });
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

  // Nenhum fluxo cria a linha de monthly_rosters antes daqui: sem este
  // passo, publicar um mês que nunca foi publicado falhava com "Mês não
  // encontrado". Primeira publicação cria o rascunho; a unique
  // (institution, hospital, year_month) protege contra corrida.
  const [existing] = await db
    .select({ status: monthlyRosters.status })
    .from(monthlyRosters)
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonth),
      ),
    )
    .limit(1);
  if (!existing) {
    await db.insert(monthlyRosters).values({ institutionId, hospitalId, yearMonth, status: "DRAFT" });
  } else if (existing.status !== "DRAFT") {
    throw new Error(
      existing.status === "LOCKED"
        ? `A escala de ${yearMonth} já está bloqueada.`
        : `A escala de ${yearMonth} já foi publicada.`,
    );
  }

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
    throw new Error(`A escala de ${yearMonth} acabou de ser publicada por outra pessoa.`);
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
