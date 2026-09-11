import { describe, expect, it } from "vitest";
import { fingerprintScheduleInviteProviderRequest } from "../server/schedule-invite-provider-request";

const base = {
  to: "destinatario@example.test",
  subject: "Convite para Hospital A — Setor B",
  text: "Corpo canônico com link e código",
  html: "<p>Corpo canônico</p>",
};
const pepper = "test-only-provider-fingerprint-pepper-32-bytes";

describe("fingerprint do request do provedor de convite", () => {
  it("é determinístico e opaco para o mesmo request completo", () => {
    const first = fingerprintScheduleInviteProviderRequest(base, pepper, {
      MAIL_FROM: "Escala+ <convites@example.test>",
    });
    const second = fingerprintScheduleInviteProviderRequest(
      { ...base },
      pepper,
      { MAIL_FROM: " Escala+ <convites@example.test> " },
    );

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(first).not.toContain(base.to);
  });

  it.each([
    ["destinatário", { ...base, to: "outro@example.test" }, {}],
    ["assunto/nome", { ...base, subject: `${base.subject} alterado` }, {}],
    ["corpo/link", { ...base, text: `${base.text} alterado` }, {}],
    ["html", { ...base, html: `${base.html} alterado` }, {}],
    ["remetente", base, { MAIL_FROM: "Outro <outro@example.test>" }],
  ] as const)("muda quando %s muda", (_label, message, env) => {
    const expected = fingerprintScheduleInviteProviderRequest(base, pepper, {
      MAIL_FROM: "Escala+ <convites@example.test>",
    });
    expect(
      fingerprintScheduleInviteProviderRequest(message, pepper, {
        MAIL_FROM: env.MAIL_FROM ?? "Escala+ <convites@example.test>",
      }),
    ).not.toBe(expected);
  });

  it("é vinculado ao pepper sem persistir a chave", () => {
    const first = fingerprintScheduleInviteProviderRequest(base, pepper);
    const rotated = fingerprintScheduleInviteProviderRequest(
      base,
      `${pepper}-rotated`,
    );
    expect(rotated).not.toBe(first);
  });
});
