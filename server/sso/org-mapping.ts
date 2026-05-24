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

function loadMap(): Map<number, string> {
  if (orgMap) return orgMap;

  orgMap = new Map();
  const raw = ENV.ssoOrgMap;
  if (!raw) return orgMap;

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      if (Number.isFinite(id) && typeof value === "string" && value.trim()) {
        orgMap.set(id, value.trim());
      }
    }
  } catch (err) {
    console.error("[SSO] Failed to parse SSO_ORG_MAP:", err);
  }

  return orgMap;
}

export function getComunicaOrgId(escalaInstitutionId: number): string | null {
  return loadMap().get(escalaInstitutionId) ?? null;
}

export function hasMappingFor(escalaInstitutionId: number): boolean {
  return loadMap().has(escalaInstitutionId);
}
