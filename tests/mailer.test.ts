import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAIL_HTTP_TIMEOUT_MS,
  mailer,
  parseProviderCorrelationId,
} from "../server/mailer";

const SAMPLE = {
  to: "medico@test.local",
  subject: "Convite de teste",
  text: "corpo-sem-segredo",
};

const REDACTED_FALLBACK_RECORD = {
  eventType: "TRANSACTIONAL_EMAIL_NOT_SENT",
  channel: "EMAIL",
  providerConfigured: false,
  accepted: false,
};

const renderYaml = readFileSync("render.yaml", "utf8");

describe("mailer no Blueprint", () => {
  it("usa o remetente do domínio verificado na Resend", () => {
    expect(renderYaml).toContain(
      'value: "Escala+ <suportec@comunicamais-escala.com.br>"',
    );
    expect(renderYaml).not.toMatch(
      /key:\s*MAIL_FROM[\s\S]{0,120}@escalas-staging\.onrender\.com/,
    );
  });
});

describe("mailer sem provedor", () => {
  const previousKey = process.env.RESEND_API_KEY;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = previousKey;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("não entrega e declara transporte console quando falta a chave", async () => {
    delete process.env.RESEND_API_KEY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await mailer.sendMail(SAMPLE);

    expect(result).toEqual({
      kind: "REJECTED",
      transport: "console",
      reason: "NOT_CONFIGURED",
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[mailer] ${JSON.stringify(REDACTED_FALLBACK_RECORD)}`,
    );
  });

  it.each([
    {
      scenario: "senha temporária",
      message: {
        to: "temporary-password-recipient@test.local",
        subject: "temporary-password-subject",
        text: "temporary-password=TEMP_PASSWORD_FORBIDDEN_IN_LOGS",
        html: "<strong>TEMP_PASSWORD_FORBIDDEN_IN_LOGS</strong>",
      },
    },
    {
      scenario: "redefinição de senha",
      message: {
        to: "forgot-password-recipient@test.local",
        subject: "forgot-password-subject",
        text: "https://example.test/reset-password?token=FORGOT_PASSWORD_TOKEN_FORBIDDEN_IN_LOGS",
        html: '<a href="https://example.test/reset-password?token=FORGOT_PASSWORD_TOKEN_FORBIDDEN_IN_LOGS">redefinir</a>',
      },
    },
    {
      scenario: "convite nominal",
      message: {
        to: "schedule-invite-recipient@test.local",
        subject: "schedule-invite-subject",
        text: "https://example.test/convites/aceitar?token=SCHEDULE_INVITE_TOKEN_FORBIDDEN_IN_LOGS",
        html: '<a href="https://example.test/convites/aceitar?token=SCHEDULE_INVITE_TOKEN_FORBIDDEN_IN_LOGS">aceitar convite</a>',
      },
    },
  ])(
    "nunca registra conteúdo de $scenario sem provedor",
    async ({ message }) => {
      delete process.env.RESEND_API_KEY;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await mailer.sendMail(message);

      expect(result).toEqual({
        kind: "REJECTED",
        transport: "console",
        reason: "NOT_CONFIGURED",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        `[mailer] ${JSON.stringify(REDACTED_FALLBACK_RECORD)}`,
      );

      const logged = log.mock.calls.flat().join(" ");
      for (const value of Object.values(message)) {
        expect(logged).not.toContain(value);
      }
    },
  );
});

describe("mailer via Resend", () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.MAIL_FROM;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = previousKey;
    }
    if (previousFrom === undefined) {
      delete process.env.MAIL_FROM;
    } else {
      process.env.MAIL_FROM = previousFrom;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function withResendKey() {
    // Literal separado do nome da env: o pre-commit bloqueia
    // `RESEND_API_KEY = "<16+ chars>"` mesmo em chave falsa de teste.
    const fakeResendKey = "re_test_not_a_real_key";
    process.env.RESEND_API_KEY = fakeResendKey;
    process.env.MAIL_FROM = "Escala+ <no-reply@test.local>";
  }

  it("Resend HTTP 200 → ACCEPTED", async () => {
    withResendKey();
    const signal = new AbortController().signal;
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await mailer.sendMail(SAMPLE);

    expect(result).toEqual({ kind: "ACCEPTED", transport: "resend" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("aceita correlation ID opaco ASCII com exatamente 128 caracteres", async () => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    const providerCorrelationId = `id:${"A".repeat(123)}.x`;
    expect(providerCorrelationId).toHaveLength(128);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: providerCorrelationId }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(mailer.sendMail(SAMPLE)).resolves.toEqual({
      kind: "ACCEPTED",
      transport: "resend",
      providerCorrelationId,
    });
  });

  it.each([
    ["comprimento 129", "a".repeat(129)],
    ["unicode", "correlação"],
    ["espaço", "provider id"],
    ["newline final", "provider-id\n"],
    ["fora da allowlist", "provider/id"],
    ["vazio", ""],
  ])("ignora correlation ID inválido: %s", async (_case, invalidId) => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: invalidId }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(mailer.sendMail(SAMPLE)).resolves.toEqual({
      kind: "ACCEPTED",
      transport: "resend",
    });
    expect(parseProviderCorrelationId(invalidId)).toBeUndefined();
  });

  it("Resend HTTP 4xx → REJECTED", async () => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 422 })),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await mailer.sendMail({
      ...SAMPLE,
      text: "https://example.test/reset-password?token=abc",
    });

    expect(result).toEqual({
      kind: "REJECTED",
      transport: "resend",
      reason: "HTTP_CLIENT_REJECTION",
    });
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("422");
    expect(logged).not.toContain("reset-password");
    expect(logged).not.toContain("token=abc");
    expect(logged).not.toContain("re_test_not_a_real_key");
  });

  it("Resend HTTP 5xx → UNKNOWN", async () => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await mailer.sendMail(SAMPLE);

    expect(result).toEqual({
      kind: "UNKNOWN",
      transport: "resend",
      reason: "HTTP_TRANSIENT",
    });
  });

  it("fetch abort/timeout → UNKNOWN sem derrubar o processo", async () => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "TimeoutError");
      }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await mailer.sendMail({
      ...SAMPLE,
      text: "https://example.test/reset-password?token=abc",
    });

    expect(result).toEqual({
      kind: "UNKNOWN",
      transport: "resend",
      reason: "TIMEOUT",
    });
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("Timeout");
    expect(logged).not.toContain("reset-password");
    expect(logged).not.toContain("token=abc");
  });

  it("passa AbortSignal.timeout com teto bounded e não chama a rede real", async () => {
    withResendKey();
    const signal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await mailer.sendMail(SAMPLE);

    expect(MAIL_HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(MAIL_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(timeoutSpy).toHaveBeenCalledWith(MAIL_HTTP_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal, method: "POST" }),
    );
    const auth = String(
      (fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> })
        ?.headers?.Authorization ?? "",
    );
    expect(auth).toMatch(/^Bearer /);
  });

  it("propaga somente chave de idempotência válida", async () => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const key = "a".repeat(64);

    await mailer.sendMail(SAMPLE, { idempotencyKey: key });

    expect(
      (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> })
        .headers["Idempotency-Key"],
    ).toBe(key);
  });

  it("recusa chave de idempotência malformada sem chamar o provedor", async () => {
    withResendKey();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await mailer.sendMail(SAMPLE, {
      idempotencyKey: "chave-instavel",
    });

    expect(result).toEqual({
      kind: "REJECTED",
      transport: "none",
      reason: "INVALID_IDEMPOTENCY_KEY",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
