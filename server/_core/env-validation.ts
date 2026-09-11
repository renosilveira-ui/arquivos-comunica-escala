// server/_core/env-validation.ts
//
// Boot-time validation that blocks production startup when secrets, credentials
// or external URLs are missing, set to known placeholders, or pointing at
// localhost. Runs before any route is wired so misconfigured deploys fail fast
// instead of booting with a forged-session vector or talking to localhost
// services that do not exist.

import { PROVIDER_CONFIGURATION_STATES } from "../../lib/integration-providers";
import { externalProviderConfigurations } from "../integrations/providers/configuration";

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
  "AUTH_RECOVERY_ENCRYPTION_CURRENT_KID",
  "AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET",
];

const COMUNICA_OUTBOUND_REQUIRED: readonly string[] = [
  "COMUNICA_PLUS_URL",
  "COMUNICA_PLUS_SYSTEM_EMAIL",
  "COMUNICA_PLUS_SYSTEM_PASSWORD",
  "COMUNICA_PLUS_SYSTEM_PIN",
];

const MIN_LENGTHS: Record<string, number> = {
  COOKIE_SECRET: 32,
  AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET: 32,
  AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET: 32,
  EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: 32,
  EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KEY: 32,
};

const MAX_BYTE_LENGTHS: Record<string, number> = {
  AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET: 1024,
  AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET: 1024,
  EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: 1024,
  EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KEY: 1024,
};

/**
 * Segredos medidos em bytes, não em caracteres: uma chave com acento tem
 * menos entropia do que o `length` sugere.
 */
const BYTE_MEASURED_PREFIXES: readonly string[] = [
  "AUTH_RECOVERY_ENCRYPTION_",
  "EXTERNAL_CREDENTIALS_ENCRYPTION_",
];

const NO_LOCALHOST_URLS: readonly string[] = [
  "DATABASE_URL",
  "COMUNICA_PLUS_URL",
  "HOSPITAL_ALERT_URL",
  "EXPO_PUBLIC_API_URL",
  "GOOGLE_OAUTH_REDIRECT_URI",
];

const LOCALHOST_PATTERN =
  /(^|\/\/|@)(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i;

export interface EnvValidationOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Configuração incompleta de integração externa é AVISO, não bloqueio.
 *
 * A primeira versão disto derrubava o boot quando um provedor estava pela
 * metade. O raciocínio era "falhar cedo", mas a consequência é
 * desproporcional: uma chave de previsão do tempo faltando derrubaria o
 * sistema de escala inteiro de um hospital. Clima é ornamento; Google Agenda
 * é conveniência. Nenhum dos dois vale a escala parar.
 *
 * A recusa continua existindo onde importa — `REQUIRED_IN_PRODUCTION` para
 * segredo de sessão e banco. Para o resto, o provedor fica indisponível, a
 * tela diz isso ao usuário, e o boot registra um aviso nomeando a variável.
 *
 * Contexto: em 10/09 o staging ficou 3h16 fora do ar por duas variáveis
 * ausentes. Ampliar o conjunto de coisas capazes de impedir o boot teria
 * multiplicado esse risco.
 */
export function collectExternalIntegrationWarnings(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const issues = new Set<string>();
  for (const report of externalProviderConfigurations(env)) {
    if (report.state !== PROVIDER_CONFIGURATION_STATES.misconfigured) continue;
    for (const key of report.missing) {
      issues.add(
        `${key} is incomplete or invalid; ${report.provider} stays unavailable`,
      );
    }
  }
  return [...issues];
}

/**
 * Estado de cada integração externa, para o log de boot.
 *
 * Só nome e estado — nunca valor. Existe porque `collectExternalIntegrationWarnings`
 * só fala quando a configuração está pela METADE: um provedor de chave única,
 * como o Google Maps, nunca fica "pela metade", então a ausência dele era
 * invisível de fora. Descobrir se a chave estava lá exigia adivinhar, e
 * adivinhar sobre configuração foi o que custou 3h16 de staging em 10/09.
 */
export function describeExternalIntegrations(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const report of externalProviderConfigurations(env)) {
    summary[report.provider] = report.state;
  }
  return summary;
}

export function collectProductionSecretIssues(
  options: EnvValidationOptions = {},
): string[] {
  const env = options.env ?? process.env;
  if (env.NODE_ENV !== "production") return [];

  const issues: string[] = [];
  const currentKid = (env.AUTH_RECOVERY_ENCRYPTION_CURRENT_KID ?? "").trim();
  const previousKid = (env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID ?? "").trim();
  const previousSecret = (
    env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET ?? ""
  ).trim();
  const currentSecret = (
    env.AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET ?? ""
  ).trim();
  const cookieSecret = (env.COOKIE_SECRET ?? "").trim();
  if (currentKid && !/^[a-zA-Z0-9_-]{1,32}$/.test(currentKid)) {
    issues.push("AUTH_RECOVERY_ENCRYPTION_CURRENT_KID has invalid format");
  }
  if (Boolean(previousKid) !== Boolean(previousSecret)) {
    issues.push(
      "AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID and SECRET must be set together",
    );
  }
  if (previousKid && !/^[a-zA-Z0-9_-]{1,32}$/.test(previousKid)) {
    issues.push("AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID has invalid format");
  }
  if (previousKid && previousKid === currentKid) {
    issues.push(
      "AUTH_RECOVERY_ENCRYPTION previous and current KIDs must differ",
    );
  }
  if (currentSecret && currentSecret === cookieSecret) {
    issues.push(
      "AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET must differ from COOKIE_SECRET",
    );
  }
  if (previousSecret && previousSecret === cookieSecret) {
    issues.push(
      "AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET must differ from COOKIE_SECRET",
    );
  }
  if (currentSecret && previousSecret && currentSecret === previousSecret) {
    issues.push(
      "AUTH_RECOVERY_ENCRYPTION previous and current secrets must differ",
    );
  }
  const sessionBindingFlag = (env.SESSION_EXACT_BINDING_SUPPORTED ?? "").trim();
  if (
    sessionBindingFlag &&
    sessionBindingFlag !== "0" &&
    sessionBindingFlag !== "1"
  ) {
    issues.push("SESSION_EXACT_BINDING_SUPPORTED must be 0, 1, or unset");
  }
  const outboundFlag = (env.COMUNICA_PLUS_OUTBOUND_ENABLED ?? "").trim();
  const outboundEnabled = outboundFlag === "1";
  if (outboundFlag && outboundFlag !== "0" && outboundFlag !== "1") {
    issues.push("COMUNICA_PLUS_OUTBOUND_ENABLED must be 0, 1, or unset");
  }

  for (const key of [
    ...REQUIRED_IN_PRODUCTION,
    ...(outboundEnabled ? COMUNICA_OUTBOUND_REQUIRED : []),
  ]) {
    const value = (env[key] ?? "").trim();
    if (!value) {
      issues.push(`${key} is required in production but is empty or unset`);
    }
  }

  for (const [key, placeholders] of Object.entries(PLACEHOLDER_SECRETS)) {
    if (key.startsWith("COMUNICA_PLUS_") && !outboundEnabled) continue;
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
    const byteMeasured = BYTE_MEASURED_PREFIXES.some((prefix) =>
      key.startsWith(prefix),
    );
    const measuredLength = byteMeasured
      ? Buffer.byteLength(value, "utf8")
      : value.length;
    if (value && measuredLength < min) {
      issues.push(
        `${key} must be at least ${min} ${byteMeasured ? "bytes" : "characters"} long`,
      );
    }
  }

  for (const [key, max] of Object.entries(MAX_BYTE_LENGTHS)) {
    const value = (env[key] ?? "").trim();
    if (value && Buffer.byteLength(value, "utf8") > max) {
      issues.push(`${key} must be at most ${max} bytes long`);
    }
  }

  for (const key of NO_LOCALHOST_URLS) {
    if (key === "COMUNICA_PLUS_URL" && !outboundEnabled) continue;
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
