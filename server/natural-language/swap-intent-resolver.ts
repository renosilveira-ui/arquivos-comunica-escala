// server/natural-language/swap-intent-resolver.ts — slots → entidades reais.
//
// Camada 2 de duas. É a ÚNICA que fala com o banco, e fala sempre escopada
// ao ator autenticado e ao tenant: nem usuário nem instituição vêm da
// frase. Ambiguidade é fail-closed — zero é "não encontrei", mais de um é
// "qual deles?", e nunca se escolhe o primeiro resultado.
//
// Este módulo NÃO é uma segunda camada de eligibility/compliance. Ele
// localiza a entidade canônica e garante só a topologia/ownership que a
// identificação exige (alocação ativa e OCUPADO, plantão não iniciado,
// tupla turno/tenant/setor íntegra). Qualificação, `professional_access`,
// allowlist #317, regras operacionais finais e estado stale seguem sendo
// autoridade exclusiva de `createSwapOffer`.
//
// Consequência aceita de propósito: o resolver PODE localizar um colega
// inelegível para aquele setor, e a recusa vem do domínio. Não pré-filtrar
// acesso aqui — duplicar a política criaria drift com #317.

import { and, asc, eq, gt, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import { getDb } from "../db";
import { dayKeyBrt, dayWindowBrt, weekdayOfKey } from "../local-time";
import { formatHospitalTimeRange } from "../../lib/hospital-time";
import {
  institutions,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../../drizzle/schema";
import {
  formatDayKeyShort,
  periodOfStart,
  PERIOD_LABEL,
  resolveDateExpression,
  WEEKDAY_LABEL,
} from "./swap-intent-date";
import {
  bestMatches,
  professionalMatchTier,
  sectorMatchTier,
} from "./swap-intent-text";
import {
  swapIntentError,
  type DateExpression,
  type ResolvedShiftRef,
  type ResolvedSwapIntent,
  type ShiftCandidate,
  type ShiftPeriod,
  type ShiftSlot,
  type SwapIntentDraft,
  type SwapIntentError,
} from "./swap-intent-types";

/** Identidade canônica do canal. Nunca montada a partir do texto. */
export type SwapIntentActor = {
  userId: number;
  professionalId: number;
  /**
   * Instituições que o canal autoriza. A voz passa a instituição ativa da
   * sessão; um canal futuro pode passar todos os vínculos. O resolver
   * sempre intersecta com os vínculos ativos reais — fail-closed.
   */
  institutionIds: number[];
};

export type ResolveSwapIntentOptions = {
  now?: Date;
  /** Escolhas explícitas do usuário depois de uma pergunta de desambiguação. */
  chosenOwnShiftInstanceId?: number;
  chosenTargetProfessionalId?: number;
  chosenTargetShiftInstanceId?: number;
};

/**
 * Teto de varredura de colegas por instituição. O casamento de nome é em
 * memória (tiers + fuzzy de 1 edição), então o conjunto precisa ser
 * limitado: uma instituição do piloto tem dezenas de profissionais, e
 * mesmo uma ordem de grandeza acima cabe aqui sem risco. Se algum tenant
 * passar disso, a resolução por nome precisa virar busca no banco.
 */
const PROFESSIONAL_SCAN_LIMIT = 500;

/** Teto de plantões lidos por dia/profissional. Um dia real tem poucos. */
const SHIFT_SCAN_LIMIT = 50;

/** Candidatos devolvidos ao canal para a pergunta de desambiguação. */
const CANDIDATE_LIMIT = 5;

type ShiftRow = {
  assignmentId: number;
  shiftInstanceId: number;
  institutionId: number;
  institutionName: string;
  sectorId: number;
  sectorName: string;
  label: string;
  startAt: Date;
  endAt: Date;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const shiftRowFields = {
  assignmentId: shiftAssignmentsV2.id,
  shiftInstanceId: shiftInstances.id,
  institutionId: shiftInstances.institutionId,
  institutionName: institutions.name,
  sectorId: shiftInstances.sectorId,
  sectorName: sectors.name,
  label: shiftInstances.label,
  startAt: shiftInstances.startAt,
  endAt: shiftInstances.endAt,
};

/**
 * Base das leituras de plantão. Os JOINs repetem institution/hospital/sector
 * de propósito: é a mesma integridade de tupla que o domínio exige, então
 * uma linha com topologia inconsistente simplesmente não aparece aqui.
 */
function shiftQuery(db: Db) {
  return db
    .select(shiftRowFields)
    .from(shiftAssignmentsV2)
    .innerJoin(
      shiftInstances,
      and(
        eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id),
        eq(shiftAssignmentsV2.institutionId, shiftInstances.institutionId),
        eq(shiftAssignmentsV2.hospitalId, shiftInstances.hospitalId),
        eq(shiftAssignmentsV2.sectorId, shiftInstances.sectorId),
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
      institutions,
      and(
        eq(institutions.id, shiftInstances.institutionId),
        eq(institutions.isActive, true),
      ),
    );
}

/** Alocação viva: ativa, OCUPADO e no escopo de instituições permitido. */
function activeAssignmentOf(professionalId: number, institutionIds: number[]) {
  return and(
    eq(shiftAssignmentsV2.professionalId, professionalId),
    eq(shiftAssignmentsV2.isActive, true),
    eq(shiftAssignmentsV2.status, "OCUPADO"),
    inArray(shiftInstances.institutionId, institutionIds),
  );
}

function toShiftCandidate(row: ShiftRow): ShiftCandidate {
  return {
    shiftInstanceId: row.shiftInstanceId,
    assignmentId: row.assignmentId,
    institutionId: row.institutionId,
    institutionName: row.institutionName,
    sectorId: row.sectorId,
    sectorName: row.sectorName,
    label: row.label,
    dayKey: dayKeyBrt(row.startAt),
    timeRange: formatHospitalTimeRange(row.startAt, row.endAt),
  };
}

function toResolvedShiftRef(row: ShiftRow): ResolvedShiftRef {
  return {
    shiftInstanceId: row.shiftInstanceId,
    assignmentId: row.assignmentId,
    sectorId: row.sectorId,
    sectorName: row.sectorName,
    label: row.label,
    dayKey: dayKeyBrt(row.startAt),
    timeRange: formatHospitalTimeRange(row.startAt, row.endAt),
    startAt: row.startAt,
  };
}

/** "amanhã", "na quarta, 09/09" — como a pessoa vai reconhecer o dia. */
function whenSaidFor(expression: DateExpression, dayKey: string): string {
  if (expression.kind === "NEXT_SHIFT") return "no seu próximo plantão";
  if (expression.kind === "OFFSET") {
    if (expression.days === 0) return "hoje";
    if (expression.days === 1) return "amanhã";
    if (expression.days === 2) return "depois de amanhã";
  }
  if (expression.kind === "WEEKDAY") {
    return `na ${WEEKDAY_LABEL[weekdayOfKey(dayKey)]}, ${formatDayKeyShort(dayKey)}`;
  }
  return `em ${formatDayKeyShort(dayKey)}`;
}

function describeShifts(rows: readonly ShiftRow[]): string {
  return rows.map((row) => row.label).join(", ");
}

/** Instituições em que o ator realmente tem vínculo ativo, dentro do escopo. */
async function resolveInstitutionScope(
  db: Db,
  actor: SwapIntentActor,
): Promise<number[]> {
  if (actor.institutionIds.length === 0) return [];
  const rows = await db
    .select({ institutionId: professionalInstitutions.institutionId })
    .from(professionalInstitutions)
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, professionalInstitutions.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.professionalId, actor.professionalId),
        eq(professionalInstitutions.userId, actor.userId),
        eq(professionalInstitutions.active, true),
        inArray(professionalInstitutions.institutionId, actor.institutionIds),
      ),
    );
  return [...new Set(rows.map((row) => row.institutionId))];
}

type SectorFilterResult =
  | { ok: true; rows: ShiftRow[] }
  | { ok: false; error: SwapIntentError };

/**
 * Filtra plantões pelo setor dito. O schema de `sectors` não tem coluna de
 * sigla, então o casamento é textual em camadas; empate entre setores
 * distintos é ambiguidade, jamais escolha arbitrária.
 */
async function filterBySector(
  db: Db,
  rows: ShiftRow[],
  sectorText: string,
  institutionIds: number[],
  whenSaid: string,
): Promise<SectorFilterResult> {
  const { tier, matches } = bestMatches(rows, (row) =>
    sectorMatchTier(sectorText, row.sectorName),
  );
  if (tier === null) {
    // O setor existe no tenant mas não tem plantão seu, ou nem existe?
    // São perguntas diferentes para a pessoa.
    const known = await db
      .select({ sectorId: sectors.id, name: sectors.name })
      .from(sectors)
      .where(inArray(sectors.institutionId, institutionIds));
    const knownMatch = bestMatches(known, (sector) =>
      sectorMatchTier(sectorText, sector.name),
    );
    if (knownMatch.tier === null) {
      return {
        ok: false,
        error: swapIntentError(
          "SECTOR_NOT_FOUND",
          `Não encontrei o setor "${sectorText}" nesta escala.`,
        ),
      };
    }
    return {
      ok: false,
      error: swapIntentError(
        "OWN_SHIFT_NOT_FOUND",
        `Você não tem plantão ${whenSaid} em ${knownMatch.matches[0].name}.`,
        {
          sectorCandidates: knownMatch.matches
            .slice(0, CANDIDATE_LIMIT)
            .map((sector) => ({ sectorId: sector.sectorId, name: sector.name })),
        },
      ),
    };
  }
  const distinctSectors = new Map(matches.map((row) => [row.sectorId, row.sectorName]));
  if (distinctSectors.size > 1) {
    return {
      ok: false,
      error: swapIntentError(
        "AMBIGUOUS_SECTOR",
        `"${sectorText}" corresponde a mais de um setor. Qual deles?`,
        {
          sectorCandidates: [...distinctSectors]
            .slice(0, CANDIDATE_LIMIT)
            .map(([sectorId, name]) => ({ sectorId, name })),
        },
      ),
    };
  }
  return { ok: true, rows: matches };
}

type ShiftPick =
  | { ok: true; row: ShiftRow }
  | { ok: false; error: SwapIntentError };

/**
 * Aplica dia, turno e setor a um conjunto de plantões e exige exatamente um.
 * `owner` muda apenas a redação — a lógica de fail-closed é a mesma.
 */
async function pickSingleShift(
  db: Db,
  input: {
    rows: ShiftRow[];
    slot: ShiftSlot;
    whenSaid: string;
    now: Date;
    institutionIds: number[];
    owner: "OWN" | "TARGET";
    targetName?: string;
    chosenShiftInstanceId?: number;
  },
): Promise<ShiftPick> {
  const { rows, slot, whenSaid, now, owner } = input;
  const who = owner === "OWN" ? "Você" : input.targetName ?? "O colega";
  const notFound = owner === "OWN" ? "OWN_SHIFT_NOT_FOUND" : "TARGET_SHIFT_NOT_FOUND";
  const ambiguous = owner === "OWN" ? "AMBIGUOUS_OWN_SHIFT" : "AMBIGUOUS_TARGET_SHIFT";

  if (rows.length === 0) {
    return {
      ok: false,
      error: swapIntentError(notFound, `${who} não tem plantão ${whenSaid}.`),
    };
  }

  // Plantão iniciado não é trocável nem cedível — o domínio também barra.
  const future = rows.filter((row) => row.startAt.getTime() > now.getTime());
  if (future.length === 0) {
    return {
      ok: false,
      error: swapIntentError(
        notFound,
        owner === "OWN"
          ? `Seu plantão ${whenSaid} já começou — só é possível trocar ou ceder plantões futuros.`
          : `O plantão de ${who} ${whenSaid} já começou.`,
      ),
    };
  }

  let current = future;
  if (slot.period) {
    const byPeriod = current.filter((row) => periodOfStart(row.startAt) === slot.period);
    if (byPeriod.length === 0) {
      return {
        ok: false,
        error: swapIntentError(
          notFound,
          `${who} não tem plantão no turno da ${PERIOD_LABEL[slot.period as ShiftPeriod]} ${whenSaid} (plantão nesse dia: ${describeShifts(current)}).`,
        ),
      };
    }
    current = byPeriod;
  }

  if (slot.sectorText) {
    const filtered = await filterBySector(
      db,
      current,
      slot.sectorText,
      input.institutionIds,
      whenSaid,
    );
    if (!filtered.ok) return { ok: false, error: filtered.error };
    current = filtered.rows;
  }

  if (input.chosenShiftInstanceId !== undefined) {
    const chosen = current.find(
      (row) => row.shiftInstanceId === input.chosenShiftInstanceId,
    );
    if (!chosen) {
      return {
        ok: false,
        error: swapIntentError(notFound, "O plantão escolhido não está mais disponível."),
      };
    }
    return { ok: true, row: chosen };
  }

  // Instituição vem do plantão (§15), então candidatos em instituições
  // diferentes são ambiguidade — não se elege a "instituição ativa".
  const distinctInstitutions = new Set(current.map((row) => row.institutionId));
  if (current.length > 1) {
    const hint =
      distinctInstitutions.size > 1
        ? "Você tem plantão nesse período em mais de uma instituição. Qual deles?"
        : owner === "OWN"
          ? `Você tem ${current.length} plantões ${whenSaid}. Qual deles?`
          : `${who} tem mais de um plantão nesse período. Qual deles?`;
    return {
      ok: false,
      error: swapIntentError(ambiguous, hint, {
        shiftCandidates: current.slice(0, CANDIDATE_LIMIT).map(toShiftCandidate),
      }),
    };
  }
  return { ok: true, row: current[0] };
}

/**
 * Plantões vivos de um profissional no dia dito (ou o próximo, para
 * "meu próximo plantão"). Serve tanto para o plantão próprio quanto para a
 * contrapartida — a diferença é só qual professionalId entra.
 */
async function loadShiftRows(
  db: Db,
  professionalId: number,
  institutionIds: number[],
  expression: DateExpression,
  now: Date,
): Promise<{ rows: ShiftRow[]; whenSaid: string } | { error: SwapIntentError }> {
  const mine = activeAssignmentOf(professionalId, institutionIds);

  if (expression.kind === "NEXT_SHIFT") {
    const rows = await shiftQuery(db)
      .where(and(mine, gt(shiftInstances.startAt, now)))
      .orderBy(asc(shiftInstances.startAt))
      .limit(1);
    return { rows, whenSaid: "no seu próximo plantão" };
  }

  const resolved = resolveDateExpression(expression, now);
  if (!resolved.ok) {
    return { error: swapIntentError("INVALID_DATE", resolved.message) };
  }
  const window = dayWindowBrt(resolved.dayKey);
  const rows = await shiftQuery(db)
    .where(
      and(
        mine,
        gte(shiftInstances.startAt, window.start),
        lt(shiftInstances.startAt, window.end),
      ),
    )
    .orderBy(asc(shiftInstances.startAt))
    .limit(SHIFT_SCAN_LIMIT);
  return { rows, whenSaid: whenSaidFor(expression, resolved.dayKey) };
}

type TargetProfessional = { professionalId: number; userId: number; name: string };

async function resolveTargetProfessional(
  db: Db,
  actor: SwapIntentActor,
  institutionId: number,
  name: string,
  chosenProfessionalId?: number,
): Promise<{ ok: true; target: TargetProfessional } | { ok: false; error: SwapIntentError }> {
  const colleagues = await db
    .select({
      professionalId: professionals.id,
      userId: professionals.userId,
      name: professionals.name,
    })
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, institutionId),
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
    .where(ne(professionals.userId, actor.userId))
    .limit(PROFESSIONAL_SCAN_LIMIT);

  if (chosenProfessionalId !== undefined) {
    const chosen = colleagues.find(
      (colleague) => colleague.professionalId === chosenProfessionalId,
    );
    if (!chosen) {
      return {
        ok: false,
        error: swapIntentError(
          "TARGET_PROFESSIONAL_NOT_FOUND",
          "O profissional escolhido não está disponível nesta escala.",
        ),
      };
    }
    return { ok: true, target: chosen };
  }

  const { tier, matches } = bestMatches(colleagues, (colleague) =>
    professionalMatchTier(name, colleague.name),
  );
  if (tier === null) {
    return {
      ok: false,
      error: swapIntentError(
        "TARGET_PROFESSIONAL_NOT_FOUND",
        `Não encontrei "${name}" entre os profissionais desta escala.`,
      ),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: swapIntentError(
        "AMBIGUOUS_TARGET_PROFESSIONAL",
        `Encontrei mais de um "${name}" nesta escala. Qual deles?`,
        {
          professionalCandidates: matches.slice(0, CANDIDATE_LIMIT).map((colleague) => ({
            professionalId: colleague.professionalId,
            name: colleague.name,
          })),
        },
      ),
    };
  }
  return { ok: true, target: matches[0] };
}

/**
 * Slots + ator → entidades canônicas do Escala+, ou uma pergunta.
 * Não cria, não altera e não notifica nada: só localiza.
 */
export async function resolveSwapIntent(
  draft: SwapIntentDraft,
  actor: SwapIntentActor,
  options: ResolveSwapIntentOptions = {},
): Promise<ResolvedSwapIntent | SwapIntentError> {
  const db = await getDb();
  if (!db) {
    return swapIntentError("CONFLICT", "Banco de dados indisponível.");
  }
  const now = options.now ?? new Date();

  const institutionIds = await resolveInstitutionScope(db, actor);
  if (institutionIds.length === 0) {
    return swapIntentError(
      "NOT_ELIGIBLE",
      "Você não tem vínculo ativo na instituição desta solicitação.",
    );
  }

  const own = await loadShiftRows(
    db,
    actor.professionalId,
    institutionIds,
    draft.ownShift.date,
    now,
  );
  if ("error" in own) return own.error;

  const ownPick = await pickSingleShift(db, {
    rows: own.rows,
    slot: draft.ownShift,
    whenSaid: own.whenSaid,
    now,
    institutionIds,
    owner: "OWN",
    chosenShiftInstanceId: options.chosenOwnShiftInstanceId,
  });
  if (!ownPick.ok) return ownPick.error;
  const ownRow = ownPick.row;

  // Daqui para frente tudo é escopado pela instituição do plantão próprio.
  const institutionId = ownRow.institutionId;

  const target = await resolveTargetProfessional(
    db,
    actor,
    institutionId,
    draft.targetProfessional.name,
    options.chosenTargetProfessionalId,
  );
  if (!target.ok) return target.error;

  const base = {
    ok: true as const,
    actorUserId: actor.userId,
    actorProfessionalId: actor.professionalId,
    institutionId,
    institutionName: ownRow.institutionName,
    ownShift: toResolvedShiftRef(ownRow),
    targetProfessional: target.target,
  };

  if (draft.kind === "CESSAO") {
    return { ...base, kind: "CESSAO", targetShift: null };
  }

  const firstName = target.target.name.split(" ")[0];

  // Informação ausente ≠ alvo inexistente: sem data dita, a contrapartida
  // não foi nomeada. Nunca escolher um plantão que a pessoa não pediu.
  if (!draft.targetShift.date && options.chosenTargetShiftInstanceId === undefined) {
    const upcoming = await shiftQuery(db)
      .where(
        and(
          activeAssignmentOf(target.target.professionalId, [institutionId]),
          gt(shiftInstances.startAt, now),
          ne(shiftInstances.id, ownRow.shiftInstanceId),
        ),
      )
      .orderBy(asc(shiftInstances.startAt))
      .limit(CANDIDATE_LIMIT);
    return swapIntentError(
      "SWAP_TARGET_SHIFT_REQUIRED",
      `Qual plantão de ${firstName} você quer em troca?`,
      { shiftCandidates: upcoming.map(toShiftCandidate) },
    );
  }

  let targetRows: ShiftRow[];
  let targetWhenSaid: string;
  if (draft.targetShift.date) {
    const loaded = await loadShiftRows(
      db,
      target.target.professionalId,
      [institutionId],
      draft.targetShift.date,
      now,
    );
    if ("error" in loaded) return loaded.error;
    targetRows = loaded.rows;
    targetWhenSaid = loaded.whenSaid;
  } else {
    targetRows = await shiftQuery(db)
      .where(
        and(
          activeAssignmentOf(target.target.professionalId, [institutionId]),
          gt(shiftInstances.startAt, now),
        ),
      )
      .orderBy(asc(shiftInstances.startAt))
      .limit(SHIFT_SCAN_LIMIT);
    targetWhenSaid = "nesse período";
  }

  const targetPick = await pickSingleShift(db, {
    rows: targetRows.filter((row) => row.shiftInstanceId !== ownRow.shiftInstanceId),
    slot: draft.targetShift,
    whenSaid: targetWhenSaid,
    now,
    institutionIds: [institutionId],
    owner: "TARGET",
    targetName: firstName,
    chosenShiftInstanceId: options.chosenTargetShiftInstanceId,
  });
  if (!targetPick.ok) return targetPick.error;

  return { ...base, kind: "SWAP", targetShift: toResolvedShiftRef(targetPick.row) };
}
