import { afterEach, describe, expect, it, vi } from "vitest";
import { mailer } from "../server/mailer";

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

    const result = await mailer.sendMail({
      to: "medico@test.local",
      subject: "Convite de teste",
      text: "corpo",
    });

    expect(result).toEqual({ delivered: false, transport: "console" });
    expect(log.mock.calls.join("\n")).toContain("sem RESEND_API_KEY");
    expect(log.mock.calls.join("\n")).toContain("e-mail NÃO enviado");
  });
});
