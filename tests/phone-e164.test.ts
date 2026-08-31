import { describe, expect, it } from "vitest";
import { maskE164, normalizeToE164 } from "../lib/phone-e164";

describe("normalizeToE164 (WhatsApp)", () => {
  it("BR sem DDI → E.164 canônico", () => {
    const a = normalizeToE164("85999999999");
    const b = normalizeToE164("(85) 99999-9999");
    expect(a).toEqual({
      ok: true,
      e164: "+5585999999999",
      displayInput: "85999999999",
    });
    expect(b.ok && b.e164).toBe("+5585999999999");
  });

  it("número já em E.164 é preservado", () => {
    const r = normalizeToE164("+5585999999999");
    expect(r).toMatchObject({ ok: true, e164: "+5585999999999" });
  });

  it("formato inválido falha", () => {
    expect(normalizeToE164("123").ok).toBe(false);
    expect(normalizeToE164("").ok).toBe(false);
    expect(normalizeToE164("abcd").ok).toBe(false);
  });

  it("internacional explícito não é forçado para BR", () => {
    const us = normalizeToE164("+14155552671");
    expect(us.ok && us.e164).toBe("+14155552671");
  });

  it("normalização é determinística entre formatos BR", () => {
    const variants = [
      "85999999999",
      "(85) 99999-9999",
      "+55 85 99999-9999",
      "55 85 99999-9999",
    ];
    const e164s = variants.map((v) => normalizeToE164(v));
    for (const r of e164s) {
      expect(r.ok && r.e164).toBe("+5585999999999");
    }
  });

  it("mascara E.164 sem expor o número completo", () => {
    const masked = maskE164("+5585999999999");
    expect(masked).toBe("+55 85 *****-9999");
    expect(masked).not.toContain("99999");
  });
});
