import { describe, expect, it } from "vitest";

import {
  EXTERNAL_LINK_STATES,
  EXTERNAL_PROVIDERS,
  PROVIDER_CONFIGURATION_STATES,
  PROVIDER_OUTCOMES,
  canAttemptSync,
  nextExternalLinkState,
  requiresUserAction,
} from "../lib/integration-providers";
import {
  externalProviderConfigurations,
  googleCalendarConfiguration,
  googleMapsConfiguration,
  isProviderUsable,
  weatherKitConfiguration,
} from "../server/integrations/providers/configuration";
import {
  PROVIDER_FAILURE_REASONS,
  classifyHttpStatus,
  coarsenGeoPoint,
  isRetryableReason,
  isValidGeoPoint,
  providerFailure,
} from "../server/integrations/providers/types";

const SECRET = "z".repeat(48);

describe("vínculo da conta — máquina de estados", () => {
  it("uma falha transitória degrada, mas nunca desconecta nem exige reautenticação", () => {
    expect(
      nextExternalLinkState(
        EXTERNAL_LINK_STATES.connected,
        PROVIDER_OUTCOMES.retryableFailure,
      ),
    ).toBe(EXTERNAL_LINK_STATES.degraded);
    expect(
      canAttemptSync(
        nextExternalLinkState(
          EXTERNAL_LINK_STATES.connected,
          PROVIDER_OUTCOMES.retryableFailure,
        ),
      ),
    ).toBe(true);
  });

  it("credencial rejeitada exige ação do usuário", () => {
    const state = nextExternalLinkState(
      EXTERNAL_LINK_STATES.degraded,
      PROVIDER_OUTCOMES.authRejected,
    );
    expect(state).toBe(EXTERNAL_LINK_STATES.reauthRequired);
    expect(requiresUserAction(state)).toBe(true);
    expect(canAttemptSync(state)).toBe(false);
  });

  it("um 503 não apaga a reautenticação pendente", () => {
    expect(
      nextExternalLinkState(
        EXTERNAL_LINK_STATES.reauthRequired,
        PROVIDER_OUTCOMES.retryableFailure,
      ),
    ).toBe(EXTERNAL_LINK_STATES.reauthRequired);
  });

  it("sucesso reconecta a partir de degradado e de reautenticação", () => {
    for (const from of [
      EXTERNAL_LINK_STATES.degraded,
      EXTERNAL_LINK_STATES.reauthRequired,
    ]) {
      expect(nextExternalLinkState(from, PROVIDER_OUTCOMES.success)).toBe(
        EXTERNAL_LINK_STATES.connected,
      );
    }
  });

  it("desconectado não volta sozinho: só uma nova autorização reconecta", () => {
    for (const outcome of [
      PROVIDER_OUTCOMES.retryableFailure,
      PROVIDER_OUTCOMES.authRejected,
    ]) {
      expect(
        nextExternalLinkState(EXTERNAL_LINK_STATES.disconnected, outcome),
      ).toBe(EXTERNAL_LINK_STATES.disconnected);
    }
    expect(
      nextExternalLinkState(
        EXTERNAL_LINK_STATES.disconnected,
        PROVIDER_OUTCOMES.success,
      ),
    ).toBe(EXTERNAL_LINK_STATES.connected);
  });

  it("revogação pelo usuário desconecta a partir de qualquer estado", () => {
    for (const from of Object.values(EXTERNAL_LINK_STATES)) {
      expect(nextExternalLinkState(from, PROVIDER_OUTCOMES.revokedByUser)).toBe(
        EXTERNAL_LINK_STATES.disconnected,
      );
    }
  });
});

describe("classificação de falha do provedor", () => {
  it("separa o que vale repetir do que não vale", () => {
    expect(classifyHttpStatus(429)).toBe(PROVIDER_FAILURE_REASONS.rateLimited);
    expect(classifyHttpStatus(503)).toBe(
      PROVIDER_FAILURE_REASONS.upstreamError,
    );
    expect(classifyHttpStatus(401)).toBe(PROVIDER_FAILURE_REASONS.authRejected);
    expect(classifyHttpStatus(404)).toBe(PROVIDER_FAILURE_REASONS.notFound);
    expect(classifyHttpStatus(400)).toBe(
      PROVIDER_FAILURE_REASONS.invalidRequest,
    );
    expect(isRetryableReason(PROVIDER_FAILURE_REASONS.rateLimited)).toBe(true);
    expect(isRetryableReason(PROVIDER_FAILURE_REASONS.notFound)).toBe(false);
  });

  it("403 não derruba o vínculo: cota do Google não é credencial inválida", () => {
    const reason = classifyHttpStatus(403);
    expect(isRetryableReason(reason)).toBe(true);
    expect(providerFailure(reason).outcome).toBe(
      PROVIDER_OUTCOMES.retryableFailure,
    );
  });

  it("a falha não carrega corpo, URL nem identificador", () => {
    const failure = providerFailure(PROVIDER_FAILURE_REASONS.timeout, 1_000);
    expect(Object.keys(failure).sort()).toEqual([
      "ok",
      "outcome",
      "reason",
      "retryAfterMs",
    ]);
  });
});

describe("coordenadas", () => {
  it("recusa ponto fora do intervalo geográfico", () => {
    expect(isValidGeoPoint({ latitude: -3.7, longitude: -38.5 })).toBe(true);
    expect(isValidGeoPoint({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidGeoPoint({ latitude: 0, longitude: 181 })).toBe(false);
    expect(isValidGeoPoint({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(isValidGeoPoint(null)).toBe(false);
  });

  it("arredonda antes de sair do servidor", () => {
    expect(
      coarsenGeoPoint({ latitude: -3.7327891, longitude: -38.5266987 }),
    ).toEqual({ latitude: -3.733, longitude: -38.527 });
  });
});

describe("estado de configuração dos provedores", () => {
  it("nenhuma variável preenchida é NOT_CONFIGURED, não defeito", () => {
    const report = googleCalendarConfiguration({
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(report.state).toBe(PROVIDER_CONFIGURATION_STATES.notConfigured);
    expect(isProviderUsable(report)).toBe(false);
  });

  it("configuração completa é utilizável", () => {
    const report = googleCalendarConfiguration({
      NODE_ENV: "production",
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://escalas.example.com/callback",
      EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: SECRET,
      EXTERNAL_CREDENTIALS_ENCRYPTION_KID: "k1",
    } as NodeJS.ProcessEnv);
    expect(report.state).toBe(PROVIDER_CONFIGURATION_STATES.configured);
    expect(report.missing).toEqual([]);
  });

  it("metade preenchida é MISCONFIGURED e aponta o que falta", () => {
    const report = googleCalendarConfiguration({
      NODE_ENV: "production",
      GOOGLE_OAUTH_CLIENT_ID: "id",
    } as NodeJS.ProcessEnv);
    expect(report.state).toBe(PROVIDER_CONFIGURATION_STATES.misconfigured);
    expect(report.missing).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    expect(report.missing).toContain("GOOGLE_OAUTH_REDIRECT_URI");
  });

  it("OAuth sem chave de criptografia não é utilizável", () => {
    const report = googleCalendarConfiguration({
      NODE_ENV: "production",
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://escalas.example.com/callback",
    } as NodeJS.ProcessEnv);
    expect(report.state).toBe(PROVIDER_CONFIGURATION_STATES.misconfigured);
    expect(report.missing).toContain("EXTERNAL_CREDENTIALS_ENCRYPTION_KEY");
  });

  it("em produção recusa redirect http, localhost e com fragmento", () => {
    for (const redirect of [
      "http://escalas.example.com/callback",
      "https://localhost:3000/callback",
      "https://escalas.example.com/callback#x",
    ]) {
      const report = googleCalendarConfiguration({
        NODE_ENV: "production",
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        GOOGLE_OAUTH_REDIRECT_URI: redirect,
        EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: SECRET,
      } as NodeJS.ProcessEnv);
      expect(report.missing).toContain("GOOGLE_OAUTH_REDIRECT_URI");
    }
  });

  it("fora de produção o redirect local é aceito", () => {
    const report = googleCalendarConfiguration({
      NODE_ENV: "development",
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3000/callback",
    } as NodeJS.ProcessEnv);
    expect(report.state).toBe(PROVIDER_CONFIGURATION_STATES.configured);
  });

  it("Maps e WeatherKit não dependem da chave de criptografia", () => {
    const maps = googleMapsConfiguration({
      NODE_ENV: "production",
      GOOGLE_MAPS_API_KEY: "key",
    } as NodeJS.ProcessEnv);
    const weather = weatherKitConfiguration({
      NODE_ENV: "production",
      WEATHERKIT_TEAM_ID: "t",
      WEATHERKIT_SERVICE_ID: "s",
      WEATHERKIT_KEY_ID: "k",
      WEATHERKIT_PRIVATE_KEY: "pem",
    } as NodeJS.ProcessEnv);
    expect(maps.state).toBe(PROVIDER_CONFIGURATION_STATES.configured);
    expect(weather.state).toBe(PROVIDER_CONFIGURATION_STATES.configured);
  });

  it("nenhum relatório devolve valor de credencial", () => {
    const reports = externalProviderConfigurations({
      NODE_ENV: "production",
      GOOGLE_OAUTH_CLIENT_ID: "id-secreto",
      GOOGLE_MAPS_API_KEY: "chave-secreta",
      WEATHERKIT_PRIVATE_KEY: "pem-secreto",
    } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain("id-secreto");
    expect(serialized).not.toContain("chave-secreta");
    expect(serialized).not.toContain("pem-secreto");
    expect(reports.map((report) => report.provider)).toEqual([
      EXTERNAL_PROVIDERS.googleCalendar,
      EXTERNAL_PROVIDERS.googlePlaces,
      EXTERNAL_PROVIDERS.googleRoutes,
      EXTERNAL_PROVIDERS.weatherKit,
    ]);
  });
});
