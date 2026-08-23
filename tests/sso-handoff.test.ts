// tests/sso-handoff.test.ts — SSO Escala → Comunica+ (RS256 + JWKS) e launch-code.
//
// Lacuna apontada na auditoria 22/08 (parte 2): geração/validação do handoff
// nunca tiveram teste automatizado.
//
//   1. generateHandoffToken: sem plantão ativo → no_active_duty; instituição
//      sem mapeamento → org_not_mapped; com plantão ativo → JWT RS256 que
//      VERIFICA contra o JWKS público (iss/aud/exp/claims) e grava o jti
//      (anti-replay).
//   2. POST /api/sso/generate: 401 sem sessão, 403 sem vínculo, 200 com
//      handoffToken + targetUrl; x-tenant-id de instituição alheia → 403.
//   3. launch-code: one-time (segundo resgate falha), expirado falha.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import {
  auditTrail,
  hospitals,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  ssoLaunchCodes,
  ssoUsedTokens,
  users,
} from "../drizzle/schema";
import { ENV } from "../server/_core/env";
import { getDb } from "../server/db";
import { authRouter } from "../server/routes/auth";
import { generateHandoffToken } from "../server/sso/generate";
import { getJwks } from "../server/sso/keys";
import { createLaunchCode, redeemLaunchCode } from "../server/sso/launch";
import { ssoRouter } from "../server/sso/router";

// Mapeamento institution → org do Comunica+ vem de env (SSO_ORG_MAP) e é
// memoizado; aqui o id da instituição é criado em runtime, então o
// mapeamento é mockado: toda instituição ≠ UNMAPPED tem org.
const ORG_UUID = "595991e8-f690-4897-84a4-44e54c306c25";
const unmapped = { id: -1 };
vi.mock("../server/sso/org-mapping", () => ({
  getComunicaOrgId: (institutionId: number) => (institutionId === unmapped.id ? null : ORG_UUID),
  hasMappingFor: (institutionId: number) => institutionId !== unmapped.id,
}));

// Fora de dev o keystore não é gerado automaticamente: o teste fornece o
// par RSA pela mesma env que o Render usa (SSO_PRIVATE_KEY_JWK).
{
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const [publicJwk, privateJwk] = await Promise.all([exportJWK(publicKey), exportJWK(privateKey)]);
  process.env.SSO_PRIVATE_KEY_JWK = JSON.stringify({ publicJwk, privateJwk, kid: ENV.ssoKid, alg: "RS256" });
}

const STAMP = Date.now();
const PASSWORD = "SenhaSso123";

describe("SSO handoff e launch-code", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let userId: number;
  let professionalId: number;
  let orphanUserId: number;
  let cookie: string;
  let orphanCookie: string;
  let shiftId: number;

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/.well-known", ssoRouter);
    app.use("/api/sso", ssoRouter);

    const mk = async (tag: string, n: number) => {
      const [i] = await db
        .insert(institutions)
        .values({ name: `SSO ${tag} ${STAMP}`, cnpj: `${STAMP}${n}`.slice(-14).padStart(14, "0"), legalName: `SSO ${tag}`, tradeName: `SSO${tag}${STAMP}`.slice(0, 20), isActive: true })
        .$returningId();
      return i.id;
    };
    institutionId = await mk("A", 3);
    otherInstitutionId = await mk("B", 4);
    unmapped.id = otherInstitutionId;
    const [h] = await db.insert(hospitals).values({ institutionId, name: `SSO Hospital ${STAMP}` }).$returningId();
    hospitalId = h.id;
    const [sec] = await db.insert(sectors).values({ institutionId, hospitalId, name: `SSO Setor ${STAMP}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    sectorId = sec.id;

    const [u] = await db
      .insert(users)
      .values({ name: "SSO Médico", email: `sso-medico-${STAMP}@test.local`, passwordHash: await bcrypt.hash(PASSWORD, 4), loginMethod: "email", role: "doctor" })
      .$returningId();
    userId = u.id;
    const [p] = await db.insert(professionals).values({ userId, name: "SSO Médico", role: "Médico", userRole: "USER" }).$returningId();
    professionalId = p.id;
    await db.insert(professionalInstitutions).values({ professionalId, userId, institutionId, roleInInstitution: "USER", isPrimary: true, active: true });
    await db.insert(professionalAccess).values({ institutionId, professionalId, hospitalId, sectorId, canAccess: true });

    const [o] = await db
      .insert(users)
      .values({ name: "SSO Órfão", email: `sso-orfao-${STAMP}@test.local`, passwordHash: await bcrypt.hash(PASSWORD, 4), loginMethod: "email", role: "doctor", approvalStatus: "PENDING" })
      .$returningId();
    orphanUserId = o.id;

    const login = async (email: string) => {
      const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      const sc = res.headers["set-cookie"];
      return (Array.isArray(sc) ? sc : [sc]).find((c: string) => c?.startsWith("session=")) ?? "";
    };
    cookie = await login(`sso-medico-${STAMP}@test.local`);
    orphanCookie = await login(`sso-orfao-${STAMP}@test.local`);
  });

  afterAll(async () => {
    await db.delete(ssoUsedTokens).where(eq(ssoUsedTokens.institutionId, institutionId)).catch(() => undefined);
    await db.delete(ssoLaunchCodes).where(eq(ssoLaunchCodes.userId, userId));
    if (shiftId) {
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, shiftId));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftId));
    }
    await db.delete(auditTrail).where(inArray(auditTrail.institutionId, [institutionId, otherInstitutionId]));
    await db.delete(auditTrail).where(inArray(auditTrail.entityId, [userId, orphanUserId]));
    await db.delete(professionalAccess).where(eq(professionalAccess.professionalId, professionalId));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.userId, [userId, orphanUserId]));
    await db.delete(professionals).where(inArray(professionals.userId, [userId, orphanUserId]));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(inArray(institutions.id, [institutionId, otherInstitutionId]));
    await db.delete(users).where(inArray(users.id, [userId, orphanUserId]));
  });

  it("sem plantão ativo → no_active_duty; instituição sem mapeamento → org_not_mapped", async () => {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const r1 = await generateHandoffToken({ user, institutionId, clientNonce: "n1", roleInInstitution: "USER" });
    expect(r1).toMatchObject({ ok: false, code: "no_active_duty" });
    const r2 = await generateHandoffToken({ user, institutionId: otherInstitutionId, clientNonce: "n2", roleInInstitution: "USER" });
    expect(r2).toMatchObject({ ok: false, code: "org_not_mapped" });
  });

  it("com plantão em andamento → JWT RS256 verificável pelo JWKS, claims corretos e jti gravado", async () => {
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const [s] = await db
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, label: "Plantão SSO", startAt: start, endAt: end, status: "OCUPADO" })
      .$returningId();
    shiftId = s.id;
    await db.insert(shiftAssignmentsV2).values({ shiftInstanceId: shiftId, institutionId, hospitalId, sectorId, professionalId, assignmentType: "ON_DUTY", status: "OCUPADO", isActive: true, createdBy: userId });

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const r = await generateHandoffToken({ user, institutionId, clientNonce: "nonce-ok", roleInInstitution: "USER" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targetUrl).toContain("/auth/sso/exchange");
    expect(r.dutyContext.duty?.dutyType).toBe("PLANTAO");

    const jwks = createLocalJWKSet(await getJwks());
    const { payload, protectedHeader } = await jwtVerify(r.handoffToken, jwks, { issuer: ENV.ssoIssuer, audience: ENV.ssoAudience });
    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe(ENV.ssoKid);
    expect(payload.sub).toBe(String(userId));
    expect(payload.externalId).toBe(`escala:user:${userId}`);
    expect(payload.organizationId).toBe(ORG_UUID);
    expect(payload.externalOrganizationId).toBe(String(institutionId));
    expect(payload.dutyType).toBe("PLANTAO");
    expect(payload.scope).toBe("sso:login");
    expect(payload.roles).toEqual(["USER"]);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(120);
    expect(typeof payload.jti).toBe("string");

    const [used] = await db.select({ jti: ssoUsedTokens.jti, institutionId: ssoUsedTokens.institutionId }).from(ssoUsedTokens).where(eq(ssoUsedTokens.jti, String(payload.jti)));
    expect(used?.institutionId).toBe(institutionId);
  });

  it("POST /api/sso/generate: 401 sem sessão, 403 sem vínculo / tenant alheio, 200 com token", async () => {
    expect((await request(app).post("/api/sso/generate").send({ clientNonce: "x" })).status).toBe(401);
    expect((await request(app).post("/api/sso/generate").set("Cookie", orphanCookie).send({ clientNonce: "x" })).status).toBe(403);
    expect((await request(app).post("/api/sso/generate").set("Cookie", cookie).set("x-tenant-id", String(otherInstitutionId)).send({ clientNonce: "x" })).status).toBe(403);
    expect((await request(app).post("/api/sso/generate").set("Cookie", cookie).send({})).status).toBe(400);
    const ok = await request(app).post("/api/sso/generate").set("Cookie", cookie).set("x-tenant-id", String(institutionId)).send({ clientNonce: "http-nonce" });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.handoffToken).toBe("string");
    const jwks = createLocalJWKSet(await getJwks());
    await expect(jwtVerify(ok.body.handoffToken, jwks, { issuer: ENV.ssoIssuer, audience: ENV.ssoAudience })).resolves.toBeTruthy();
  });

  it("JWKS público é servido e o launch-code é one-time e expira", async () => {
    const jwksRes = await request(app).get("/.well-known/jwks.json");
    expect(jwksRes.status).toBe(200);
    expect(jwksRes.body.keys?.[0]?.kty).toBe("RSA");
    expect(jwksRes.body.keys?.[0]?.d).toBeUndefined(); // nunca a chave privada

    const created = await createLaunchCode(userId, institutionId, "nonce-launch");
    expect(created.ok).toBe(true);
    const first = await redeemLaunchCode(created.code!);
    expect(first.ok).toBe(true);
    expect(first.html).toContain("form");
    const second = await redeemLaunchCode(created.code!);
    expect(second.ok).toBe(false);

    const expired = await createLaunchCode(userId, institutionId, "nonce-expirado");
    await db.update(ssoLaunchCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(ssoLaunchCodes.code, expired.code!), eq(ssoLaunchCodes.userId, userId)));
    const late = await redeemLaunchCode(expired.code!);
    expect(late.ok).toBe(false);

    const http = await request(app).post("/api/sso/launch-code").set("Cookie", cookie).set("x-tenant-id", String(institutionId)).send({ clientNonce: "http-launch" });
    expect(http.status).toBe(200);
    expect(http.body.launchUrl).toMatch(/\/api\/sso\/launch\?code=[0-9a-f]{64}$/);
    const page = await request(app).get(`/api/sso/launch?code=${http.body.launchUrl.split("code=")[1]}`);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
  });
});
