import { getDb } from "./db";
import { TRPCError } from "@trpc/server";
import { recordAudit } from "./audit-trail";
import { monthWindowBrt, yearMonthBrt } from "./local-time";
import { sql, eq, and, gte, isNull, lt, or } from "drizzle-orm";
import {
  hospitals,
  institutions,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { enqueueComunicaRosterPublished } from "./integrations/comunica-plus";
import { assertInstitutionHierarchy } from "./_core/tenant";
import { rowsFromExecute } from "./_core/db-results";
import {
  assertManagerScopeAccessForUpdate,
  type TenantActor,
} from "./_core/policy";
import {
  assessCorporateReadinessAcknowledgement,
  operationalWarningSnapshot,
  type CorporateReadinessAcknowledgement,
} from "./corporate-readiness-acknowledgement";
import {
  getCorporateReadinessReport,
  type CorporateReadinessReportV1,
} from "./corporate-readiness-v1";
import {
  captureInstitutionReadinessFenceV1HighWatermark,
  withReadinessFenceV1FinalDecisionTransaction,
} from "./readiness-fence-v1";

type MonthLockDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "execute" | "insert" | "select"
>;

type MonthReadDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

type MonthTransaction = Parameters<
  Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]
>[0];

export type MonthLockTarget = {
  institutionId: number;
  hospitalId: number;
  date: Date;
};

export type EditableMonthTarget = MonthLockTarget & {
  reason?: string;
};

/**
 * `vacantCreate`: abrir/gerar plantões vagos (create, openMonthShifts,
 * replicateMonthCalendar). Não é override de escala oficial — PUBLISHED
 * segue sem Gestor+ e sem motivo, com 0 ou N plantões já existentes.
 * LOCKED continua exigindo Gestor+ e motivo.
 *
 * `edit` (padrão): alocar/desalocar/mover/atualizar plantão existente.
 * PUBLISHED vazio ainda é montagem; PUBLISHED com conteúdo e LOCKED
 * exigem Gestor+ e motivo de auditoria.
 */
export type MonthEditKind = "edit" | "vacantCreate";

export type OfficialRosterStatus = "PUBLISHED" | "LOCKED";

type LockedMonthRow = MonthLockTarget & {
  yearMonth: string;
  rosterId: number;
  status: "DRAFT" | "PUBLISHED" | "LOCKED";
};

function dateInsideYearMonth(yearMonth: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Mês inválido; use YYYY-MM",
    });
  }
  // Meio-dia em Fortaleza evita qualquer transição de data durante a
  // conversão e permite aplicar a mesma política temporal das demais
  // mutations de escala ao publish/lock.
  const date = new Date(`${yearMonth}-15T12:00:00-03:00`);
  if (!Number.isFinite(date.getTime()) || yearMonthBrt(date) !== yearMonth) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Mês inválido; use YYYY-MM",
    });
  }
  return date;
}

function orderedMonthTargets(targets: readonly MonthLockTarget[]) {
  return [...new Map(
    targets.map((target) => {
      const yearMonth = yearMonthBrt(target.date);
      return [
        `${target.institutionId}:${target.hospitalId}:${yearMonth}`,
        { ...target, yearMonth },
      ] as const;
    }),
  ).values()].sort((left, right) =>
    left.institutionId - right.institutionId ||
    left.hospitalId - right.hospitalId ||
    left.yearMonth.localeCompare(right.yearMonth),
  );
}

/**
 * Confirma que o mês já é uma escala oficial para o profissional.
 *
 * PUBLISHED e LOCKED são o status de `monthly_rosters` no par
 * hospital+mês — independem de existirem `shift_instances`. Seed ou
 * materialização DRAFT seguida de publish pode deixar o mês "Publicada"
 * com calendário vazio; isso não prova escala oficial com plantões.
 *
 * Esta leitura não materializa DRAFT e não usa lock: PUBLISHED e LOCKED são
 * estados monotônicos no fluxo de publicação, portanto uma aceitação válida
 * nunca volta a ser rascunho. O caller deve fornecer uma tupla
 * instituição/hospital já validada pela hierarquia canônica.
 */
export async function assertOfficialRoster(
  db: MonthReadDb,
  institutionId: number,
  hospitalId: number,
  date: Date,
): Promise<OfficialRosterStatus> {
  const yearMonth = yearMonthBrt(date);
  const [roster] = await db
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

  if (roster?.status !== "PUBLISHED" && roster?.status !== "LOCKED") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `A escala de ${yearMonth} ainda não foi publicada.`,
    });
  }
  return roster.status;
}

async function lockMonthRowsForUpdate(
  tx: MonthLockDb,
  targets: readonly MonthLockTarget[],
): Promise<LockedMonthRow[]> {
  const locked: LockedMonthRow[] = [];
  for (const target of orderedMonthTargets(targets)) {
    // Materializar DRAFT elimina a dependência de gap locks e da isolation
    // level do MySQL quando o mês ainda não possui roster. O no-op do
    // duplicate key também espera uma publicação/lock concorrente.
    await tx
      .insert(monthlyRosters)
      .values({
        institutionId: target.institutionId,
        hospitalId: target.hospitalId,
        yearMonth: target.yearMonth,
        status: "DRAFT",
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${monthlyRosters.id}` } });

    const result = await tx.execute(
      sql`SELECT ${monthlyRosters.id} AS id,
                 ${monthlyRosters.status} AS status
          FROM ${monthlyRosters}
          WHERE ${monthlyRosters.institutionId} = ${target.institutionId}
            AND ${monthlyRosters.hospitalId} = ${target.hospitalId}
            AND ${monthlyRosters.yearMonth} = ${target.yearMonth}
          LIMIT 1
          FOR UPDATE`,
    );
    const [roster] = rowsFromExecute<{
      id: number;
      status: "DRAFT" | "PUBLISHED" | "LOCKED";
    }>(result);
    if (!roster) {
      throw new Error(`Falha ao materializar o roster ${target.yearMonth}`);
    }
    locked.push({
      institutionId: target.institutionId,
      hospitalId: target.hospitalId,
      date: target.date,
      yearMonth: target.yearMonth,
      rosterId: roster.id,
      status: roster.status,
    });
  }
  return locked;
}

/**
 * Mutex de meses sem decisão de política. Operações que leem um período e
 * escrevem em outro podem travar a união das duas pontas em ordem canônica
 * antes de tocar turnos. A eventual materialização DRAFT é apenas a linha de
 * coordenação transacional; não publica nem desbloqueia a escala de origem.
 */
export async function lockMonthsForUpdate(
  tx: MonthLockDb,
  targets: readonly MonthLockTarget[],
): Promise<void> {
  await lockMonthRowsForUpdate(tx, targets);
}

/**
 * Variante transacional da guarda de mês.
 *
 * O `FOR UPDATE` serializa a decisão com `lockMonth`, cujo UPDATE disputa a
 * mesma linha de `monthly_rosters`. Assim não existe janela entre "está
 * aberto" e a escrita da alocação: ou a decisão termina antes do lock, ou
 * espera o lock terminar e observa `LOCKED`.
 */
export async function assertMonthNotLockedForUpdate(
  tx: MonthLockDb,
  institutionId: number,
  hospitalId: number,
  date: Date,
): Promise<void> {
  await assertMonthsNotLockedForUpdate(tx, [{ institutionId, hospitalId, date }]);
}

/**
 * Variante para operações que alteram mais de um mês (trocas de plantão).
 * As chaves são deduplicadas e travadas em ordem total estável; duas trocas
 * concorrentes que percorrem os mesmos meses em sentidos opostos não podem
 * formar um ciclo de deadlock.
 */
export async function assertMonthsNotLockedForUpdate(
  tx: MonthLockDb,
  targets: readonly MonthLockTarget[],
): Promise<void> {
  for (const roster of await lockMonthRowsForUpdate(tx, targets)) {
    if (roster.status === "LOCKED") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Escala trancada — não é possível alterar este plantão.",
      });
    }
  }
}

/**
 * Há plantão materializado neste hospital+mês? `monthly_rosters.status`
 * não responde isso: PUBLISHED pode ser um mês vazio publicado cedo
 * demais. A guarda de override só vale quando já existe conteúdo.
 */
async function monthHasShiftInstances(
  tx: MonthLockDb,
  institutionId: number,
  hospitalId: number,
  yearMonth: string,
): Promise<boolean> {
  const window = monthWindowBrt(yearMonth);
  const [row] = await tx
    .select({ id: shiftInstances.id })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, institutionId),
        eq(shiftInstances.hospitalId, hospitalId),
        gte(shiftInstances.startAt, window.start),
        lt(shiftInstances.startAt, window.end),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Guarda transacional para edições administrativas. Além de serializar com
 * publish/lock, registra o override no mesmo commit da alteração operacional.
 *
 * PUBLISHED sem nenhum `shift_instance` no hospital+mês não é escala
 * oficial em produção: o gestor monta o primeiro calendário como se o
 * roster ainda fosse DRAFT (sem Gestor+ e sem motivo de 5 caracteres).
 * Criar plantões vagos (`kind: "vacantCreate"`) também não é override —
 * o calendário ainda está sendo preenchido, mesmo com turnos já
 * existentes. LOCKED continua trancado mesmo vazio.
 */
export async function assertMonthsEditableForUpdate(
  tx: MonthLockDb,
  ctx: { user: { id: number } },
  targets: readonly EditableMonthTarget[],
  options?: { kind?: MonthEditKind },
): Promise<void> {
  const reasons = new Map(
    targets.map((target) => [
      `${target.institutionId}:${target.hospitalId}:${yearMonthBrt(target.date)}`,
      target.reason,
    ]),
  );
  const rosters = await lockMonthRowsForUpdate(tx, targets);
  const [account] = await tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ctx.user.id))
    .limit(1);
  if (!account) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Usuário não encontrado" });
  }

  const memberships = new Map<number, {
    professionalId: number;
    roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
  }>();
  for (const institutionId of new Set(rosters.map((roster) => roster.institutionId))) {
    const [membership] = await tx
      .select({
        professionalId: professionalInstitutions.professionalId,
        roleInInstitution: professionalInstitutions.roleInInstitution,
      })
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
          eq(professionalInstitutions.userId, ctx.user.id),
          eq(professionalInstitutions.institutionId, institutionId),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1);
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Vínculo profissional ativo não encontrado para esta instituição",
      });
    }
    memberships.set(institutionId, membership);
  }

  for (const roster of rosters) {
    if (roster.status === "DRAFT") continue;
    if (roster.status === "PUBLISHED" && options?.kind === "vacantCreate") {
      continue;
    }
    const emptyPublished =
      roster.status === "PUBLISHED" &&
      !(await monthHasShiftInstances(
        tx,
        roster.institutionId,
        roster.hospitalId,
        roster.yearMonth,
      ));
    if (emptyPublished) continue;
    const membership = memberships.get(roster.institutionId)!;
    const role = account.role === "admin"
      ? "GESTOR_PLUS"
      : membership.roleInInstitution;
    if (role !== "GESTOR_PLUS") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Mês ${roster.yearMonth} está ${roster.status}. Apenas Gestor+ pode editar.`,
      });
    }
    const key = `${roster.institutionId}:${roster.hospitalId}:${roster.yearMonth}`;
    const reason = reasons.get(key)?.trim();
    if (!reason || reason.length < 5) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Edição de mês ${roster.status} exige motivo (mínimo 5 caracteres).`,
      });
    }
    await recordAudit(
      {
        actorUserId: ctx.user.id,
        actorRole: role,
        action: "CONFLICT_OVERRIDDEN",
        entityType: "MONTHLY_ROSTER",
        entityId: roster.rosterId,
        description: `[PUBLISHED_MONTH_OVERRIDE] ${reason}`,
        institutionId: roster.institutionId,
        hospitalId: roster.hospitalId,
        metadata: {
          yearMonth: roster.yearMonth,
          previousStatus: roster.status,
          professionalId: membership.professionalId,
        },
      },
      { db: tx, strict: true },
    );
  }
}

export async function assertMonthEditableForUpdate(
  tx: MonthLockDb,
  ctx: { user: { id: number } },
  institutionId: number,
  hospitalId: number,
  date: Date,
  reason?: string,
  options?: { kind?: MonthEditKind },
): Promise<void> {
  await assertMonthsEditableForUpdate(
    tx,
    ctx,
    [{ institutionId, hospitalId, date, reason }],
    options,
  );
}

/**
 * Destinatários da publicação limitados ao par instituição/hospital.
 * A consulta permanece separada para que a defesa em profundidade tenha um
 * teste de regressão próprio, mesmo que uma futura chamada contorne o router.
 */
export async function getRosterPublicationEmails(
  institutionId: number,
  hospitalId: number,
  yearMonth: string,
): Promise<string[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const recipients = await getRosterPublicationRecipients(
    db,
    institutionId,
    hospitalId,
    yearMonth,
  );
  return recipients
    .map((recipient) => recipient.email)
    .filter((email): email is string => Boolean(email));
}

async function getRosterPublicationRecipients(
  db: MonthReadDb,
  institutionId: number,
  hospitalId: number,
  yearMonth: string,
): Promise<{ userId: number; email: string | null }[]> {
  const start = new Date(`${yearMonth}-01T00:00:00-03:00`);
  const [yearText, monthText] = yearMonth.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = new Date(
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00-03:00`,
  );
  const rows = await db
    .select({ userId: users.id, email: users.email })
    .from(shiftInstances)
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
        eq(sectors.institutionId, shiftInstances.institutionId),
        eq(sectors.hospitalId, shiftInstances.hospitalId),
      ),
    )
    .innerJoin(
      shiftAssignmentsV2,
      and(
        eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id),
        eq(shiftAssignmentsV2.institutionId, shiftInstances.institutionId),
        eq(shiftAssignmentsV2.hospitalId, shiftInstances.hospitalId),
        eq(shiftAssignmentsV2.sectorId, shiftInstances.sectorId),
        eq(shiftAssignmentsV2.isActive, true),
      ),
    )
    .innerJoin(professionals, eq(professionals.id, shiftAssignmentsV2.professionalId))
    .innerJoin(
      professionalAccess,
      and(
        eq(professionalAccess.institutionId, shiftInstances.institutionId),
        eq(professionalAccess.professionalId, professionals.id),
        eq(professionalAccess.hospitalId, shiftInstances.hospitalId),
        eq(professionalAccess.canAccess, true),
        or(
          isNull(professionalAccess.sectorId),
          eq(professionalAccess.sectorId, shiftInstances.sectorId),
        ),
      ),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, shiftInstances.institutionId),
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
        eq(shiftInstances.institutionId, institutionId),
        eq(shiftInstances.hospitalId, hospitalId),
        eq(shiftAssignmentsV2.status, "OCUPADO"),
        gte(shiftInstances.startAt, start),
        lt(shiftInstances.startAt, end),
      ),
    );
  return [...new Map(rows.map((row) => [row.userId, row] as const)).values()];
}

type PublicationRoster = Readonly<{
  id: number;
  status: "DRAFT" | "PUBLISHED" | "LOCKED";
  version: number;
}>;

type ReadinessPublicationAudit = Readonly<{
  reportVersion: CorporateReadinessReportV1["version"];
  snapshotHash: string;
  issueCodes: readonly string[];
  operationalWarnings: ReturnType<typeof operationalWarningSnapshot>;
}>;

async function lockRosterForPublication(
  tx: MonthTransaction,
  institutionId: number,
  hospitalId: number,
  yearMonth: string,
): Promise<PublicationRoster | undefined> {
  const [existing] = await tx
    .select({
      id: monthlyRosters.id,
      status: monthlyRosters.status,
      version: monthlyRosters.version,
    })
    .from(monthlyRosters)
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonth),
      ),
    )
    .limit(1)
    .for("update");
  return existing;
}

function assertDraftRosterForPublication(
  existing: PublicationRoster,
  yearMonth: string,
): void {
  if (existing.status === "DRAFT") return;
  throw new Error(
    existing.status === "LOCKED"
      ? `A escala de ${yearMonth} já está bloqueada.`
      : `A escala de ${yearMonth} já foi publicada.`,
  );
}

/**
 * A rota legada ainda materializa o rascunho antes de validar a publicação.
 * No caminho com ciência, a criação só ocorre depois da fence: assim o
 * próprio INSERT não invalida a fotografia antes da decisão final.
 */
async function materializeDraftRosterAfterReadinessCheck(
  tx: MonthTransaction,
  institutionId: number,
  hospitalId: number,
  yearMonth: string,
): Promise<PublicationRoster> {
  await tx.insert(monthlyRosters).values({
    institutionId,
    hospitalId,
    yearMonth,
    status: "DRAFT",
  });
  const created = await lockRosterForPublication(
    tx,
    institutionId,
    hospitalId,
    yearMonth,
  );
  if (!created) throw new Error(`Mês ${yearMonth} não encontrado.`);
  assertDraftRosterForPublication(created, yearMonth);
  return created;
}

function assertReadinessAcknowledgementForPublication(
  report: CorporateReadinessReportV1,
  acknowledgement: CorporateReadinessAcknowledgement,
): ReadinessPublicationAudit {
  const assessment = assessCorporateReadinessAcknowledgement(
    report,
    acknowledgement,
  );
  switch (assessment.state) {
    case "SECURITY_BLOCKED":
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "A publicação foi bloqueada por uma inconsistência estrutural. Corrija a prontidão da escala antes de publicar.",
      });
    case "ACKNOWLEDGEMENT_REQUIRED":
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Revise e confirme as pendências operacionais da prontidão antes de publicar.",
      });
    case "SNAPSHOT_STALE":
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "O diagnóstico de prontidão mudou. Atualize a revisão e confirme novamente.",
      });
    case "ISSUE_CODES_MISMATCH":
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A confirmação não corresponde às pendências atuais. Atualize a revisão e confirme novamente.",
      });
    case "NOT_REQUIRED":
    case "ACKNOWLEDGED":
      return {
        reportVersion: report.version,
        snapshotHash: report.snapshotHash,
        issueCodes: assessment.operationalWarningCodes,
        operationalWarnings: operationalWarningSnapshot(report),
      };
  }
}

function readinessFencePublicationError(error: unknown): TRPCError | null {
  const code = error instanceof Error ? error.message : "";
  if (!code.startsWith("READINESS_FENCE_V1_")) return null;
  if (code === "READINESS_FENCE_V1_STALE") {
    return new TRPCError({
      code: "CONFLICT",
      message:
        "A configuração da escala mudou durante a publicação. Atualize a revisão e confirme novamente.",
    });
  }
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "A verificação transacional de prontidão não está disponível neste ambiente. A publicação com ciência foi mantida sem alterações.",
  });
}

async function completeRosterPublication(
  tx: MonthTransaction,
  input: Readonly<{
    roster: PublicationRoster;
    institutionId: number;
    hospitalId: number;
    yearMonth: string;
    actor: TenantActor;
    actorName?: string;
    currentRole: "GESTOR_MEDICO" | "GESTOR_PLUS";
    readiness?: ReadinessPublicationAudit;
  }>,
): Promise<void> {
  const [result] = await tx
    .update(monthlyRosters)
    .set({
      status: "PUBLISHED",
      publishedAt: new Date(),
      publishedByUserId: input.actor.userId,
      version: sql`${monthlyRosters.version} + 1`,
    })
    .where(
      and(
        eq(monthlyRosters.id, input.roster.id),
        eq(monthlyRosters.status, "DRAFT"),
        eq(monthlyRosters.version, input.roster.version),
      ),
    );
  if (!result.affectedRows) {
    throw new Error(
      `A escala de ${input.yearMonth} acabou de ser publicada por outra pessoa.`,
    );
  }
  await recordAudit(
    {
      actorUserId: input.actor.userId,
      actorRole: input.currentRole,
      actorName: input.actorName,
      action: "ROSTER_PUBLISHED",
      entityType: "MONTHLY_ROSTER",
      entityId: input.roster.id,
      description: `Escala publicada (${input.yearMonth})`,
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      metadata: {
        yearMonth: input.yearMonth,
        previousStatus: input.roster.status,
        ...(input.readiness ? { readiness: input.readiness } : {}),
      },
    },
    { db: tx, strict: true },
  );
  const publishedVersion = input.roster.version + 1;
  const recipients = await getRosterPublicationRecipients(
    tx,
    input.institutionId,
    input.hospitalId,
    input.yearMonth,
  );
  for (const recipient of recipients) {
    await enqueueComunicaRosterPublished({
      rosterId: input.roster.id,
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      yearMonth: input.yearMonth,
      publishedVersion,
      targetUserId: recipient.userId,
      targetEmail: recipient.email,
      db: tx,
    });
  }
}

async function publishMonthWithReadinessAcknowledgement(
  input: Readonly<{
    institutionId: number;
    hospitalId: number;
    yearMonth: string;
    monthDate: Date;
    actor: TenantActor;
    expectedActorSessionVersion: number;
    actorName?: string;
    acknowledgement: CorporateReadinessAcknowledgement;
  }>,
): Promise<void> {
  try {
    const highWatermark = await captureInstitutionReadinessFenceV1HighWatermark(
      input.institutionId,
    );
    await withReadinessFenceV1FinalDecisionTransaction(
      highWatermark,
      async (tx) => {
        // A leitura FOR UPDATE da chave única também segura o gap quando o
        // mês ainda não foi materializado. Nenhuma escrita ocorre antes da
        // fence, para não invalidar o próprio snapshot.
        const roster = await lockRosterForPublication(
          tx,
          input.institutionId,
          input.hospitalId,
          input.yearMonth,
        );
        if (roster) assertDraftRosterForPublication(roster, input.yearMonth);
        await assertInstitutionHierarchy(
          {
            institutionId: input.institutionId,
            hospitalId: input.hospitalId,
          },
          { db: tx, lockForShare: true },
        );
        const currentRole = await assertManagerScopeAccessForUpdate(
          tx,
          input.actor,
          input.expectedActorSessionVersion,
          input.hospitalId,
          undefined,
          [input.monthDate],
        );
        return { roster, currentRole };
      },
      async (tx, prepared) => {
        const report = await getCorporateReadinessReport(tx, {
          institutionId: input.institutionId,
          hospitalId: input.hospitalId,
          yearMonth: input.yearMonth,
        });
        const readiness = assertReadinessAcknowledgementForPublication(
          report,
          input.acknowledgement,
        );
        const roster =
          prepared.roster ??
          (await materializeDraftRosterAfterReadinessCheck(
            tx,
            input.institutionId,
            input.hospitalId,
            input.yearMonth,
          ));
        await completeRosterPublication(tx, {
          roster,
          institutionId: input.institutionId,
          hospitalId: input.hospitalId,
          yearMonth: input.yearMonth,
          actor: input.actor,
          actorName: input.actorName,
          currentRole: prepared.currentRole,
          readiness,
        });
      },
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const readinessError = readinessFencePublicationError(error);
    if (readinessError) throw readinessError;
    throw error;
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
  actor: TenantActor,
  expectedActorSessionVersion: number,
  actorName?: string,
  readinessAcknowledgement?: CorporateReadinessAcknowledgement,
): Promise<void> {
  const monthDate = dateInsideYearMonth(yearMonth);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (actor.institutionId !== institutionId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Instituição divergente do contexto autorizado",
    });
  }
  await assertInstitutionHierarchy({ institutionId, hospitalId }, { db });

  if (readinessAcknowledgement) {
    await publishMonthWithReadinessAcknowledgement({
      institutionId,
      hospitalId,
      yearMonth,
      monthDate,
      actor,
      expectedActorSessionVersion,
      actorName,
      acknowledgement: readinessAcknowledgement,
    });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(monthlyRosters)
      .values({ institutionId, hospitalId, yearMonth, status: "DRAFT" })
      .onDuplicateKeyUpdate({ set: { id: sql`${monthlyRosters.id}` } });
    const existing = await lockRosterForPublication(
      tx,
      institutionId,
      hospitalId,
      yearMonth,
    );
    if (!existing) throw new Error(`Mês ${yearMonth} não encontrado.`);
    assertDraftRosterForPublication(existing, yearMonth);
    const currentRole = await assertManagerScopeAccessForUpdate(
      tx,
      actor,
      expectedActorSessionVersion,
      hospitalId,
      undefined,
      [monthDate],
    );

    await completeRosterPublication(tx, {
      roster: existing,
      institutionId,
      hospitalId,
      yearMonth,
      actor,
      actorName,
      currentRole,
    });
  });
}

/**
 * Tranca um mês PUBLISHED → LOCKED.
 * Preenche locked_at, locked_by_user_id e incrementa version.
 * Jurisdição: Gestor+ ou admin global, ou GESTOR_MEDICO com scope hospitalar.
 * Um scope setorial não pode trancar a competência de todos os setores.
 */
export async function lockMonth(
  institutionId: number,
  hospitalId: number,
  yearMonth: string,
  actor: TenantActor,
  expectedActorSessionVersion: number,
  actorName?: string,
): Promise<void> {
  const monthDate = dateInsideYearMonth(yearMonth);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (actor.institutionId !== institutionId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Instituição divergente do contexto autorizado",
    });
  }
  await assertInstitutionHierarchy({ institutionId, hospitalId }, { db });

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: monthlyRosters.id, status: monthlyRosters.status, version: monthlyRosters.version })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, yearMonth),
        ),
      )
      .limit(1)
      .for("update");
    if (!existing || existing.status !== "PUBLISHED") {
      throw new Error("Mês não encontrado ou não está PUBLISHED");
    }
    const currentRole = await assertManagerScopeAccessForUpdate(
      tx,
      actor,
      expectedActorSessionVersion,
      hospitalId,
      undefined,
      [monthDate],
    );
    const [result] = await tx
      .update(monthlyRosters)
      .set({
        status: "LOCKED",
        lockedAt: new Date(),
        lockedByUserId: actor.userId,
        version: sql`${monthlyRosters.version} + 1`,
      })
      .where(
        and(
          eq(monthlyRosters.id, existing.id),
          eq(monthlyRosters.status, "PUBLISHED"),
          eq(monthlyRosters.version, existing.version),
        ),
      );
    if (!result.affectedRows) {
      throw new Error("Mês não encontrado ou não está PUBLISHED");
    }
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorRole: currentRole,
        actorName,
        action: "ROSTER_LOCKED",
        entityType: "MONTHLY_ROSTER",
        entityId: existing.id,
        description: `Escala trancada (${yearMonth})`,
        institutionId,
        hospitalId,
        metadata: { yearMonth, previousStatus: existing.status },
      },
      { db: tx, strict: true },
    );
  });
}
