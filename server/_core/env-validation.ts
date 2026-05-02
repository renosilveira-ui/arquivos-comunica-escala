// server/_core/env-validation.ts
//
// Boot-time validation that blocks production startup when secrets, credentials
// or external URLs are missing, set to known placeholders, or pointing at
// localhost. Runs before any route is wired so misconfigured deploys fail fast
// instead of booting with a forged-session vector or talking to localhost
// services that do not exist.

const PLACEHOLDER_SECRETS: Record<string, readonly string[]> = {
  COOKIE_SECRET: [
    "dev-secret-change-in-production",
    "changeme_min_32_chars_secret_here",
    "changeme",
  ],
  COMUNICA_PLUS_SYSTEM_PASSWORD: ["system123", "changeme"],
  COMUNICA_PLUS_SYSTEM_PIN: ["9999"],
};

const REQUIRED_IN_PRODUCTION: readonly string[] = [
  "COOKIE_SECRET",
  "DATABASE_URL",
  "COMUNICA_PLUS_URL",
  "COMUNICA_PLUS_SYSTEM_EMAIL",
  "COMUNICA_PLUS_SYSTEM_PASSWORD",
  "COMUNICA_PLUS_SYSTEM_PIN",
];

const MIN_LENGTHS: Record<string, number> = {
  COOKIE_SECRET: 32,
};

const NO_LOCALHOST_URLS: readonly string[] = [
  "DATABASE_URL",
  "COMUNICA_PLUS_URL",
  "HOSPITAL_ALERT_URL",
  "EXPO_PUBLIC_API_URL",
];

const LOCALHOST_PATTERN = /(^|\/\/|@)(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i;

export interface EnvValidationOptions {
  env?: NodeJS.ProcessEnv;
}

export function collectProductionSecretIssues(
  options: EnvValidationOptions = {},
): string[] {
  const env = options.env ?? process.env;
  if (env.NODE_ENV !== "production") return [];

  const issues: string[] = [];

  for (const key of REQUIRED_IN_PRODUCTION) {
    const value = (env[key] ?? "").trim();
    if (!value) {
      issues.push(`${key} is required in production but is empty or unset`);
    }
  }

  for (const [key, placeholders] of Object.entries(PLACEHOLDER_SECRETS)) {
    const value = (env[key] ?? "").trim();
    if (!value) continue;
    if (placeholders.includes(value)) {
      issues.push(
        `${key} must not be the development placeholder value (set a real secret)`,
      );
    }
  }

  for (const [key, min] of Object.entries(MIN_LENGTHS)) {
    const value = (env[key] ?? "").trim();
    if (value && value.length < min) {
      issues.push(`${key} must be at least ${min} characters long`);
    }
  }

  for (const key of NO_LOCALHOST_URLS) {
    const value = (env[key] ?? "").trim();
    if (!value) continue;
    if (LOCALHOST_PATTERN.test(value)) {
      issues.push(
        `${key} must not point to localhost in production (current value targets a local host)`,
      );
    }
  }

  return issues;
}

export class ProductionBootError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    const detail = issues.map((i) => `  - ${i}`).join("\n");
    super(
      `[security] Refusing to boot in production due to insecure configuration:\n${detail}`,
    );
    this.name = "ProductionBootError";
    this.issues = issues;
  }
}

export function assertProductionSecrets(
  options: EnvValidationOptions = {},
): void {
  const issues = collectProductionSecretIssues(options);
  if (issues.length > 0) {
    throw new ProductionBootError(issues);
  }
}
