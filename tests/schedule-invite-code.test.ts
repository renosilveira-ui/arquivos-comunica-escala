import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatScheduleInviteCode,
  deriveScheduleInviteCode,
  generateScheduleInviteCode,
  generateScheduleInviteOpaqueToken,
  hashScheduleInviteRecipientBinding,
  hashLegacyScheduleInviteCode,
  hashScheduleInviteCodeV2,
  isScheduleInviteOpaqueToken,
  normalizeScheduleInviteCode,
  scheduleInvitePepperKeyId,
  SCHEDULE_INVITE_HASH_VERSION,
} from "../lib/schedule-invite-code";
import {
  getScheduleInviteHashPolicy,
  ScheduleInviteCodeConfigurationError,
} from "../server/schedule-invite-code-policy";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

describe("código de convite de escala", () => {
  it("config pure fornece pepper dedicado sem carregar setup de banco", () => {
    const config = readFileSync("vitest.pure.config.ts", "utf8");
    expect(config).toContain("SCHEDULE_INVITE_CODE_PEPPER");
    expect(config).toContain("pure-test-only-schedule-invite-pepper");
    expect(config).toContain("setupFiles: []");
    expect(config).not.toContain("setup-tests");
  });

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

  it("mantém SHA-256 somente para linhas legadas explicitamente V1", () => {
    const normalized = "ABCD2345";
    expect(hashLegacyScheduleInviteCode(normalized)).toBe(
      createHash("sha256").update(normalized).digest("hex"),
    );
    expect(formatScheduleInviteCode(normalized)).toBe("ABCD-2345");
    expect(() => hashLegacyScheduleInviteCode("SHORT")).toThrow(
      /tamanho inválido/,
    );
  });

  it("usa HMAC-SHA-256 com domínio e pepper na versão corrente", () => {
    const normalized = "ABCD2345";
    const pepper = "pepper-corrente-de-teste-com-mais-de-32-bytes";
    expect(hashScheduleInviteCodeV2(normalized, pepper)).toBe(
      createHmac("sha256", pepper)
        .update("escala:schedule-invite-code:v2\0")
        .update(normalized)
        .digest("hex"),
    );
    expect(hashScheduleInviteCodeV2(normalized, pepper)).not.toBe(
      hashLegacyScheduleInviteCode(normalized),
    );
    expect(() => hashScheduleInviteCodeV2("SHORT", pepper)).toThrow(
      /tamanho inválido/,
    );
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

  it("deriva o mesmo código por geração sem guardar o código no outbox", () => {
    const pepper = "pepper-corrente-de-teste-com-mais-de-32-bytes";
    const nonce = "a".repeat(64);
    const input = {
      institutionId: 1,
      hospitalId: 2,
      sectorId: 3,
      invitedUserId: 4,
      generation: 5,
      nonce,
    };
    const first = deriveScheduleInviteCode(input, pepper);
    expect(first).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(deriveScheduleInviteCode(input, pepper)).toBe(first);
    expect(
      deriveScheduleInviteCode({ ...input, generation: 6 }, pepper),
    ).not.toBe(first);
    expect(generateScheduleInviteOpaqueToken()).toMatch(/^[a-f0-9]{64}$/);
    expect(scheduleInvitePepperKeyId(pepper)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      hashScheduleInviteRecipientBinding(" MEDICO@Test.Local ", pepper),
    ).toBe(hashScheduleInviteRecipientBinding("medico@test.local", pepper));
  });

  it("aceita somente material opaco hexadecimal minúsculo de 32 bytes", () => {
    expect(isScheduleInviteOpaqueToken("a".repeat(64))).toBe(true);
    expect(isScheduleInviteOpaqueToken("A".repeat(64))).toBe(false);
    expect(isScheduleInviteOpaqueToken("a".repeat(63))).toBe(false);
    expect(isScheduleInviteOpaqueToken(`${"a".repeat(64)}\n`)).toBe(false);
    expect(isScheduleInviteOpaqueToken("g".repeat(64))).toBe(false);
    expect(isScheduleInviteOpaqueToken(null)).toBe(false);
  });

  it("falha fechado se o pepper corrente estiver ausente, curto ou reutilizado", () => {
    expect(() => getScheduleInviteHashPolicy({})).toThrow(
      ScheduleInviteCodeConfigurationError,
    );
    expect(() =>
      getScheduleInviteHashPolicy({
        SCHEDULE_INVITE_CODE_PEPPER: "curto",
      }),
    ).toThrow(ScheduleInviteCodeConfigurationError);
    expect(() =>
      getScheduleInviteHashPolicy({
        SCHEDULE_INVITE_CODE_PEPPER:
          "changeme_dedicated_min_32_bytes_here",
      }),
    ).toThrow(ScheduleInviteCodeConfigurationError);
    const reused = "segredo-reutilizado-com-mais-de-trinta-e-dois-bytes";
    expect(() =>
      getScheduleInviteHashPolicy({
        SCHEDULE_INVITE_CODE_PEPPER: reused,
        COOKIE_SECRET: reused,
      }),
    ).toThrow(ScheduleInviteCodeConfigurationError);
    expect(() =>
      getScheduleInviteHashPolicy({
        SCHEDULE_INVITE_CODE_PEPPER: reused,
        TWILIO_AUTH_TOKEN: reused,
      }),
    ).toThrow(ScheduleInviteCodeConfigurationError);
    expect(() =>
      getScheduleInviteHashPolicy({
        SCHEDULE_INVITE_CODE_PEPPER: reused,
        JWT_SECRET: reused,
      }),
    ).toThrow(ScheduleInviteCodeConfigurationError);
  });

  it("rotaciona com pepper anterior e inclui compatibilidade V1 explícita", () => {
    const current = "pepper-atual-de-teste-com-mais-de-trinta-dois-bytes";
    const previous = "pepper-anterior-de-teste-com-mais-de-trinta-dois-bytes";
    const normalized = "ABCD2345";
    const policy = getScheduleInviteHashPolicy({
      SCHEDULE_INVITE_CODE_PEPPER: current,
      SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER: previous,
    });

    expect(policy.write.version).toBe(
      SCHEDULE_INVITE_HASH_VERSION.HMAC_SHA256,
    );
    expect(policy.write.hash(normalized)).toBe(
      hashScheduleInviteCodeV2(normalized, current),
    );
    expect(policy.lookup(normalized)).toEqual([
      {
        version: SCHEDULE_INVITE_HASH_VERSION.HMAC_SHA256,
        hash: hashScheduleInviteCodeV2(normalized, current),
      },
      {
        version: SCHEDULE_INVITE_HASH_VERSION.HMAC_SHA256,
        hash: hashScheduleInviteCodeV2(normalized, previous),
      },
      {
        version: SCHEDULE_INVITE_HASH_VERSION.LEGACY_SHA256,
        hash: hashLegacyScheduleInviteCode(normalized),
      },
    ]);
    expect(policy.outbox.resolve(policy.outbox.current.keyId)).toBe(
      policy.outbox.current,
    );
    const previousKeyId = scheduleInvitePepperKeyId(previous);
    expect(policy.outbox.resolve(previousKeyId)?.keyId).toBe(previousKeyId);
    expect(policy.outbox.resolve("f".repeat(64))).toBeNull();
  });

  it("recusa rotação ambígua ou pepper anterior inválido", () => {
    const current = "pepper-atual-de-teste-com-mais-de-trinta-dois-bytes";
    expect(() =>
      getScheduleInviteHashPolicy({
        SCHEDULE_INVITE_CODE_PEPPER: current,
        SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER: current,
      }),
    ).toThrow(ScheduleInviteCodeConfigurationError);
    expect(() =>
      getScheduleInviteHashPolicy({
        SCHEDULE_INVITE_CODE_PEPPER: current,
        SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER: "curto",
      }),
    ).toThrow(ScheduleInviteCodeConfigurationError);
  });
});
