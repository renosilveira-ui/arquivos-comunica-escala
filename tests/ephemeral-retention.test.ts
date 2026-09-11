import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import {
  googleOauthStates,
  institutions,
  passwordResets,
  ssoLaunchCodes,
  ssoUsedTokens,
  users,
} from "../drizzle/schema";
import {
  EPHEMERAL_RETENTION_GRACE_MS,
  sweepEphemeralRecords,
} from "../server/cron/ephemeral-retention-dispatcher";
import { getDb } from "../server/db";

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const NOW = new Date("2026-09-12T12:00:00.000Z");
const hours = (n: number) => n * 3_600_000;
const at = (n: number) => new Date(NOW.getTime() + hours(n));

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * O que a varredura apaga e, mais importante, o que ela NÃO apaga: nada
 * com validade futura, nada vencido há menos de 24 h. Cada tabela é
 * verificada com um vencido antigo (sai), um vencido recente (fica) e um
 * válido (fica).
 */
describe("varredura de efêmeros vencidos", () => {
  let db: Db;
  let userId = 0;
  let institutionId = 0;
  const markers = {
    old: `old-${stamp}`,
    recent: `recent-${stamp}`,
    valid: `valid-${stamp}`,
  };

  beforeAll(async () => {
    const loaded = await getDb();
    if (!loaded) throw new Error("Banco de testes indisponível");
    db = loaded;
    const [user] = await db.insert(users).values({
      name: `Efêmero ${stamp}`,
      email: `efemero-${stamp}@test.local`,
      password: "x".repeat(20),
      role: "doctor",
    });
    userId = user.insertId;
    const [institution] = await db.insert(institutions).values({
      name: `Inst efêmero ${stamp}`,
      cnpj: `${stamp}9`.slice(-14).padStart(14, "0"),
      timeZone: "America/Sao_Paulo",
    });
    institutionId = institution.insertId;

    const rows = [
      { key: "old", expiresAt: at(-30) },
      { key: "recent", expiresAt: at(-2) },
      { key: "valid", expiresAt: at(+2) },
    ] as const;
    for (const row of rows) {
      const marker = markers[row.key];
      await db.insert(passwordResets).values({
        userId,
        tokenHash: marker.padEnd(64, "0").slice(0, 64),
        expiresAt: row.expiresAt,
      });
      await db.insert(ssoUsedTokens).values({
        jti: marker,
        sub: `escala:user:${userId}`,
        tenantKey: `inst-${institutionId}`,
        institutionId,
        expiresAt: row.expiresAt,
      });
      await db.insert(ssoLaunchCodes).values({
        code: marker,
        userId,
        institutionId,
        clientNonce: marker,
        expiresAt: row.expiresAt,
      });
      await db.insert(googleOauthStates).values({
        userId,
        stateHash: marker.padEnd(64, "0").slice(0, 64),
        sealedCodeVerifier: "sealed",
        encryptionKid: "current",
        returnTarget: "web",
        expiresAt: row.expiresAt,
      });
    }
  });

  afterAll(async () => {
    if (!db || !userId) return;
    const all = Object.values(markers);
    await db.delete(passwordResets).where(eq(passwordResets.userId, userId));
    await db.delete(ssoUsedTokens).where(inArray(ssoUsedTokens.jti, all));
    await db.delete(ssoLaunchCodes).where(inArray(ssoLaunchCodes.code, all));
    await db.delete(googleOauthStates).where(eq(googleOauthStates.userId, userId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("carência de 24 horas", () => {
    expect(EPHEMERAL_RETENTION_GRACE_MS).toBe(hours(24));
  });

  it("apaga só o vencido há mais de 24 h, em todas as quatro tabelas", async () => {
    const summary = await sweepEphemeralRecords({ db, now: NOW });
    // Pode haver lixo antigo de outras suítes; o que importa é o nosso.
    expect(summary.passwordResets).toBeGreaterThanOrEqual(1);
    expect(summary.ssoUsedTokens).toBeGreaterThanOrEqual(1);
    expect(summary.ssoLaunchCodes).toBeGreaterThanOrEqual(1);
    expect(summary.googleOauthStates).toBeGreaterThanOrEqual(1);

    const remainingCodes = (
      await db
        .select({ code: ssoLaunchCodes.code })
        .from(ssoLaunchCodes)
        .where(inArray(ssoLaunchCodes.code, Object.values(markers)))
    ).map((r) => r.code);
    expect(remainingCodes.sort()).toEqual([markers.recent, markers.valid].sort());

    const remainingJti = (
      await db
        .select({ jti: ssoUsedTokens.jti })
        .from(ssoUsedTokens)
        .where(inArray(ssoUsedTokens.jti, Object.values(markers)))
    ).map((r) => r.jti);
    expect(remainingJti.sort()).toEqual([markers.recent, markers.valid].sort());

    const remainingResets = await db
      .select({ id: passwordResets.id })
      .from(passwordResets)
      .where(eq(passwordResets.userId, userId));
    expect(remainingResets).toHaveLength(2);

    const remainingStates = await db
      .select({ id: googleOauthStates.id })
      .from(googleOauthStates)
      .where(eq(googleOauthStates.userId, userId));
    expect(remainingStates).toHaveLength(2);
  });

  it("rodar de novo não apaga mais nada nosso", async () => {
    await sweepEphemeralRecords({ db, now: NOW });
    const remainingCodes = await db
      .select({ code: ssoLaunchCodes.code })
      .from(ssoLaunchCodes)
      .where(inArray(ssoLaunchCodes.code, Object.values(markers)));
    expect(remainingCodes).toHaveLength(2);
  });
});
