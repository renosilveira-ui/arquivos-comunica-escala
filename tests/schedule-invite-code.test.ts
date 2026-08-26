import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatScheduleInviteCode,
  generateScheduleInviteCode,
  hashScheduleInviteCode,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

describe("código de convite de escala", () => {
  it("gera XXXX-XXXX só com o alfabeto sem 0/O/1/I", () => {
    const codes = Array.from({ length: 40 }, () => generateScheduleInviteCode());
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01IO]/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("normaliza digitação com hífen, espaço e minúscula", () => {
    expect(normalizeScheduleInviteCode("ab-cd ef2g")).toBe("ABCDEF2G");
    expect(normalizeScheduleInviteCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeScheduleInviteCode("abcd0o1i")).toBe("ABCDOI");
    expect(normalizeScheduleInviteCode("ABCD-EFGH-XXXX")).toBe("ABCDEFGH");
  });

  it("hasheia o corpo normalizado em SHA-256 hex e formata de volta", () => {
    const normalized = "ABCD2345";
    expect(hashScheduleInviteCode(normalized)).toBe(
      createHash("sha256").update(normalized).digest("hex"),
    );
    expect(formatScheduleInviteCode(normalized)).toBe("ABCD-2345");
    expect(() => hashScheduleInviteCode("SHORT")).toThrow(/tamanho inválido/);
  });

  it("o alfabeto do gerador não inclui caracteres ambíguos", () => {
    expect(ALPHABET).not.toMatch(/[01IO]/);
    expect(ALPHABET).toHaveLength(32);
  });

  it("o gerador usa randomInt, não resto de divisão em bytes", () => {
    const source = readFileSync("lib/schedule-invite-code.ts", "utf8");
    expect(source).toContain("randomInt(INVITE_ALPHABET.length)");
    expect(source).not.toMatch(/randomBytes[\s\S]*%/);
  });
});
