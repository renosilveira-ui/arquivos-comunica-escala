export type TenantFilterStorageField = "hospital" | "sector";

type HospitalOption = Readonly<{ id: number }>;
type SectorOption = Readonly<{ id: number; hospitalId: number }>;

const STORAGE_PREFIX = "escala.shift-filters.v1";

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * A revisão do tenant faz parte da identidade do filtro em memória. Assim,
 * A → B → A não reutiliza a seleção de A antes de a consulta de B terminar.
 */
export function tenantFilterScopeKey(
  institutionId: number | null | undefined,
  tenantRevision: number,
): string {
  const institutionKey = isPositiveSafeInteger(institutionId)
    ? String(institutionId)
    : "none";
  const revisionKey =
    Number.isSafeInteger(tenantRevision) && tenantRevision >= 0
      ? String(tenantRevision)
      : "invalid";
  return `${institutionKey}:${revisionKey}`;
}

/**
 * Preferences de filtro são conveniência de interface, mas ainda precisam
 * estar presas ao tenant: um ID de hospital de A nunca é uma escolha válida
 * quando o usuário abre B.
 */
export function tenantFilterStorageKey(
  institutionId: number | null | undefined,
  field: TenantFilterStorageField,
): string | null {
  if (!isPositiveSafeInteger(institutionId)) return null;
  return `${STORAGE_PREFIX}.i${institutionId}.${field}`;
}

/** Não aceite coerção de localStorage como `""`, `" 1"` ou `"1e3"`. */
export function parseStoredTenantFilterId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return isPositiveSafeInteger(parsed) ? parsed : null;
}

/**
 * Revalida a seleção contra as opções do tenant que acabaram de ser
 * carregadas. Mantém um hospital válido quando apenas o setor ficou stale;
 * qualquer hospital estranho é reduzido para a visão neutra do tenant.
 */
export function sanitizeTenantFilterSelection(input: {
  hospitalId: number | null;
  sectorId: number | null;
  hospitals: readonly HospitalOption[];
  sectors: readonly SectorOption[];
}): Readonly<{ hospitalId: number | null; sectorId: number | null }> {
  const hospitalId =
    input.hospitalId !== null &&
    input.hospitals.some((hospital) => hospital.id === input.hospitalId)
      ? input.hospitalId
      : null;
  const sectorId =
    hospitalId !== null &&
    input.sectorId !== null &&
    input.sectors.some(
      (sector) =>
        sector.id === input.sectorId && sector.hospitalId === hospitalId,
    )
      ? input.sectorId
      : null;

  return { hospitalId, sectorId };
}
