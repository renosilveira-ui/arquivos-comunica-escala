// shared/const.ts — Constantes usadas por server e client
export const COOKIE_NAME = "session";
export const SESSION_FENCE_COOKIE_NAME = "session_fence";
export const AXIOS_TIMEOUT_MS = 10_000;
// Teto de COOKIE_MAX_AGE_DAYS (90). A emissão usa resolveSessionTtlMs()
// (default 30d), não este teto — senão o Bearer vive mais que o cookie.
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** @deprecated Use SESSION_MAX_AGE_MS — mantido para compatibilidade de import. */
export const ONE_YEAR_MS = SESSION_MAX_AGE_MS;
export const UNAUTHED_ERR_MSG = "Você precisa estar logado para fazer isso.";
export const NOT_ADMIN_ERR_MSG = "Apenas administradores podem fazer isso.";
