/**
 * Projeção UX de destinatários para oferta DIRECIONADA de cessão/repasse
 * (CESSAO / TRANSFER, a UI chama de REPASSE).
 *
 * Não é autoridade de escrita. A autoridade continua em `createSwapOffer()`
 * via `requireProfessionalCanReceiveShift`. Esta lista existe para o cliente
 * não oferecer um B que a escrita já rejeitaria, nem esconder um B elegível.
 *
 * SWAP não é servido: o destinatário canônico é o ocupante do plantão de
 * contrapartida (`toShiftInstanceId`). Não generalizar este read model.
 *
 * Elegibilidade estrutural (espelha a autoridade clínica da #407):
 * membership ativa, conta APPROVED, não deletada, não o ofertante,
 * `professional_access` válido no tenant/hospital/setor do plantão,
 * `qualificationMatches` no schedule_context.
 *
 * Papel institucional e escopo gerencial não entram. Conflito temporal
 * não entra — não há helper reutilizável sem duplicar o algoritmo de
 * listAvailable/accept; a escrita revalida.
 *
 * candidate list = structural eligibility
 * createSwapOffer = final eligibility
 */
import { sql, type SQLWrapper } from "drizzle-orm";
import { rowsFromExecute } from "./_core/db-results";
import {
  plantonistaAccessCoversShiftSql,
  plantonistaQualificationMatchesContextSql,
} from "./plantonista-shift-eligibility";

type EligibilityDb = {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
};

export const ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT = 200;

export type EligibleOfferRecipient = {
  professionalId: number;
  displayName: string;
  qualification?: string | null;
};

export class EligibleOfferRecipientLimitExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(
      `Não foi possível listar os destinatários: há mais de ${limit} profissionais elegíveis para este plantão.`,
    );
    this.name = "EligibleOfferRecipientLimitExceededError";
    this.limit = limit;
  }
}

type RecipientRow = {
  professionalId: number | string;
  displayName: string | null;
  specialty: string | null;
};

function compareRecipientName(left: string, right: string): number {
  return left.localeCompare(right, "pt-BR", {
    sensitivity: "base",
    numeric: true,
  });
}

function projectRecipients(rows: RecipientRow[]): EligibleOfferRecipient[] {
  const projected: {
    professionalId: number;
    displayName: string;
    specialty: string | null;
  }[] = [];
  for (const row of rows) {
    const professionalId = Number(row.professionalId);
    if (!Number.isSafeInteger(professionalId) || professionalId <= 0) continue;
    const displayName = String(row.displayName ?? "").trim();
    if (!displayName) continue;
    projected.push({
      professionalId,
      displayName,
      specialty: row.specialty,
    });
  }

  projected.sort(
    (left, right) =>
      compareRecipientName(left.displayName, right.displayName) ||
      left.professionalId - right.professionalId,
  );

  const nameCounts = new Map<string, number>();
  for (const row of projected) {
    const key = row.displayName.trim().toLocaleLowerCase("pt-BR");
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const needsQualification = [...nameCounts.values()].some((count) => count > 1);

  return projected.map((row) =>
    needsQualification
      ? {
          professionalId: row.professionalId,
          displayName: row.displayName,
          qualification: row.specialty,
        }
      : {
          professionalId: row.professionalId,
          displayName: row.displayName,
        },
  );
}

export async function listClinicallyEligibleOfferRecipients(
  db: EligibilityDb,
  input: {
    shiftId: number;
    institutionId: number;
    excludeProfessionalId: number;
    excludeUserId: number;
  },
): Promise<EligibleOfferRecipient[]> {
  const limitPlusOne = ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT + 1;
  const result = await db.execute(sql`
    SELECT
      ap.id AS professionalId,
      ap.name AS displayName,
      ap.specialty AS specialty
    FROM shift_instances si
    JOIN institutions inst
      ON inst.id = si.institution_id
     AND inst.is_active = 1
    JOIN schedule_contexts sc
      ON sc.id = si.schedule_context_id
     AND sc.institution_id = si.institution_id
     AND sc.hospital_id = si.hospital_id
     AND sc.sector_id = si.sector_id
     AND sc.active = 1
    JOIN professional_institutions api
      ON api.institution_id = si.institution_id
     AND api.active = 1
    JOIN professionals ap
      ON ap.id = api.professional_id
     AND ap.user_id = api.user_id
    JOIN users au
      ON au.id = ap.user_id
     AND au.approval_status = 'APPROVED'
     AND au.deleted_at IS NULL
    WHERE si.id = ${input.shiftId}
      AND si.institution_id = ${input.institutionId}
      AND ap.id != ${input.excludeProfessionalId}
      AND au.id != ${input.excludeUserId}
      AND ${plantonistaAccessCoversShiftSql("ap", "si", "sc")}
      AND ${plantonistaQualificationMatchesContextSql("ap", "sc")}
    ${sql.raw("ORDER BY ap.name COLLATE utf8mb4_unicode_ci ASC, ap.id ASC")}
    LIMIT ${limitPlusOne}
  `);

  const rows = rowsFromExecute<RecipientRow>(result);
  if (rows.length > ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT) {
    throw new EligibleOfferRecipientLimitExceededError(
      ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT,
    );
  }
  return projectRecipients(rows);
}
