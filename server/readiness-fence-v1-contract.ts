/**
 * Contrato imutável entre a migration manual V1 e qualquer consumidor futuro
 * da fence. Não representa aprovação de prontidão.
 *
 * Alterar fontes ou corpo de trigger exige uma nova versão/migration; nunca
 * se reescreve o contrato V1 já instalado.
 */
export const READINESS_FENCE_V1_INSTALLATION_ID = 1;
export const READINESS_FENCE_V1_COVERAGE_VERSION = "2026-09-01-v1-journal";

/**
 * O recibo só prova que esta versão do instalador terminou uma vez. Ele não
 * prova que o catálogo atual, os triggers ou a topologia continuam íntegros
 * e, portanto, nunca autoriza publicação, alocação ou qualquer decisão de
 * prontidão por si só.
 *
 * Um consumidor futuro deve validar o catálogo e a cobertura de triggers na
 * mesma transação em que usar o high-watermark institucional. A V1 não
 * fornece esse consumidor nem uma projeção booleana de "pronto".
 */
export const READINESS_FENCE_V1_RECEIPT_ROLE =
  "INSTALLATION_PREREQUISITE_ONLY" as const;

export const READINESS_FENCE_V1_FUTURE_CONSUMER_REQUIREMENTS = Object.freeze([
  "VERIFY_CURRENT_CATALOG_IN_SAME_TRANSACTION",
  "VERIFY_TRIGGER_COVERAGE_IN_SAME_TRANSACTION",
  "CAPTURE_SERVER_ISSUED_HIGH_WATERMARK",
  "LOCK_NORMAL_RESOURCES_BEFORE_EVENT_RANGE",
] as const);

/**
 * SHA-256 canônico do catálogo de fontes e triggers V1.
 *
 * O teste da migration recalcula este valor a partir do SQL. O instalador só
 * grava o marcador se houver correspondência exata.
 */
export const READINESS_FENCE_V1_COVERAGE_HASH =
  "220fdde506ea227bc8bd4be227c180b8aedd699b74c43700c0814ef165b9c320";
