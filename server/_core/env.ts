// server/_core/env.ts — Variáveis de ambiente do server
function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const ENV = {
  cookieSecret: getEnvOrDefault(
    "COOKIE_SECRET",
    "dev-secret-change-in-production",
  ),
  databaseUrl: getEnvOrDefault("DATABASE_URL", ""),
  nodeEnv: getEnvOrDefault("NODE_ENV", "development"),
  comunicaJwksUri: getEnvOrDefault("COMUNICA_JWKS_URI", ""),
  comunicaIssuer: getEnvOrDefault("COMUNICA_ISSUER", ""),
  comunicaAudience: getEnvOrDefault("COMUNICA_AUDIENCE", ""),
  comunicaTenantMap: getEnvOrDefault("COMUNICA_TENANT_MAP", ""),
  shiftRadarDeepLinkBaseUrl: getEnvOrDefault(
    "SHIFT_RADAR_DEEPLINK_BASE_URL",
    "exp://localhost:8081/--",
  ),
  shiftRadarPollMs: Number(getEnvOrDefault("SHIFT_RADAR_POLL_MS", "60000")),
  shiftRadarEnabled: getEnvOrDefault("SHIFT_RADAR_ENABLED", "false") === "true",
  // SSO Escala → Comunica+
  ssoIssuer: getEnvOrDefault("SSO_ISSUER", "escalas-app"),
  ssoAudience: getEnvOrDefault("SSO_AUDIENCE", "comunicamais"),
  ssoKid: getEnvOrDefault("SSO_KID", "escala-sso-dev-2026"),
  ssoKeystorePath: getEnvOrDefault("SSO_KEYSTORE_PATH", ""),
  ssoTargetUrl: getEnvOrDefault("SSO_TARGET_URL", "http://localhost:3001"),
  ssoOrgMap: getEnvOrDefault("SSO_ORG_MAP", ""),
  /**
   * Rollout gate for exact JWT-instance binding. This is intentionally a
   * dynamic getter so a replica cannot accidentally inherit a truthy value
   * such as "true"; only the literal `1` enables issuance.
   */
  get sessionExactBindingSupported() {
    return getEnvOrDefault("SESSION_EXACT_BINDING_SUPPORTED", "0") === "1";
  },
  /**
   * Driver B2-D (poll READY_FOR_NL → B2-C). Default off: merge não ativa
   * staging/produção. Só o literal `true` liga.
   */
  get whatsappNlDriverEnabled() {
    return getEnvOrDefault("WHATSAPP_NL_DRIVER_ENABLED", "false") === "true";
  },
  get isDev() {
    return this.nodeEnv === "development";
  },
};
