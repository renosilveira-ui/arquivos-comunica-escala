import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ProductionBootError,
  assertProductionSecrets,
  collectProductionSecretIssues,
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

  it("o boot loga a lista em vez de engolir o motivo", () => {
    expect(bootSource).toContain("ProductionBootError");
    expect(bootSource).toContain("configurationIssues");
    expect(bootSource).toContain('errorCategory: "configuration"');
  });
});
