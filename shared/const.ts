// shared/const.ts — Constantes usadas por server e client
export const COOKIE_NAME = "session";
export const SESSION_FENCE_COOKIE_NAME = "session_fence";
export const AXIOS_TIMEOUT_MS = 10_000;
// Alinhado ao teto de COOKIE_MAX_AGE_DAYS (90) em server/_core/cookie-policy.ts.
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** @deprecated Use SESSION_MAX_AGE_MS — mantido para compatibilidade de import. */
export const ONE_YEAR_MS = SESSION_MAX_AGE_MS;
export const UNAUTHED_ERR_MSG = "Você precisa estar logado para fazer isso.";
export const NOT_ADMIN_ERR_MSG = "Apenas administradores podem fazer isso.";
