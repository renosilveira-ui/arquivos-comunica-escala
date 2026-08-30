import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIL_HTTP_TIMEOUT_MS, mailer } from "../server/mailer";

const SAMPLE = {
  to: "medico@test.local",
  subject: "Convite de teste",
  text: "corpo-sem-segredo",
};

describe("mailer sem provedor", () => {
  const previousKey = process.env.RESEND_API_KEY;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = previousKey;
    }
    vi.restoreAllMocks();
  });

  it("não entrega e declara transporte console quando falta a chave", async () => {
    delete process.env.RESEND_API_KEY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await mailer.sendMail(SAMPLE);

    expect(result).toEqual({ delivered: false, transport: "console" });
    expect(log.mock.calls.join("\n")).toContain("sem RESEND_API_KEY");
    expect(log.mock.calls.join("\n")).toContain("e-mail NÃO enviado");
  });
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

  it("Resend HTTP 200 → delivered true", async () => {
    withResendKey();
    const signal = new AbortController().signal;
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await mailer.sendMail(SAMPLE);

    expect(result).toEqual({ delivered: true, transport: "resend" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("Resend HTTP 4xx → delivered false", async () => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
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
      delivered: false,
      transport: "resend",
      error: "HTTP 422",
    });
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("422");
    expect(logged).not.toContain("reset-password");
    expect(logged).not.toContain("token=abc");
    expect(logged).not.toContain("re_test_not_a_real_key");
  });

  it("Resend HTTP 5xx → delivered false", async () => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await mailer.sendMail(SAMPLE);

    expect(result).toEqual({
      delivered: false,
      transport: "resend",
      error: "HTTP 503",
    });
  });

  it("fetch abort/timeout → delivered false sem derrubar o processo", async () => {
    withResendKey();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
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
      delivered: false,
      transport: "resend",
      error: "TIMEOUT",
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
});
