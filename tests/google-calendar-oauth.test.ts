import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_OAUTH_RETURN_TARGETS,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  createPkcePair,
  hashOAuthState,
  isGoogleOAuthReturnTarget,
  readGoogleOAuthConfig,
  statesMatch,
} from "../server/integrations/google/oauth";
import {
  ESCALA_SOURCE_PROPERTY,
  parseGoogleEvent,
} from "../server/integrations/google/calendar-client";
import {
  ESCALA_ORIGIN_MARKER,
  fingerprintEvent,
} from "../server/integrations/google/sync";

const oauthSource = readFileSync(
  new URL("../server/integrations/google/oauth.ts", import.meta.url),
  "utf8",
);
const clientSource = readFileSync(
  new URL("../server/integrations/google/calendar-client.ts", import.meta.url),
  "utf8",
);
const callbackSource = readFileSync(
  new URL("../server/routes/google.ts", import.meta.url),
  "utf8",
);

describe("PKCE", () => {
  it("gera verifier dentro do intervalo do RFC 7636 e challenge S256 correto", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });

  it("cada par é único", () => {
    const first = createPkcePair();
    const second = createPkcePair();
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(second.challenge);
  });
});

describe("state do OAuth", () => {
  it("é guardado como hash, nunca em claro", () => {
    const state = "estado-de-teste";
    const hash = hashOAuthState(state);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(state);
  });

  it("a comparação é em tempo constante e não vaza por tamanho", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
  });

  it("o destino de retorno é uma allowlist, nunca URL", () => {
    expect(isGoogleOAuthReturnTarget("WEB")).toBe(true);
    expect(isGoogleOAuthReturnTarget("MOBILE")).toBe(true);
    expect(isGoogleOAuthReturnTarget("https://evil.example")).toBe(false);
    expect(isGoogleOAuthReturnTarget("")).toBe(false);
    expect(isGoogleOAuthReturnTarget(null)).toBe(false);
    expect(Object.values(GOOGLE_OAUTH_RETURN_TARGETS)).toEqual([
      "WEB",
      "MOBILE",
    ]);
  });
});

describe("configuração do provedor", () => {
  it("exige as três variáveis", () => {
    expect(
      readGoogleOAuthConfig({
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("em produção recusa redirect que não seja https", () => {
    expect(
      readGoogleOAuthConfig({
        NODE_ENV: "production",
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        GOOGLE_OAUTH_REDIRECT_URI: "http://app.example/callback",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("fora de produção aceita redirect local", () => {
    expect(
      readGoogleOAuthConfig({
        NODE_ENV: "development",
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3000/callback",
      } as NodeJS.ProcessEnv),
    ).not.toBeNull();
  });

  it("recusa redirect que não é URL", () => {
    expect(
      readGoogleOAuthConfig({
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        GOOGLE_OAUTH_REDIRECT_URI: "nao-e-url",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("superfície de rede — nenhuma URL vem de fora", () => {
  /**
   * A defesa contra SSRF aqui não é sanitização: é não existir caminho em que
   * um valor externo escolha host. Todo endpoint é constante do módulo.
   */
  it("os endpoints do OAuth são constantes do Google", () => {
    expect(GOOGLE_AUTH_ENDPOINT).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(GOOGLE_TOKEN_ENDPOINT).toBe("https://oauth2.googleapis.com/token");
    expect(GOOGLE_REVOKE_ENDPOINT).toBe("https://oauth2.googleapis.com/revoke");
  });

  it("nenhum fetch monta URL a partir de variável livre", () => {
    for (const source of [oauthSource, clientSource]) {
      const fetches = source.match(/fetch\(\s*([^,)]+)/g) ?? [];
      for (const call of fetches) {
        // Só constantes do módulo ou template com `CALENDAR_API`/endpoint.
        expect(call).toMatch(
          /fetch\(\s*(endpoint|url|GOOGLE_[A-Z_]+_ENDPOINT|`\$\{CALENDAR_API)/,
        );
      }
    }
  });

  it("todo identificador no path passa por encodeURIComponent", () => {
    const paths = clientSource.match(/\$\{CALENDAR_API\}[^`]*/g) ?? [];
    for (const path of paths) {
      const interpolations = path.match(/\$\{(?!CALENDAR_API)[^}]+\}/g) ?? [];
      for (const interpolation of interpolations) {
        expect(
          interpolation,
          `${interpolation} precisa ser codificado`,
        ).toContain("encodeURIComponent");
      }
    }
  });

  it("as chamadas têm timeout e teto de resposta", () => {
    expect(clientSource).toContain("AbortController");
    expect(clientSource).toContain("MAX_RESPONSE_BYTES");
    expect(oauthSource).toContain("AbortController");
  });
});

describe("callback é a fronteira inteira", () => {
  it("consome o state antes de qualquer outra decisão", () => {
    const consumeIndex = callbackSource.indexOf(
      "consumeGoogleAuthorizationState",
    );
    const errorIndex = callbackSource.indexOf('typeof rawError === "string"');
    const exchangeIndex = callbackSource.indexOf(
      "exchangeGoogleAuthorizationCode",
    );
    expect(consumeIndex).toBeGreaterThan(0);
    // Um state que chegou aqui foi gasto, mesmo que o usuário tenha recusado.
    expect(consumeIndex).toBeLessThan(errorIndex);
    expect(consumeIndex).toBeLessThan(exchangeIndex);
  });

  it("nenhum parâmetro da query escolhe destino de redirecionamento", () => {
    const redirects = callbackSource.match(/res\.redirect\([^)]*\)/g) ?? [];
    expect(redirects.length).toBeGreaterThan(0);
    for (const redirect of redirects) {
      expect(redirect).not.toContain("req.query");
      expect(redirect).not.toContain("req.headers");
    }
    expect(callbackSource).toContain("resolveTrustedPublicBaseUrl");
  });

  it("só grava o vínculo depois de conferir o escopo de criação de calendário", () => {
    const scopeCheck = callbackSource.lastIndexOf("canCreateDedicatedCalendar(");
    const persist = callbackSource.lastIndexOf("persistGoogleAuthorization(");
    expect(scopeCheck).toBeGreaterThan(0);
    expect(scopeCheck).toBeLessThan(persist);
    // O fuso do calendário dedicado vem da conta, não de uma constante.
    expect(callbackSource).toContain("resolveUserTimeZone(");
    expect(callbackSource).not.toContain('timeZone: "America/Sao_Paulo"');
  });

  it("não registra code, state nem token em log", () => {
    const logs = callbackSource.match(/logger\.[a-z]+\([\s\S]*?\)/g) ?? [];
    for (const entry of logs) {
      expect(entry).not.toMatch(/rawCode|rawState|accessToken|refreshToken/);
    }
  });
});

describe("marcador de origem — impede laço de sincronização", () => {
  it("o evento que criamos carrega o marcador nas propriedades privadas", () => {
    const parsed = parseGoogleEvent({
      id: "ev1",
      etag: "etag1",
      summary: "Plantão · UTI · HSC",
      start: { dateTime: "2026-09-11T11:00:00Z" },
      end: { dateTime: "2026-09-11T23:00:00Z" },
      extendedProperties: {
        private: { [ESCALA_SOURCE_PROPERTY]: ESCALA_ORIGIN_MARKER },
      },
    });
    expect(parsed?.originMarker).toBe(ESCALA_ORIGIN_MARKER);
  });

  it("evento do próprio usuário chega sem marcador", () => {
    const parsed = parseGoogleEvent({
      id: "ev2",
      summary: "Consulta do usuário",
      start: { dateTime: "2026-09-11T11:00:00Z" },
      end: { dateTime: "2026-09-11T12:00:00Z" },
    });
    expect(parsed?.originMarker).toBeNull();
  });

  it("dia inteiro é reconhecido pelo campo date", () => {
    const parsed = parseGoogleEvent({
      id: "ev3",
      summary: "Feriado",
      start: { date: "2026-09-07" },
      end: { date: "2026-09-08" },
    });
    expect(parsed?.allDay).toBe(true);
  });

  it("evento cancelado é reconhecido e não inventa horário", () => {
    const parsed = parseGoogleEvent({ id: "ev4", status: "cancelled" });
    expect(parsed?.cancelled).toBe(true);
    expect(parsed?.startsAtUtc.getTime()).toBe(0);
  });

  it("transparency=transparent significa não ocupado", () => {
    const parsed = parseGoogleEvent({
      id: "ev5",
      summary: "Sobreaviso",
      transparency: "transparent",
      start: { dateTime: "2026-09-11T11:00:00Z" },
      end: { dateTime: "2026-09-11T12:00:00Z" },
    });
    expect(parsed?.busy).toBe(false);
  });

  it("payload inválido não vira evento", () => {
    expect(parseGoogleEvent(null)).toBeNull();
    expect(parseGoogleEvent({})).toBeNull();
    expect(parseGoogleEvent({ id: 42 })).toBeNull();
  });
});

describe("fingerprint de conteúdo", () => {
  it("o mesmo conteúdo produz o mesmo fingerprint", () => {
    const base = {
      summary: "Plantão · UTI",
      startsAtUtc: new Date("2026-09-11T11:00:00Z"),
      endsAtUtc: new Date("2026-09-11T23:00:00Z"),
      allDay: false,
      busy: true,
      timeZone: "America/Sao_Paulo",
    };
    expect(fingerprintEvent(base)).toBe(fingerprintEvent({ ...base }));
  });

  it("cada campo relevante muda o fingerprint", () => {
    const base = {
      summary: "Plantão · UTI",
      startsAtUtc: new Date("2026-09-11T11:00:00Z"),
      endsAtUtc: new Date("2026-09-11T23:00:00Z"),
      allDay: false,
      busy: true,
      timeZone: "America/Sao_Paulo",
    };
    const reference = fingerprintEvent(base);
    expect(fingerprintEvent({ ...base, summary: "Outro" })).not.toBe(reference);
    expect(
      fingerprintEvent({
        ...base,
        startsAtUtc: new Date("2026-09-11T12:00:00Z"),
      }),
    ).not.toBe(reference);
    expect(fingerprintEvent({ ...base, busy: false })).not.toBe(reference);
    expect(fingerprintEvent({ ...base, allDay: true })).not.toBe(reference);
    expect(fingerprintEvent({ ...base, timeZone: "America/Manaus" })).not.toBe(
      reference,
    );
  });
});

describe("privacidade do que é exportado", () => {
  /**
   * O calendário do Google é superfície fora do nosso controle. O título do
   * plantão leva modalidade, setor e hospital — nada de paciente, nada de
   * conteúdo clínico.
   */
  it("o título do plantão é montado só com setor, hospital e modalidade", () => {
    const syncSource = readFileSync(
      new URL("../server/integrations/google/sync.ts", import.meta.url),
      "utf8",
    );
    const titleLine = syncSource.match(/summary: `\$\{modalityLabel\}[^`]*`/);
    expect(titleLine).not.toBeNull();
    expect(titleLine?.[0]).toContain("sectorName");
    expect(titleLine?.[0]).toContain("hospitalName");
    expect(titleLine?.[0]).not.toContain("patient");
    expect(titleLine?.[0]).not.toContain("notes");
  });

  it("a exportação não lê notes do compromisso pessoal", () => {
    const syncSource = readFileSync(
      new URL("../server/integrations/google/sync.ts", import.meta.url),
      "utf8",
    );
    expect(syncSource).not.toMatch(/\bnotes\b/);
  });
});
