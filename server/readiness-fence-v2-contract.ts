import {
  READINESS_FENCE_COVERAGE_HASH,
  READINESS_FENCE_COVERAGE_VERSION,
  READINESS_FENCE_INSTALLATION_ID,
} from "./readiness-fence-contract";

/**
 * Contrato da extensão V2. O hash representa seus três observadores e inclui
 * a prova V1 de base; a V1 permanece em seu singleton imutável, e V2 recebe
 * um recibo aditivo próprio.
 *
 * V2 observa somente a presença e a topologia da relação N:N. Uma eventual
 * regra de atividade do catálogo medical_specialties pertence a uma V3 nova,
 * com versão, hash e observadores próprios; não entra no fingerprint V2.
 */
export const READINESS_FENCE_V2_EXTENSION_KEY = "sector-service-specialties-v2";
export const READINESS_FENCE_V2_COVERAGE_VERSION =
  "2026-09-01-v2-sector-service-specialties";
export const READINESS_FENCE_V2_COVERAGE_HASH =
  "78a001ddfa0c443a9ca833d75e2b43e764478b91244eac5a2bf82192866cd435";

export const READINESS_FENCE_V2_PREDECESSOR = Object.freeze({
  installationId: READINESS_FENCE_INSTALLATION_ID,
  coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
  coverageHash: READINESS_FENCE_COVERAGE_HASH,
});
