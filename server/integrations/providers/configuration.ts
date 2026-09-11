import {
  EXTERNAL_PROVIDERS,
  PROVIDER_CONFIGURATION_STATES,
  type ExternalProvider,
  type ProviderConfigurationState,
} from "../../../lib/integration-providers";
import { externalCredentialsKeyRing } from "../../external-credentials-crypto";

/**
 * Leitura do estado de configuração dos provedores externos.
 *
 * Este módulo responde "dá para usar?" sem jamais devolver o valor de
 * nenhuma credencial. O retorno é seguro para log, para resposta tRPC e para
 * tela de diagnóstico do gestor.
 *
 * A distinção entre `NOT_CONFIGURED` e `MISCONFIGURED` é o ponto do arquivo:
 * um provedor que nunca foi contratado é estado normal do produto; um
 * provedor com metade das variáveis preenchidas é defeito operacional e
 * precisa ser visível antes de alguém descobrir pelo erro do usuário.
 */

export type ProviderConfigurationReport = {
  provider: ExternalProvider;
  state: ProviderConfigurationState;
  /**
   * Nomes das variáveis que faltam ou estão inválidas. Somente nomes —
   * nunca valores, nem prefixo, nem tamanho.
   */
  missing: readonly string[];
};

const LOCALHOST_PATTERN =
  /(^|\/\/|@)(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i;

function present(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean((env[key] ?? "").trim());
}

function evaluate(
  provider: ExternalProvider,
  required: readonly string[],
  env: NodeJS.ProcessEnv,
  extraIssues: readonly string[] = [],
): ProviderConfigurationReport {
  const missing = required.filter((key) => !present(env, key));
  const issues = [...missing, ...extraIssues];
  if (missing.length === required.length && extraIssues.length === 0) {
    return {
      provider,
      state: PROVIDER_CONFIGURATION_STATES.notConfigured,
      missing: required,
    };
  }
  return {
    provider,
    state:
      issues.length === 0
        ? PROVIDER_CONFIGURATION_STATES.configured
        : PROVIDER_CONFIGURATION_STATES.misconfigured,
    missing: issues,
  };
}

export const GOOGLE_OAUTH_ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
] as const;

export const GOOGLE_MAPS_ENV_KEYS = ["GOOGLE_MAPS_API_KEY"] as const;

export const WEATHERKIT_ENV_KEYS = [
  "WEATHERKIT_TEAM_ID",
  "WEATHERKIT_SERVICE_ID",
  "WEATHERKIT_KEY_ID",
  "WEATHERKIT_PRIVATE_KEY",
] as const;

/**
 * A chave de criptografia só é exigida de quem persiste credencial. Maps e
 * WeatherKit são server-to-server e não guardam nada do usuário; cobrar a
 * chave deles bloquearia rota e clima por um motivo que não existe.
 */
function encryptionIssues(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    externalCredentialsKeyRing(env);
    return [];
  } catch {
    return ["EXTERNAL_CREDENTIALS_ENCRYPTION_KEY"];
  }
}

function redirectUriIssues(env: NodeJS.ProcessEnv): readonly string[] {
  const value = (env.GOOGLE_OAUTH_REDIRECT_URI ?? "").trim();
  if (!value) return [];
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return ["GOOGLE_OAUTH_REDIRECT_URI"];
  }
  const isProduction = env.NODE_ENV === "production";
  // Fora de produção o redirect local é o fluxo normal de desenvolvimento.
  if (isProduction && parsed.protocol !== "https:") {
    return ["GOOGLE_OAUTH_REDIRECT_URI"];
  }
  if (isProduction && LOCALHOST_PATTERN.test(value)) {
    return ["GOOGLE_OAUTH_REDIRECT_URI"];
  }
  if (parsed.hash) return ["GOOGLE_OAUTH_REDIRECT_URI"];
  return [];
}

export function googleCalendarConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfigurationReport {
  const anyOAuthPresent = GOOGLE_OAUTH_ENV_KEYS.some((key) =>
    present(env, key),
  );
  return evaluate(
    EXTERNAL_PROVIDERS.googleCalendar,
    GOOGLE_OAUTH_ENV_KEYS,
    env,
    anyOAuthPresent
      ? [...redirectUriIssues(env), ...encryptionIssues(env)]
      : [],
  );
}

export function googleMapsConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfigurationReport {
  return evaluate(EXTERNAL_PROVIDERS.googlePlaces, GOOGLE_MAPS_ENV_KEYS, env);
}

export function weatherKitConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfigurationReport {
  return evaluate(EXTERNAL_PROVIDERS.weatherKit, WEATHERKIT_ENV_KEYS, env);
}

export function externalProviderConfigurations(
  env: NodeJS.ProcessEnv = process.env,
): readonly ProviderConfigurationReport[] {
  const maps = googleMapsConfiguration(env);
  return [
    googleCalendarConfiguration(env),
    maps,
    // Places e Routes compartilham a mesma chave; reportar separado evita
    // que a UI precise saber que são o mesmo produto do Google.
    { ...maps, provider: EXTERNAL_PROVIDERS.googleRoutes },
    weatherKitConfiguration(env),
  ];
}

export function isProviderUsable(report: ProviderConfigurationReport): boolean {
  return report.state === PROVIDER_CONFIGURATION_STATES.configured;
}
