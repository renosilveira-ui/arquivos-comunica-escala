// server/_core/env.ts — Variáveis de ambiente do server
function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const ENV = {
  cookieSecret: getEnvOrDefault("COOKIE_SECRET", "dev-secret-change-in-production"),
  databaseUrl: getEnvOrDefault("DATABASE_URL", ""),
  nodeEnv: getEnvOrDefault("NODE_ENV", "development"),
  get isDev() {
    return this.nodeEnv === "development";
  },
};
