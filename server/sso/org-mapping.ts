// server/sso/org-mapping.ts — Map Escala institution IDs to Comunica+ organization IDs
import { ENV } from "../_core/env";

/**
 * Maps Escala institutionId (numeric) → Comunica+ organizationId (UUID string).
 *
 * Source: SSO_ORG_MAP env var as JSON, e.g.:
 *   SSO_ORG_MAP={"1":"393c32d0-3be6-4239-82dd-f9a30dce1f82","2":"uuid-sc"}
 *
 * Keys are Escala institution IDs (as strings), values are Comunica+ org UUIDs.
 */
let orgMap: Map<number, string> | null = null;
let cachedRaw: string | null = null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validInstitutionId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function loadMap(): Map<number, string> {
  // O ambiente e estavel em producao, mas comparar o valor bruto evita cache
  // obsoleto em testes/hot reload sem jamais registrar o conteudo do mapa.
  const raw = process.env.SSO_ORG_MAP ?? ENV.ssoOrgMap;
  if (orgMap && cachedRaw === raw) return orgMap;

  orgMap = new Map();
  cachedRaw = raw;
  if (!raw) return orgMap;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("SSO_ORG_MAP deve ser um objeto JSON");
    }
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      const organizationId = typeof value === "string" ? value.trim() : "";
      if (
        validInstitutionId(id) &&
        key === String(id) &&
        UUID_PATTERN.test(organizationId)
      ) {
        orgMap.set(id, organizationId.toLowerCase());
      }
    }
  } catch (err) {
    console.error("[SSO] Failed to parse SSO_ORG_MAP:", err);
  }

  return orgMap;
}

export function getComunicaOrgId(escalaInstitutionId: number): string | null {
  if (!validInstitutionId(escalaInstitutionId)) return null;
  return loadMap().get(escalaInstitutionId) ?? null;
}

export function hasMappingFor(escalaInstitutionId: number): boolean {
  if (!validInstitutionId(escalaInstitutionId)) return false;
  return loadMap().has(escalaInstitutionId);
}
