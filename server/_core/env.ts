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
  get isDev() {
    return this.nodeEnv === "development";
  },
};
