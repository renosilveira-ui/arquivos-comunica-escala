/**
 * Contrato imutável entre o instalador manual e o runtime da fence.
 *
 * Toda alteração na lista ou no corpo de triggers exige uma migration nova
 * com versão e hash novos; o instalador nunca substitui um trigger existente.
 */
export const READINESS_FENCE_INSTALLATION_ID = 1;
export const READINESS_FENCE_COVERAGE_VERSION = "2026-08-31-v1";

/**
 * SHA-256 do catálogo canônico de triggers desta migration. O instalador
 * recalcula esse valor antes de escrever o marcador; o runtime só opera com
 * o marcador exatamente correspondente.
 */
export const READINESS_FENCE_COVERAGE_HASH =
  "78897f2a765031f6fcef0d1e81c0268514f48e4531a798612eabe25124984166";
