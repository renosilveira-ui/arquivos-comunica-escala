import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ProductionBootError,
  assertProductionSecrets,
  collectExternalIntegrationWarnings,
  collectProductionSecretIssues,
  describeExternalIntegrations,
} from "../server/_core/env-validation";

const bootSource = readFileSync(
  new URL("../server/_core/index.ts", import.meta.url),
  "utf8",
);

/**
 * Em 10/09 o staging ficou horas fora do ar porque o servidor recusava subir
 * e o log dizia apenas `errorCategory: "application"`. A recusa estava certa;
 * o silêncio sobre o motivo é que custou a noite.
 *
 * Estes testes fixam as duas metades do contrato: a lista de problemas
 * precisa NOMEAR a variável, e não pode conter o VALOR de nenhuma.
 */

const SECRET_VALUES = {
  COOKIE_SECRET: "cookie-secret-com-32-bytes-no-minimo-aqui",
  DATABASE_URL: "mysql://usuario:senha-secreta@db.interno:3306/escalas",
  AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET: "chave-de-recuperacao-secreta-32b+",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-do-google",
  GOOGLE_MAPS_API_KEY: "AIzaChaveSecretaDoMaps",
  WEATHERKIT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----segredo-----END-----",
  EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: "chave-externa-secreta-com-32-bytes++",
};

describe("diagnóstico de boot em produção", () => {
  it("nomeia a variável que falta em vez de falhar em silêncio", () => {
    const issues = collectProductionSecretIssues({
      env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
    });
    expect(issues.join("\n")).toContain("COOKIE_SECRET");
    expect(issues.join("\n")).toContain("DATABASE_URL");
    expect(issues.join("\n")).toContain("AUTH_RECOVERY_ENCRYPTION_CURRENT_KID");
    expect(issues.join("\n")).toContain(
      "AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET",
    );
  });

  it("aponta o par incompleto de rotação, que derruba o boot sem ser obrigatório", () => {
    const issues = collectProductionSecretIssues({
      env: {
        NODE_ENV: "production",
        COOKIE_SECRET: SECRET_VALUES.COOKIE_SECRET,
        DATABASE_URL: SECRET_VALUES.DATABASE_URL,
        AUTH_RECOVERY_ENCRYPTION_CURRENT_KID: "v1",
        AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET:
          SECRET_VALUES.AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET,
        // Só a metade anterior preenchida: configuração que parece inofensiva
        // e recusa o boot.
        AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID: "v0",
      } as NodeJS.ProcessEnv,
    });
    expect(issues.join("\n")).toContain(
      "AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID and SECRET must be set together",
    );
  });

  /**
   * A propriedade que torna seguro logar a lista. Se algum dia alguém
   * interpolar `value` em vez de `key` numa mensagem, este teste quebra
   * antes de a credencial chegar ao log.
   */
  it("nenhuma mensagem carrega o valor de uma credencial", () => {
    const env = {
      NODE_ENV: "production",
      ...SECRET_VALUES,
      // Erros de propósito, para gerar o máximo de mensagens possível.
      AUTH_RECOVERY_ENCRYPTION_CURRENT_KID: "kid inválido com espaço",
      AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET: "curto",
      EXPO_PUBLIC_API_URL: "http://localhost:3000",
      GOOGLE_OAUTH_CLIENT_ID: "id-publico",
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3000/callback",
    } as NodeJS.ProcessEnv;

    const issues = collectProductionSecretIssues({ env });
    expect(issues.length).toBeGreaterThan(0);

    const joined = issues.join("\n");
    for (const [key, value] of Object.entries(SECRET_VALUES)) {
      expect(joined, `${key} não pode aparecer no diagnóstico`).not.toContain(
        value,
      );
    }
  });

  it("ProductionBootError preserva a lista para quem for logar", () => {
    try {
      assertProductionSecrets({
        env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
      });
      throw new Error("deveria ter recusado o boot");
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionBootError);
      expect((error as ProductionBootError).issues.length).toBeGreaterThan(0);
    }
  });

  /**
   * Uma chave de previsão do tempo faltando não pode derrubar o sistema de
   * escala de um hospital. A recusa de boot fica só onde importa — segredo
   * de sessão e banco.
   */
  it("integração pela metade NÃO impede o boot", () => {
    const issues = collectProductionSecretIssues({
      env: {
        NODE_ENV: "production",
        COOKIE_SECRET: SECRET_VALUES.COOKIE_SECRET,
        DATABASE_URL: SECRET_VALUES.DATABASE_URL,
        AUTH_RECOVERY_ENCRYPTION_CURRENT_KID: "v1",
        AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET:
          SECRET_VALUES.AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET,
        // WeatherKit e Google pela metade, de propósito.
        WEATHERKIT_TEAM_ID: "T",
        GOOGLE_OAUTH_CLIENT_ID: "id",
      } as NodeJS.ProcessEnv,
    });
    expect(issues).toEqual([]);
  });

  it("mas o boot avisa, nomeando a variável incompleta", () => {
    const warnings = collectExternalIntegrationWarnings({
      NODE_ENV: "production",
      WEATHERKIT_TEAM_ID: "T",
    } as NodeJS.ProcessEnv);
    expect(warnings.join("\n")).toContain("WEATHERKIT_SERVICE_ID");
    expect(warnings.join("\n")).toContain("unavailable");
  });

  it("o aviso também não carrega valor de credencial", () => {
    const warnings = collectExternalIntegrationWarnings({
      NODE_ENV: "production",
      ...SECRET_VALUES,
      WEATHERKIT_TEAM_ID: "T",
    } as NodeJS.ProcessEnv);
    const joined = warnings.join("\n");
    for (const [key, value] of Object.entries(SECRET_VALUES)) {
      expect(joined, `${key} não pode aparecer no aviso`).not.toContain(value);
    }
  });

  it("o boot loga a lista em vez de engolir o motivo", () => {
    expect(bootSource).toContain("ProductionBootError");
    expect(bootSource).toContain("configurationIssues");
    expect(bootSource).toContain('errorCategory: "configuration"');
    expect(bootSource).toContain("collectExternalIntegrationWarnings");
  });
});

/**
 * O aviso de integração só fala quando a configuração está pela METADE. Um
 * provedor de chave única — Google Maps — nunca fica pela metade, então sua
 * ausência era invisível de fora: descobrir se a chave estava lá exigia
 * adivinhar. Adivinhar sobre configuração foi o que custou 3h16 de staging.
 */
describe("estado das integrações no boot", () => {
  const KEYS = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
    "GOOGLE_MAPS_API_KEY",
    "WEATHERKIT_TEAM_ID",
    "WEATHERKIT_SERVICE_ID",
    "WEATHERKIT_KEY_ID",
    "WEATHERKIT_PRIVATE_KEY",
  ] as const;

  function envWithout(...omit: string[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const key of KEYS) {
      if (omit.includes(key)) continue;
      env[key] =
        key === "WEATHERKIT_PRIVATE_KEY"
          ? "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----"
          : key === "GOOGLE_OAUTH_REDIRECT_URI"
            ? "https://exemplo.test/api/integrations/google/callback"
            : "valor";
    }
    return env;
  }

  it("relata um estado por provedor, e nenhum valor", () => {
    const summary = describeExternalIntegrations(envWithout());
    const providers = Object.keys(summary).sort();
    expect(providers.length).toBeGreaterThanOrEqual(3);
    for (const state of Object.values(summary)) {
      expect(state).toMatch(/^(CONFIGURED|NOT_CONFIGURED|MISCONFIGURED)$/);
    }
    // Nenhum valor de variável pode vazar para o resumo.
    expect(JSON.stringify(summary)).not.toContain("valor");
    expect(JSON.stringify(summary)).not.toContain("BEGIN PRIVATE KEY");
  });

  /** O caso que motivou existir: chave única ausente, antes invisível. */
  it("torna visível a ausência de um provedor de chave única", () => {
    const comMaps = describeExternalIntegrations(envWithout());
    const semMaps = describeExternalIntegrations(
      envWithout("GOOGLE_MAPS_API_KEY"),
    );
    const provider = Object.keys(comMaps).find(
      (k) => comMaps[k] !== semMaps[k],
    );
    expect(provider, "a diferença precisa aparecer").toBeTruthy();
    expect(semMaps[provider!]).toBe("NOT_CONFIGURED");
    expect(comMaps[provider!]).toBe("CONFIGURED");
    // E o aviso de "pela metade" continua calado nesse caso — por isso o
    // resumo precisa existir.
    expect(
      collectExternalIntegrationWarnings(
        envWithout("GOOGLE_MAPS_API_KEY"),
      ).join(" "),
    ).not.toContain("GOOGLE_MAPS_API_KEY");
  });

  it("o boot registra o resumo", () => {
    expect(bootSource).toContain("describeExternalIntegrations");
    expect(bootSource).toContain("external_integrations");
  });
});
