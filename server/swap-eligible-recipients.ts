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
 *
 * Desambiguação humana (P1):
 * Inventário: não há CRM, conselho, UF, CPF nem outro identificador
 * profissional público no cadastro. Qualificação canônica =
 * medical_specialties.name OU rótulo de operational_profile_code.
 * `professionals.specialty` é rótulo legado, não autoridade.
 * Homônimos com a mesma qualificação canônica não são selecionáveis —
 * entram em unresolvedHomonymGroups. professionalId nunca é label.
 *
 * qualification no destinatário só é enviada quando o grupo de nome
 * exige desambiguação e aquele indivíduo é distinguível.
 */
import { sql, type SQLWrapper } from "drizzle-orm";
import {
  getOperationalProfileByCode,
  isOperationalProfileCode,
} from "../lib/medical-specialties";
import { rowsFromExecute } from "./_core/db-results";
import {
  plantonistaAccessCoversShiftSql,
  plantonistaQualificationMatchesContextSql,
} from "./plantonista-shift-eligibility";

type EligibilityDb = {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
};

export const ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT = 200;

export const UNRESOLVED_HOMONYM_CODE = "UNRESOLVED_HOMONYM" as const;

export const UNRESOLVED_HOMONYM_REASON =
  "Há mais de um profissional com este nome e a mesma qualificação. Não é possível direcionar a oferta com segurança.";

export type EligibleOfferRecipient = {
  professionalId: number;
  displayName: string;
  qualification?: string;
};

export type UnresolvedOfferHomonymGroup = {
  code: typeof UNRESOLVED_HOMONYM_CODE;
  displayName: string;
  qualification: string | null;
  count: number;
  reason: string;
};

export type EligibleOfferRecipientList = {
  recipients: EligibleOfferRecipient[];
  unresolvedHomonymGroups: UnresolvedOfferHomonymGroup[];
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
  medicalSpecialtyName: string | null;
  operationalProfileCode: string | null;
};

type ProjectedRecipient = {
  professionalId: number;
  displayName: string;
  qualification: string | null;
};

export function normalizeRecipientIdentityText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function compareRecipientName(left: string, right: string): number {
  return left.localeCompare(right, "pt-BR", {
    sensitivity: "base",
    numeric: true,
  });
}

function canonicalQualificationLabel(row: {
  medicalSpecialtyName: string | null;
  operationalProfileCode: string | null;
}): string | null {
  const specialtyName = String(row.medicalSpecialtyName ?? "").trim();
  if (specialtyName) return specialtyName;
  const profileCode = row.operationalProfileCode;
  if (profileCode && isOperationalProfileCode(profileCode)) {
    return getOperationalProfileByCode(profileCode)?.name ?? null;
  }
  return null;
}

export function projectEligibleOfferRecipients(
  rows: RecipientRow[],
): EligibleOfferRecipientList {
  const projected: ProjectedRecipient[] = [];
  for (const row of rows) {
    const professionalId = Number(row.professionalId);
    if (!Number.isSafeInteger(professionalId) || professionalId <= 0) continue;
    const displayName = String(row.displayName ?? "").trim();
    if (!displayName) continue;
    projected.push({
      professionalId,
      displayName,
      qualification: canonicalQualificationLabel(row),
    });
  }

  projected.sort(
    (left, right) =>
      compareRecipientName(left.displayName, right.displayName) ||
      compareRecipientName(
        left.qualification ?? "",
        right.qualification ?? "",
      ) ||
      left.professionalId - right.professionalId,
  );

  const byName = new Map<string, ProjectedRecipient[]>();
  for (const row of projected) {
    const key = normalizeRecipientIdentityText(row.displayName);
    const group = byName.get(key);
    if (group) group.push(row);
    else byName.set(key, [row]);
  }

  const recipients: EligibleOfferRecipient[] = [];
  const unresolvedHomonymGroups: UnresolvedOfferHomonymGroup[] = [];

  for (const nameGroup of byName.values()) {
    if (nameGroup.length === 1) {
      const only = nameGroup[0]!;
      recipients.push({
        professionalId: only.professionalId,
        displayName: only.displayName,
      });
      continue;
    }

    const byQualification = new Map<string, ProjectedRecipient[]>();
    for (const row of nameGroup) {
      const key = normalizeRecipientIdentityText(row.qualification ?? "");
      const group = byQualification.get(key);
      if (group) group.push(row);
      else byQualification.set(key, [row]);
    }

    for (const qualificationGroup of byQualification.values()) {
      const representative = qualificationGroup[0]!;
      if (qualificationGroup.length === 1) {
        const selectable: EligibleOfferRecipient = {
          professionalId: representative.professionalId,
          displayName: representative.displayName,
        };
        if (representative.qualification) {
          selectable.qualification = representative.qualification;
        }
        recipients.push(selectable);
        continue;
      }
      unresolvedHomonymGroups.push({
        code: UNRESOLVED_HOMONYM_CODE,
        displayName: representative.displayName,
        qualification: representative.qualification,
        count: qualificationGroup.length,
        reason: UNRESOLVED_HOMONYM_REASON,
      });
    }
  }

  recipients.sort(
    (left, right) =>
      compareRecipientName(left.displayName, right.displayName) ||
      compareRecipientName(
        left.qualification ?? "",
        right.qualification ?? "",
      ) ||
      left.professionalId - right.professionalId,
  );
  unresolvedHomonymGroups.sort(
    (left, right) =>
      compareRecipientName(left.displayName, right.displayName) ||
      compareRecipientName(
        left.qualification ?? "",
        right.qualification ?? "",
      ),
  );

  return { recipients, unresolvedHomonymGroups };
}

export async function listClinicallyEligibleOfferRecipients(
  db: EligibilityDb,
  input: {
    shiftId: number;
    institutionId: number;
    excludeProfessionalId: number;
    excludeUserId: number;
  },
): Promise<EligibleOfferRecipientList> {
  const limitPlusOne = ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT + 1;
  const result = await db.execute(sql`
    SELECT
      ap.id AS professionalId,
      ap.name AS displayName,
      ms.name AS medicalSpecialtyName,
      ap.operational_profile_code AS operationalProfileCode
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
    LEFT JOIN medical_specialties ms
      ON ms.id = ap.medical_specialty_id
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
  return projectEligibleOfferRecipients(rows);
}
