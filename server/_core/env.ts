// server/_core/env.ts — Variáveis de ambiente do server
function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const ENV = {
  cookieSecret: getEnvOrDefault("COOKIE_SECRET", "dev-secret-change-in-production"),
  databaseUrl: getEnvOrDefault("DATABASE_URL", ""),
  nodeEnv: getEnvOrDefault("NODE_ENV", "development"),
  comunicaJwksUri: getEnvOrDefault("COMUNICA_JWKS_URI", ""),
  comunicaIssuer: getEnvOrDefault("COMUNICA_ISSUER", ""),
  comunicaAudience: getEnvOrDefault("COMUNICA_AUDIENCE", ""),
  comunicaTenantMap: getEnvOrDefault("COMUNICA_TENANT_MAP", ""),
  shiftRadarDeepLinkBaseUrl: getEnvOrDefault("SHIFT_RADAR_DEEPLINK_BASE_URL", "exp://localhost:8081/--"),
  shiftRadarPollMs: Number(getEnvOrDefault("SHIFT_RADAR_POLL_MS", "60000")),
  shiftRadarEnabled: getEnvOrDefault("SHIFT_RADAR_ENABLED", "false") === "true",
  /**
   * AuthZ v1 enforcement flag.
   * AUTHZ_V1_ENFORCE=1  → enforce the new central authorize() function
   * AUTHZ_V1_ENFORCE=0  → fall back to legacy RBAC (safe rollback without redeploy)
   * Default: "0" (legacy fallback) until cutover is confirmed.
   */
  authzV1Enforce: getEnvOrDefault("AUTHZ_V1_ENFORCE", "0") === "1",
  get isDev() {
    return this.nodeEnv === "development";
  },
};
