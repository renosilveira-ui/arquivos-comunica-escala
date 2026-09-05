/**
 * Projeta candidates crus do resolver NL para escolhas humanas V1 (B2-A).
 *
 * Labels usam só dados profissionais públicos: nome + qualificação canônica
 * (medical_specialties.name ou rótulo de operational_profile_code) e, em
 * setor, nome + hospital quando necessário para distinguir.
 *
 * Não usa email, telefone, CPF, userId, nem o id interno como discriminador
 * visual. Homônimos indistinguíveis viram unresolvedGroups — nunca duas
 * choices com o mesmo label normalizado.
 *
 * Não persiste o raw `{ professionalId, name }` / `{ sectorId, name }`.
 */
import { inArray, eq } from "drizzle-orm";
import {
  hospitals,
  medicalSpecialties,
  professionals,
  sectors,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import {
  getOperationalProfileByCode,
  isOperationalProfileCode,
} from "../../../lib/medical-specialties";
import {
  normalizeWhatsAppChoiceLabel,
  projectWhatsAppSectorClarificationV1,
  projectWhatsAppTargetProfessionalClarificationV1,
  type WhatsAppClarificationV1,
  type WhatsAppPayloadParseResult,
} from "./pending-intent-payloads";

type InfraFailure = {
  ok: false;
  code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED";
};

type ProfessionalRow = {
  professionalId: number;
  name: string;
  medicalSpecialtyName: string | null;
  operationalProfileCode: string | null;
};

type SectorRow = {
  sectorId: number;
  name: string;
  hospitalName: string;
};

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

async function acquireDb(): Promise<
  | { ok: true; db: NonNullable<Awaited<ReturnType<typeof getDb>>> }
  | InfraFailure
> {
  try {
    const db = await getDb();
    if (!db) {
      logSafe({
        event: "whatsapp_ready_for_nl_homonym_unavailable",
        code: "DB_UNAVAILABLE",
      });
      return { ok: false, code: "DB_UNAVAILABLE" };
    }
    return { ok: true, db };
  } catch {
    logSafe({
      event: "whatsapp_ready_for_nl_homonym_failed",
      code: "PERSISTENCE_FAILED",
    });
    return { ok: false, code: "PERSISTENCE_FAILED" };
  }
}

function qualificationLabel(row: {
  medicalSpecialtyName: string | null;
  operationalProfileCode: string | null;
}): string | null {
  const specialty = String(row.medicalSpecialtyName ?? "").trim();
  if (specialty) return specialty;
  const code = row.operationalProfileCode;
  if (code && isOperationalProfileCode(code)) {
    return getOperationalProfileByCode(code)?.name ?? null;
  }
  return null;
}

function labelContainsInternalId(label: string, id: number): boolean {
  const digits = String(id);
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(label);
}

function uniquePositiveIds(ids: readonly number[]): number[] {
  const unique = new Set<number>();
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0) unique.add(id);
  }
  return [...unique];
}

/**
 * Nome sozinho quando único. Qualificação só entra para desambiguar.
 * Colisão restante → unresolved group, sem choice selecionável.
 */
export function projectProfessionalChoiceLabels(
  rows: readonly ProfessionalRow[],
): {
  candidates: { professionalId: number; label: string }[];
  unresolvedGroups: { label: string; count: number }[];
} {
  const byName = new Map<string, ProfessionalRow[]>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const key = normalizeWhatsAppChoiceLabel(name);
    const group = byName.get(key);
    if (group) group.push(row);
    else byName.set(key, [row]);
  }

  const candidates: { professionalId: number; label: string }[] = [];
  const unresolvedGroups: { label: string; count: number }[] = [];

  const pushChoice = (professionalId: number, label: string): void => {
    const trimmed = label.trim();
    if (!trimmed || labelContainsInternalId(trimmed, professionalId)) {
      return;
    }
    candidates.push({ professionalId, label: trimmed });
  };

  for (const nameGroup of byName.values()) {
    if (nameGroup.length === 1) {
      const only = nameGroup[0]!;
      pushChoice(only.professionalId, only.name.trim());
      continue;
    }

    const byQualification = new Map<string, ProfessionalRow[]>();
    for (const row of nameGroup) {
      const qual = qualificationLabel(row);
      const key = normalizeWhatsAppChoiceLabel(qual ?? "");
      const group = byQualification.get(key);
      if (group) group.push(row);
      else byQualification.set(key, [row]);
    }

    for (const qualGroup of byQualification.values()) {
      const representative = qualGroup[0]!;
      const name = representative.name.trim();
      const qual = qualificationLabel(representative);
      const distinguished = qual ? `${name} · ${qual}` : name;
      if (qualGroup.length === 1) {
        pushChoice(representative.professionalId, distinguished);
        continue;
      }
      unresolvedGroups.push({
        label: distinguished,
        count: qualGroup.length,
      });
    }
  }

  return collapseIndistinguishableChoices(candidates, unresolvedGroups);
}

export function projectSectorChoiceLabels(
  rows: readonly SectorRow[],
): {
  candidates: { sectorId: number; label: string }[];
  unresolvedGroups: { label: string; count: number }[];
} {
  const byName = new Map<string, SectorRow[]>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const key = normalizeWhatsAppChoiceLabel(name);
    const group = byName.get(key);
    if (group) group.push(row);
    else byName.set(key, [row]);
  }

  const candidates: { sectorId: number; label: string }[] = [];
  const unresolvedGroups: { label: string; count: number }[] = [];

  const pushChoice = (sectorId: number, label: string): void => {
    const trimmed = label.trim();
    if (!trimmed || labelContainsInternalId(trimmed, sectorId)) {
      return;
    }
    candidates.push({ sectorId, label: trimmed });
  };

  for (const nameGroup of byName.values()) {
    if (nameGroup.length === 1) {
      const only = nameGroup[0]!;
      pushChoice(only.sectorId, only.name.trim());
      continue;
    }

    const byHospital = new Map<string, SectorRow[]>();
    for (const row of nameGroup) {
      const hospital = row.hospitalName.trim();
      const key = normalizeWhatsAppChoiceLabel(hospital);
      const group = byHospital.get(key);
      if (group) group.push(row);
      else byHospital.set(key, [row]);
    }

    for (const hospitalGroup of byHospital.values()) {
      const representative = hospitalGroup[0]!;
      const name = representative.name.trim();
      const hospital = representative.hospitalName.trim();
      const distinguished = hospital ? `${name} · ${hospital}` : name;
      if (hospitalGroup.length === 1) {
        pushChoice(representative.sectorId, distinguished);
        continue;
      }
      unresolvedGroups.push({
        label: distinguished,
        count: hospitalGroup.length,
      });
    }
  }

  return collapseIndistinguishableChoices(candidates, unresolvedGroups);
}

function collapseIndistinguishableChoices<T extends { label: string }>(
  candidates: readonly T[],
  unresolvedGroups: readonly { label: string; count: number }[],
): { candidates: T[]; unresolvedGroups: { label: string; count: number }[] } {
  const byLabel = new Map<string, T[]>();
  for (const choice of candidates) {
    const key = normalizeWhatsAppChoiceLabel(choice.label);
    const group = byLabel.get(key);
    if (group) group.push(choice);
    else byLabel.set(key, [choice]);
  }

  const mergedUnresolved = new Map<string, { label: string; count: number }>();
  const addUnresolved = (label: string, count: number): void => {
    const key = normalizeWhatsAppChoiceLabel(label);
    if (!key || count < 2) return;
    const existing = mergedUnresolved.get(key);
    if (existing) {
      existing.count += count;
      return;
    }
    mergedUnresolved.set(key, { label, count });
  };

  for (const group of unresolvedGroups) {
    addUnresolved(group.label, group.count);
  }

  const selectable: T[] = [];
  for (const group of byLabel.values()) {
    if (group.length === 1) {
      const only = group[0]!;
      const key = normalizeWhatsAppChoiceLabel(only.label);
      if (mergedUnresolved.has(key)) continue;
      selectable.push(only);
      continue;
    }
    addUnresolved(group[0]!.label, group.length);
  }

  return {
    candidates: selectable.filter((choice) => {
      const key = normalizeWhatsAppChoiceLabel(choice.label);
      return !mergedUnresolved.has(key);
    }),
    unresolvedGroups: [...mergedUnresolved.values()],
  };
}

export async function projectTargetProfessionalClarificationFromResolver(
  raw: readonly { professionalId: number; name: string }[],
): Promise<
  | WhatsAppPayloadParseResult<
      Extract<WhatsAppClarificationV1, { code: "AMBIGUOUS_TARGET_PROFESSIONAL" }>
    >
  | InfraFailure
> {
  const ids = uniquePositiveIds(raw.map((item) => item.professionalId));
  if (ids.length === 0) {
    return projectWhatsAppTargetProfessionalClarificationV1({
      candidates: [],
      unresolvedGroups: [],
    });
  }

  const acquired = await acquireDb();
  if (!acquired.ok) return acquired;
  const db = acquired.db;

  try {
    const rows = await db
      .select({
        professionalId: professionals.id,
        name: professionals.name,
        medicalSpecialtyName: medicalSpecialties.name,
        operationalProfileCode: professionals.operationalProfileCode,
      })
      .from(professionals)
      .leftJoin(
        medicalSpecialties,
        eq(professionals.medicalSpecialtyId, medicalSpecialties.id),
      )
      .where(inArray(professionals.id, ids));

    if (rows.length !== ids.length) {
      logSafe({
        event: "whatsapp_ready_for_nl_homonym_failed",
        code: "PERSISTENCE_FAILED",
        expected: ids.length,
        loaded: rows.length,
      });
      return { ok: false, code: "PERSISTENCE_FAILED" };
    }

    const projected = projectProfessionalChoiceLabels(rows);
    return projectWhatsAppTargetProfessionalClarificationV1(projected);
  } catch {
    logSafe({
      event: "whatsapp_ready_for_nl_homonym_failed",
      code: "PERSISTENCE_FAILED",
    });
    return { ok: false, code: "PERSISTENCE_FAILED" };
  }
}

export async function projectSectorClarificationFromResolver(
  raw: readonly { sectorId: number; name: string }[],
): Promise<
  | WhatsAppPayloadParseResult<
      Extract<WhatsAppClarificationV1, { code: "AMBIGUOUS_SECTOR" }>
    >
  | InfraFailure
> {
  const ids = uniquePositiveIds(raw.map((item) => item.sectorId));
  if (ids.length === 0) {
    return projectWhatsAppSectorClarificationV1({
      candidates: [],
      unresolvedGroups: [],
    });
  }

  const acquired = await acquireDb();
  if (!acquired.ok) return acquired;
  const db = acquired.db;

  try {
    const rows = await db
      .select({
        sectorId: sectors.id,
        name: sectors.name,
        hospitalName: hospitals.name,
      })
      .from(sectors)
      .innerJoin(hospitals, eq(hospitals.id, sectors.hospitalId))
      .where(inArray(sectors.id, ids));

    if (rows.length !== ids.length) {
      logSafe({
        event: "whatsapp_ready_for_nl_homonym_failed",
        code: "PERSISTENCE_FAILED",
        expected: ids.length,
        loaded: rows.length,
      });
      return { ok: false, code: "PERSISTENCE_FAILED" };
    }

    const projected = projectSectorChoiceLabels(rows);
    return projectWhatsAppSectorClarificationV1(projected);
  } catch {
    logSafe({
      event: "whatsapp_ready_for_nl_homonym_failed",
      code: "PERSISTENCE_FAILED",
    });
    return { ok: false, code: "PERSISTENCE_FAILED" };
  }
}
