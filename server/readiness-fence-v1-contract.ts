/**
 * Contrato imutável entre a migration manual V1 e qualquer consumidor futuro
 * da fence. Não representa aprovação de prontidão.
 *
 * Alterar fontes ou corpo de trigger exige uma nova versão/migration; nunca
 * se reescreve o contrato V1 já instalado.
 */
export const READINESS_FENCE_V1_INSTALLATION_ID = 1;
export const READINESS_FENCE_V1_COVERAGE_VERSION = "2026-09-01-v1-clean";

/**
 * SHA-256 canônico do catálogo de fontes e triggers V1.
 *
 * O teste da migration recalcula este valor a partir do SQL. O instalador só
 * grava o marcador se houver correspondência exata.
 */
export const READINESS_FENCE_V1_COVERAGE_HASH =
  "6c0ab9a884aaae6b1e36cb38ccab61b5e2ec10d9de9f8d7de34279db2590af3c";
