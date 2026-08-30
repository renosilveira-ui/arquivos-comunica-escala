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

import { sessionAuthCookies } from "./helpers/session-cookies";

import { and, eq, inArray } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from "jose";
import * as auditService from "../server/audit-trail";
import * as policy from "../server/_core/policy";
import {
  auditTrail,
  hospitals,
  institutions,
  monthlyRosters,
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
import { sdk } from "../server/_core/sdk";
import { getDb } from "../server/db";
import { authRouter } from "../server/routes/auth";
import { generateHandoffToken } from "../server/sso/generate";
import { getJwks } from "../server/sso/keys";
import { createLaunchCode, redeemLaunchCode } from "../server/sso/launch";
import { ssoRouter } from "../server/sso/router";
import { yearMonthBrt } from "../server/local-time";
import { resolveTrustedSsoTargetUrl } from "../server/sso/url-policy";
import { sessionInstanceProof } from "../server/_core/session-instance";

// Mapeamento institution → org do Comunica+ vem de env (SSO_ORG_MAP) e é
// memoizado; aqui o id da instituição é criado em runtime, então o
// mapeamento é mockado: toda instituição ≠ UNMAPPED tem org.
const ORG_UUID = "595991e8-f690-4897-84a4-44e54c306c25";
const unmapped = { id: -1 };
vi.mock("../server/sso/org-mapping", () => ({
  getComunicaOrgId: (institutionId: number) =>
    institutionId === unmapped.id ? null : ORG_UUID,
  hasMappingFor: (institutionId: number) => institutionId !== unmapped.id,
}));

// Fora de dev o keystore não é gerado automaticamente: o teste fornece o
// par RSA pela mesma env que o Render usa (SSO_PRIVATE_KEY_JWK).
{
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    modulusLength: 2048,
    extractable: true,
  });
  const [publicJwk, privateJwk] = await Promise.all([
    exportJWK(publicKey),
    exportJWK(privateKey),
  ]);
  process.env.SSO_PRIVATE_KEY_JWK = JSON.stringify({
    publicJwk,
    privateJwk,
    kid: ENV.ssoKid,
    alg: "RS256",
  });
}

const STAMP = Date.now();
const PASSWORD = "SenhaSso123";

function serializedConsoleCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .flat()
    .flatMap((value) => {
      const representations = [String(value)];
      try {
        representations.push(JSON.stringify(value));
      } catch {
        representations.push("[unserializable]");
      }
      return representations;
    })
    .join("\n");
}

describe("SSO handoff e launch-code", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalId: number;
  let otherHospitalId: number;
  let sectorId: number;
  let otherSectorId: number;
  let userId: number;
  let professionalId: number;
  let membershipId: number;
  let accessId: number;
  let orphanUserId: number;
  let cookie: string;
  let orphanCookie: string;
  let shiftId: number;
  let assignmentId: number;
  let rosterId: number;

  async function issuanceCounts() {
    const [tokens, audits, launchCodes] = await Promise.all([
      db
        .select({ id: ssoUsedTokens.id })
        .from(ssoUsedTokens)
        .where(eq(ssoUsedTokens.institutionId, institutionId)),
      db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.institutionId, institutionId),
            eq(auditTrail.action, "SSO_JIT_LINK_CREATED"),
          ),
        ),
      db
        .select({ id: ssoLaunchCodes.id })
        .from(ssoLaunchCodes)
        .where(eq(ssoLaunchCodes.userId, userId)),
    ]);
    return {
      tokens: tokens.length,
      audits: audits.length,
      launchCodes: launchCodes.length,
    };
  }

  async function currentUser() {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error("Fixture SSO sem usuario");
    return user;
  }

  function proofForCookie(sessionCookie: string): string {
    const sessionPair = sessionCookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("session="));
    const token = sessionPair?.slice("session=".length);
    if (!token) throw new Error("Cookie de sessão SSO inválido");
    return sessionInstanceProof(token);
  }

  async function expectNoDurableIssuance(nonce: string) {
    const before = await issuanceCounts();
    const result = await generateHandoffToken({
      user: await currentUser(),
      institutionId,
      clientNonce: nonce,
    });
    expect(result.ok).toBe(false);
    const after = await issuanceCounts();
    expect(after.tokens).toBe(before.tokens);
    expect(after.audits).toBe(before.audits);
    return result;
  }

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
        .values({
          name: `SSO ${tag} ${STAMP}`,
          cnpj: `${STAMP}${n}`.slice(-14).padStart(14, "0"),
          legalName: `SSO ${tag}`,
          tradeName: `SSO${tag}${STAMP}`.slice(0, 20),
          isActive: true,
        })
        .$returningId();
      return i.id;
    };
    institutionId = await mk("A", 3);
    otherInstitutionId = await mk("B", 4);
    unmapped.id = otherInstitutionId;
    const [h] = await db
      .insert(hospitals)
      .values({ institutionId, name: `SSO Hospital ${STAMP}` })
      .$returningId();
    hospitalId = h.id;
    const [otherHospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `SSO Hospital B ${STAMP}` })
      .$returningId();
    otherHospitalId = otherHospital.id;
    const [sec] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `SSO Setor ${STAMP}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sec.id;
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `SSO Setor B ${STAMP}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    otherSectorId = otherSector.id;

    const [u] = await db
      .insert(users)
      .values({
        name: "SSO Médico",
        email: `sso-medico-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "doctor",
      })
      .$returningId();
    userId = u.id;
    const [p] = await db
      .insert(professionals)
      .values({ userId, name: "SSO Médico", role: "Médico", userRole: "USER" })
      .$returningId();
    professionalId = p.id;
    const [membership] = await db
      .insert(professionalInstitutions)
      .values({
        professionalId,
        userId,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      })
      .$returningId();
    membershipId = membership.id;
    const [access] = await db
      .insert(professionalAccess)
      .values({
        institutionId,
        professionalId,
        hospitalId,
        sectorId,
        canAccess: true,
      })
      .$returningId();
    accessId = access.id;

    const [o] = await db
      .insert(users)
      .values({
        name: "SSO Órfão",
        email: `sso-orfao-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "doctor",
        approvalStatus: "PENDING",
      })
      .$returningId();
    orphanUserId = o.id;

    const login = async (email: string) => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      return sessionAuthCookies(res);
    };
    cookie = await login(`sso-medico-${STAMP}@test.local`);
    orphanCookie = await login(`sso-orfao-${STAMP}@test.local`);
  });

  afterAll(async () => {
    await db
      .delete(ssoUsedTokens)
      .where(eq(ssoUsedTokens.institutionId, institutionId))
      .catch(() => undefined);
    await db.delete(ssoLaunchCodes).where(eq(ssoLaunchCodes.userId, userId));
    if (shiftId) {
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftId));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftId));
    }
    if (rosterId)
      await db.delete(monthlyRosters).where(eq(monthlyRosters.id, rosterId));
    await db
      .delete(auditTrail)
      .where(
        inArray(auditTrail.institutionId, [institutionId, otherInstitutionId]),
      );
    await db
      .delete(auditTrail)
      .where(inArray(auditTrail.entityId, [userId, orphanUserId]));
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.professionalId, professionalId));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.userId, [userId, orphanUserId]));
    await db
      .delete(professionals)
      .where(inArray(professionals.userId, [userId, orphanUserId]));
    await db
      .delete(sectors)
      .where(inArray(sectors.id, [sectorId, otherSectorId]));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.id, [hospitalId, otherHospitalId]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [institutionId, otherInstitutionId]));
    await db.delete(users).where(inArray(users.id, [userId, orphanUserId]));
  });

  it("sem plantão ativo → no_active_duty; instituição sem mapeamento → org_not_mapped", async () => {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const r1 = await generateHandoffToken({
      user,
      institutionId,
      clientNonce: "n1",
    });
    expect(r1).toMatchObject({ ok: false, code: "no_active_duty" });
    const r2 = await generateHandoffToken({
      user,
      institutionId: otherInstitutionId,
      clientNonce: "n2",
    });
    expect(r2).toMatchObject({ ok: false, code: "org_not_mapped" });
  });

  it("com plantão em andamento → JWT RS256 verificável pelo JWKS, claims corretos e jti gravado", async () => {
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const [s] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: "Plantão SSO",
        startAt: start,
        endAt: end,
        status: "OCUPADO",
      })
      .$returningId();
    shiftId = s.id;
    const [roster] = await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(start),
        status: "PUBLISHED",
      })
      .$returningId();
    rosterId = roster.id;
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: userId,
      })
      .$returningId();
    assignmentId = assignment.id;

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const r = await generateHandoffToken({
      user,
      institutionId,
      clientNonce: "nonce-ok",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targetUrl).toContain("/auth/sso/exchange");
    expect(r.dutyContext.duty?.dutyType).toBe("PLANTAO");

    const jwks = createLocalJWKSet(await getJwks());
    const { payload, protectedHeader } = await jwtVerify(r.handoffToken, jwks, {
      issuer: ENV.ssoIssuer,
      audience: ENV.ssoAudience,
    });
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

    const [used] = await db
      .select({
        jti: ssoUsedTokens.jti,
        institutionId: ssoUsedTokens.institutionId,
      })
      .from(ssoUsedTokens)
      .where(eq(ssoUsedTokens.jti, String(payload.jti)));
    expect(used?.institutionId).toBe(institutionId);
    const audits = await db
      .select({
        actorRole: auditTrail.actorRole,
        description: auditTrail.description,
        metadata: auditTrail.metadata,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.action, "SSO_JIT_LINK_CREATED"),
          eq(auditTrail.entityId, userId),
        ),
      );
    const audit = audits.find(
      (entry) =>
        (entry.metadata as { jti?: string } | null)?.jti === payload.jti,
    );
    expect(audit).toBeTruthy();
    expect(audit?.actorRole).toBe("USER");
    expect(audit?.description).not.toContain(user.email!);
  });

  it("dois assignments canônicos retornam context_conflict antes de assinatura, JTI e auditoria", async () => {
    const [secondAssignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId,
        assignmentType: "ON_CALL",
        status: "OCUPADO",
        isActive: true,
        createdBy: userId,
      })
      .$returningId();
    const before = await issuanceCounts();
    const createJti = vi.fn(() => "22222222-2222-4222-8222-222222222222");
    const sign = vi.spyOn(SignJWT.prototype, "sign");

    try {
      const result = await generateHandoffToken(
        {
          user: await currentUser(),
          institutionId,
          clientNonce: "context-conflict",
        },
        { createJti },
      );

      expect(result).toMatchObject({ ok: false, code: "context_conflict" });
      expect(createJti).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
      expect(await issuanceCounts()).toEqual(before);
    } finally {
      sign.mockRestore();
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, secondAssignment.id));
    }
  });

  it("rejeita clientNonce vazio ou acima de 191 antes de qualquer persistencia", async () => {
    const before = await issuanceCounts();
    for (const clientNonce of ["", "   ", "x".repeat(192)]) {
      const generate = await request(app)
        .post("/api/sso/generate")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .send({ clientNonce });
      expect(generate.status).toBe(400);

      const launch = await request(app)
        .post("/api/sso/launch-code")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .send({ clientNonce });
      expect(launch.status).toBe(400);
    }
    expect(await issuanceCounts()).toEqual(before);
  });

  it("expected-user divergente ou malformado bloqueia generate e launch antes de efeitos", async () => {
    const before = await issuanceCounts();
    for (const path of ["/api/sso/generate", "/api/sso/launch-code"] as const) {
      const divergent = await request(app)
        .post(path)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .set("x-client-expected-user-id", String(orphanUserId))
        .send({ clientNonce: `expected-user-divergent:${path}` });
      expect(divergent.status).toBe(409);
      expect(divergent.body).toMatchObject({ code: "EXPECTED_USER_MISMATCH" });

      const malformed = await request(app)
        .post(path)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .set("x-client-expected-user-id", `0${userId}`)
        .send({ clientNonce: `expected-user-malformed:${path}` });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({
        code: "MALFORMED_EXPECTED_USER_ID",
      });
    }
    expect(await issuanceCounts()).toEqual(before);
  });

  it("proof S1 com cookie S2 same-user não emite handoff nem launch-code", async () => {
    const secondLogin = await request(app)
      .post("/api/auth/login")
      .send({
        email: `sso-medico-${STAMP}@test.local`,
        password: PASSWORD,
      });
    expect(secondLogin.status).toBe(200);
    const secondCookie = sessionAuthCookies(secondLogin);
    expect(secondCookie).toBeTruthy();
    expect(proofForCookie(secondCookie!)).not.toBe(proofForCookie(cookie));
    const before = await issuanceCounts();

    for (const path of ["/api/sso/generate", "/api/sso/launch-code"] as const) {
      const response = await request(app)
        .post(path)
        .set("Cookie", secondCookie!)
        .set("x-tenant-id", String(institutionId))
        .set("x-client-expected-user-id", String(userId))
        .set("x-client-session-instance", proofForCookie(cookie))
        .send({ clientNonce: `session-instance-mismatch:${path}` });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: "SESSION_INSTANCE_MISMATCH",
      });
    }
    expect(await issuanceCounts()).toEqual(before);
    cookie = secondCookie!;
  });

  it("JWT exact-v1 cookie sem proof bloqueia generate e launch-code com 428 sem emissão", async () => {
    const user = await currentUser();
    const token = await sdk.signSession({
      userId: String(user.id),
      name: user.name ?? "SSO exact-v1",
      sessionVersion: user.sessionVersion,
      sessionBindingVersion: 1,
    });
    const before = await issuanceCounts();

    for (const path of ["/api/sso/generate", "/api/sso/launch-code"] as const) {
      const response = await request(app)
        .post(path)
        .set("Cookie", `session=${token}`)
        .set("x-tenant-id", String(institutionId))
        .send({ clientNonce: `exact-v1-missing-proof:${path}` });
      expect(response.status).toBe(428);
      expect(response.body).toMatchObject({
        code: "SESSION_INSTANCE_REQUIRED",
      });
    }
    expect(await issuanceCounts()).toEqual(before);
  });

  it("launchUrl usa base publica confiavel e nunca ecoa Host ou X-Forwarded-Proto", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PUBLIC_URL", "https://escala.confiavel.example/app/");
    try {
      const response = await request(app)
        .post("/api/sso/launch-code")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .set("Host", "atacante.example")
        .set("x-forwarded-host", "atacante.example")
        .set("x-forwarded-proto", "http")
        .send({ clientNonce: "trusted-public-url" });
      expect(response.status).toBe(200);
      expect(response.body.launchUrl).toMatch(
        /^https:\/\/escala\.confiavel\.example\/app\/api\/sso\/launch\?code=[0-9a-f]{64}$/,
      );
      expect(response.body.launchUrl).not.toContain("atacante.example");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falha de persistência do launch-code não expõe params Drizzle", async () => {
    const sentinel = "DRIZZLE_LAUNCH_CODE_SECRET_SENTINEL";
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const insertSpy = vi
      .spyOn(db as any, "insert")
      .mockImplementationOnce(() => {
        throw new DrizzleQueryError(
          "insert into sso_launch_codes (code) values (?)",
          [sentinel],
          new Error(sentinel),
        );
      });

    let result: Awaited<ReturnType<typeof createLaunchCode>>;
    try {
      const user = await currentUser();
      result = await createLaunchCode(
        userId,
        institutionId,
        "launch-sentinel",
        user.sessionVersion,
      );
    } finally {
      insertSpy.mockRestore();
    }

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "Falha ao criar codigo",
    });
    expect(
      `${JSON.stringify(result)}\n${serializedConsoleCalls(error)}`,
    ).not.toContain(sentinel);
    expect(error).toHaveBeenCalledWith("[SSO] LAUNCH_CODE_PERSIST_FAILED");
  });

  it("producao sem APP_PUBLIC_URL valida retorna 503 e cria zero launch-code", async () => {
    const before = await issuanceCounts();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PUBLIC_URL", "");
    try {
      const response = await request(app)
        .post("/api/sso/launch-code")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .send({ clientNonce: "no-public-url" });
      expect(response.status).toBe(503);
      vi.stubEnv("APP_PUBLIC_URL", "https://localhost/app");
      const local = await request(app)
        .post("/api/sso/launch-code")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .send({ clientNonce: "local-public-url" });
      expect(local.status).toBe(503);
      expect(await issuanceCounts()).toEqual(before);
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "javascript:alert(1)",
    "http://comunica.example",
    "https://localhost",
  ])(
    "bloqueia destino SSO invalido em producao (%s) antes de JTI/auditoria",
    async (target) => {
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SSO_TARGET_URL", target);
      try {
        const result = await expectNoDurableIssuance(
          `invalid-target:${target}`,
        );
        expect(result).toMatchObject({ ok: false, code: "internal_error" });
      } finally {
        error.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("aceita e normaliza somente destino HTTPS externo em producao", () => {
    expect(
      resolveTrustedSsoTargetUrl({
        NODE_ENV: "production",
        SSO_TARGET_URL: "https://comunica.example/base/",
      }),
    ).toBe("https://comunica.example/base");
  });

  it("falha fechado quando PI, paridade profissional, conta ou ACL deixam de ser canonicos", async () => {
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.id, membershipId));
    await expectNoDurableIssuance("pi-inativa");
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(eq(professionalInstitutions.id, membershipId));

    await db
      .update(professionals)
      .set({ userId: orphanUserId })
      .where(eq(professionals.id, professionalId));
    await expectNoDurableIssuance("paridade-corrompida");
    await db
      .update(professionals)
      .set({ userId })
      .where(eq(professionals.id, professionalId));

    await db
      .update(users)
      .set({ approvalStatus: "PENDING" })
      .where(eq(users.id, userId));
    await expectNoDurableIssuance("usuario-pendente");
    await db
      .update(users)
      .set({ approvalStatus: "APPROVED" })
      .where(eq(users.id, userId));

    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, userId));
    await expectNoDurableIssuance("usuario-excluido");
    await db.update(users).set({ deletedAt: null }).where(eq(users.id, userId));

    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.id, accessId));
    await expectNoDurableIssuance("acl-revogada");
    await db
      .update(professionalAccess)
      .set({ canAccess: true })
      .where(eq(professionalAccess.id, accessId));

    await db
      .update(professionalAccess)
      .set({ sectorId: otherSectorId })
      .where(eq(professionalAccess.id, accessId));
    await expectNoDurableIssuance("acl-outro-setor");
    await db
      .update(professionalAccess)
      .set({ sectorId })
      .where(eq(professionalAccess.id, accessId));
  });

  it("falha fechado para contaminacao institution/hospital/sector/status da alocacao", async () => {
    await db
      .update(shiftAssignmentsV2)
      .set({ status: "PENDENTE" })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await expectNoDurableIssuance("assignment-status");
    await db
      .update(shiftAssignmentsV2)
      .set({ status: "OCUPADO" })
      .where(eq(shiftAssignmentsV2.id, assignmentId));

    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
      .where(eq(shiftInstances.id, shiftId));
    await expectNoDurableIssuance("shift-status");
    await db
      .update(shiftInstances)
      .set({ status: "OCUPADO" })
      .where(eq(shiftInstances.id, shiftId));

    await db
      .update(shiftAssignmentsV2)
      .set({ institutionId: otherInstitutionId })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await expectNoDurableIssuance("assignment-institution");
    await db
      .update(shiftAssignmentsV2)
      .set({ institutionId })
      .where(eq(shiftAssignmentsV2.id, assignmentId));

    await db
      .update(shiftAssignmentsV2)
      .set({ hospitalId: otherHospitalId })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await expectNoDurableIssuance("assignment-hospital");
    await db
      .update(shiftAssignmentsV2)
      .set({ hospitalId })
      .where(eq(shiftAssignmentsV2.id, assignmentId));

    await db
      .update(shiftAssignmentsV2)
      .set({ sectorId: otherSectorId })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await expectNoDurableIssuance("assignment-sector");
    await db
      .update(shiftAssignmentsV2)
      .set({ sectorId })
      .where(eq(shiftAssignmentsV2.id, assignmentId));

    await db
      .update(shiftInstances)
      .set({ institutionId: otherInstitutionId })
      .where(eq(shiftInstances.id, shiftId));
    await expectNoDurableIssuance("shift-institution");
    await db
      .update(shiftInstances)
      .set({ institutionId })
      .where(eq(shiftInstances.id, shiftId));

    await db
      .update(shiftInstances)
      .set({ hospitalId: otherHospitalId })
      .where(eq(shiftInstances.id, shiftId));
    await expectNoDurableIssuance("shift-hospital");
    await db
      .update(shiftInstances)
      .set({ hospitalId })
      .where(eq(shiftInstances.id, shiftId));

    await db
      .update(shiftInstances)
      .set({ sectorId: otherSectorId })
      .where(eq(shiftInstances.id, shiftId));
    await expectNoDurableIssuance("shift-sector");
    await db
      .update(shiftInstances)
      .set({ sectorId })
      .where(eq(shiftInstances.id, shiftId));
  });

  it("exige roster oficial: missing/DRAFT negam e PUBLISHED/LOCKED autorizam", async () => {
    await db
      .update(monthlyRosters)
      .set({ status: "DRAFT" })
      .where(eq(monthlyRosters.id, rosterId));
    await expectNoDurableIssuance("roster-draft");

    await db.delete(monthlyRosters).where(eq(monthlyRosters.id, rosterId));
    await expectNoDurableIssuance("roster-missing");

    const [replacementRoster] = await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(new Date()),
        status: "PUBLISHED",
      })
      .$returningId();
    rosterId = replacementRoster.id;
    expect(
      (
        await generateHandoffToken({
          user: await currentUser(),
          institutionId,
          clientNonce: "roster-published",
        })
      ).ok,
    ).toBe(true);

    await db
      .update(monthlyRosters)
      .set({ status: "LOCKED" })
      .where(eq(monthlyRosters.id, rosterId));
    expect(
      (
        await generateHandoffToken({
          user: await currentUser(),
          institutionId,
          clientNonce: "roster-locked",
        })
      ).ok,
    ).toBe(true);
    await db
      .update(monthlyRosters)
      .set({ status: "PUBLISHED" })
      .where(eq(monthlyRosters.id, rosterId));
  });

  it("falha de auditoria reverte o JTI e nunca retorna token", async () => {
    const before = await issuanceCounts();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const audit = vi
      .spyOn(auditService, "recordAudit")
      .mockRejectedValueOnce(new Error("audit down"));
    try {
      const result = await generateHandoffToken({
        user: await currentUser(),
        institutionId,
        clientNonce: "audit-rollback",
      });
      expect(result).toMatchObject({ ok: false, code: "internal_error" });
      expect("handoffToken" in result).toBe(false);
      expect(await issuanceCounts()).toEqual(before);
    } finally {
      audit.mockRestore();
      error.mockRestore();
    }
  });

  it("falha ao persistir JTI faz rollback e nunca retorna token", async () => {
    const fixedJti = "11111111-1111-4111-8111-111111111111";
    await db.insert(ssoUsedTokens).values({
      jti: fixedJti,
      sub: String(userId),
      tenantKey: ORG_UUID,
      institutionId,
      expiresAt: new Date(Date.now() + 90_000),
    });
    const before = await issuanceCounts();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const result = await generateHandoffToken(
        {
          user: await currentUser(),
          institutionId,
          clientNonce: "jti-rollback",
        },
        { createJti: () => fixedJti },
      );
      expect(result).toMatchObject({ ok: false, code: "internal_error" });
      expect("handoffToken" in result).toBe(false);
      expect(await issuanceCounts()).toEqual(before);
    } finally {
      error.mockRestore();
      await db.delete(ssoUsedTokens).where(eq(ssoUsedTokens.jti, fixedJti));
    }
  });

  it("launch-code e revogado por sessionVersion antes do resgate", async () => {
    const user = await currentUser();
    const created = await createLaunchCode(
      userId,
      institutionId,
      "session-bound-launch",
      user.sessionVersion,
    );
    expect(created.ok).toBe(true);
    expect(created.code?.slice(0, 8)).toBe(
      user.sessionVersion.toString(16).padStart(8, "0"),
    );
    const before = await issuanceCounts();
    await db
      .update(users)
      .set({ sessionVersion: user.sessionVersion + 1 })
      .where(eq(users.id, userId));
    try {
      const redeemed = await redeemLaunchCode(created.code!);
      expect(redeemed).toMatchObject({ ok: false, status: 410 });
      const after = await issuanceCounts();
      expect(after.tokens).toBe(before.tokens);
      expect(after.audits).toBe(before.audits);
    } finally {
      await db
        .update(users)
        .set({ sessionVersion: user.sessionVersion })
        .where(eq(users.id, userId));
    }
  });

  it("launch create/redeem revalidam PI, paridade e conta sem fallback USER", async () => {
    const user = await currentUser();
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.id, membershipId));
    const beforeCreate = await issuanceCounts();
    try {
      const denied = await createLaunchCode(
        userId,
        institutionId,
        "launch-pi-inativa",
        user.sessionVersion,
      );
      expect(denied).toMatchObject({ ok: false, status: 403 });
      expect((await issuanceCounts()).launchCodes).toBe(
        beforeCreate.launchCodes,
      );
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(eq(professionalInstitutions.id, membershipId));
    }

    async function revokedRedeem(
      label: string,
      mutate: () => Promise<void>,
      restore: () => Promise<void>,
    ) {
      const created = await createLaunchCode(
        userId,
        institutionId,
        `launch-revoked:${label}`,
        (await currentUser()).sessionVersion,
      );
      expect(created.ok).toBe(true);
      const before = await issuanceCounts();
      try {
        await mutate();
        const redeemed = await redeemLaunchCode(created.code!);
        expect(redeemed).toMatchObject({ ok: false, status: 410 });
        const after = await issuanceCounts();
        expect(after.tokens).toBe(before.tokens);
        expect(after.audits).toBe(before.audits);
      } finally {
        await restore();
      }
    }

    await revokedRedeem(
      "pi",
      () =>
        db
          .update(professionalInstitutions)
          .set({ active: false })
          .where(eq(professionalInstitutions.id, membershipId))
          .then(() => undefined),
      () =>
        db
          .update(professionalInstitutions)
          .set({ active: true })
          .where(eq(professionalInstitutions.id, membershipId))
          .then(() => undefined),
    );
    await revokedRedeem(
      "parity",
      () =>
        db
          .update(professionals)
          .set({ userId: orphanUserId })
          .where(eq(professionals.id, professionalId))
          .then(() => undefined),
      () =>
        db
          .update(professionals)
          .set({ userId })
          .where(eq(professionals.id, professionalId))
          .then(() => undefined),
    );
    await revokedRedeem(
      "pending",
      () =>
        db
          .update(users)
          .set({ approvalStatus: "PENDING" })
          .where(eq(users.id, userId))
          .then(() => undefined),
      () =>
        db
          .update(users)
          .set({ approvalStatus: "APPROVED" })
          .where(eq(users.id, userId))
          .then(() => undefined),
    );
    await revokedRedeem(
      "deleted",
      () =>
        db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, userId))
          .then(() => undefined),
      () =>
        db
          .update(users)
          .set({ deletedAt: null })
          .where(eq(users.id, userId))
          .then(() => undefined),
    );
  });

  it("falha de resolucao de papel retorna erro e cria zero JTI/audit/launch", async () => {
    const before = await issuanceCounts();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const resolver = vi.spyOn(policy, "resolveTenantActor");
    try {
      resolver.mockRejectedValueOnce(new Error("role db down"));
      const generate = await request(app)
        .post("/api/sso/generate")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .send({ clientNonce: "role-db-generate" });
      expect(generate.status).toBe(500);
      expect(generate.body.handoffToken).toBeUndefined();

      resolver.mockRejectedValueOnce(new Error("role db down"));
      const launch = await request(app)
        .post("/api/sso/launch-code")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionId))
        .send({ clientNonce: "role-db-launch" });
      expect(launch.status).toBe(500);
      expect(launch.body.launchUrl).toBeUndefined();
      expect(await issuanceCounts()).toEqual(before);
    } finally {
      resolver.mockRestore();
      error.mockRestore();
    }
  });

  it("lineariza reset/revogacao/unassign/roster entre pre-read e emissao", async () => {
    async function race(
      label: string,
      mutate: () => Promise<void>,
      restore: () => Promise<void>,
    ) {
      const before = await issuanceCounts();
      let resume!: () => void;
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const generation = generateHandoffToken(
        {
          user: await currentUser(),
          institutionId,
          clientNonce: `race:${label}`,
        },
        {
          beforeIssuanceTransaction: async () => {
            reached();
            await gate;
          },
        },
      );
      await paused;
      try {
        await mutate();
        resume();
        const result = await generation;
        expect(result).toMatchObject({ ok: false, code: "authority_invalid" });
        expect("handoffToken" in result).toBe(false);
        const after = await issuanceCounts();
        expect(after.tokens).toBe(before.tokens);
        expect(after.audits).toBe(before.audits);
      } finally {
        resume();
        await generation.catch(() => undefined);
        await restore();
      }
    }

    const user = await currentUser();
    await race(
      "session-reset",
      () =>
        db
          .update(users)
          .set({ sessionVersion: user.sessionVersion + 1 })
          .where(eq(users.id, userId))
          .then(() => undefined),
      () =>
        db
          .update(users)
          .set({ sessionVersion: user.sessionVersion })
          .where(eq(users.id, userId))
          .then(() => undefined),
    );
    await race(
      "pi-revoked",
      () =>
        db
          .update(professionalInstitutions)
          .set({ active: false })
          .where(eq(professionalInstitutions.id, membershipId))
          .then(() => undefined),
      () =>
        db
          .update(professionalInstitutions)
          .set({ active: true })
          .where(eq(professionalInstitutions.id, membershipId))
          .then(() => undefined),
    );
    await race(
      "assignment-unassigned",
      () =>
        db
          .update(shiftAssignmentsV2)
          .set({ isActive: false })
          .where(eq(shiftAssignmentsV2.id, assignmentId))
          .then(() => undefined),
      () =>
        db
          .update(shiftAssignmentsV2)
          .set({ isActive: true })
          .where(eq(shiftAssignmentsV2.id, assignmentId))
          .then(() => undefined),
    );

    const [roster] = await db
      .select({ version: monthlyRosters.version })
      .from(monthlyRosters)
      .where(eq(monthlyRosters.id, rosterId));
    await race(
      "roster-locked",
      () =>
        db
          .update(monthlyRosters)
          .set({ status: "LOCKED", version: roster.version + 1 })
          .where(eq(monthlyRosters.id, rosterId))
          .then(() => undefined),
      () =>
        db
          .update(monthlyRosters)
          .set({ status: "PUBLISHED", version: roster.version })
          .where(eq(monthlyRosters.id, rosterId))
          .then(() => undefined),
    );
    await race(
      "roster-draft",
      () =>
        db
          .update(monthlyRosters)
          .set({ status: "DRAFT", version: roster.version + 1 })
          .where(eq(monthlyRosters.id, rosterId))
          .then(() => undefined),
      () =>
        db
          .update(monthlyRosters)
          .set({ status: "PUBLISHED", version: roster.version })
          .where(eq(monthlyRosters.id, rosterId))
          .then(() => undefined),
    );
  });

  it("POST /api/sso/generate: 401 sem sessão, 403 sem vínculo / tenant alheio, 200 com token", async () => {
    expect(
      (await request(app).post("/api/sso/generate").send({ clientNonce: "x" }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/sso/generate")
          .set("Cookie", cookie)
          .send({ clientNonce: "x" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/sso/generate")
          .set("Cookie", cookie)
          .set("x-tenant-id", "abc")
          .send({ clientNonce: "x" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/sso/launch-code")
          .set("Cookie", cookie)
          .send({ clientNonce: "x" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/sso/launch-code")
          .set("Cookie", cookie)
          .set("x-tenant-id", "0")
          .send({ clientNonce: "x" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/sso/generate")
          .set("Cookie", orphanCookie)
          .set("x-tenant-id", String(institutionId))
          .send({ clientNonce: "x" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/sso/generate")
          .set("Cookie", cookie)
          .set("x-tenant-id", String(otherInstitutionId))
          .send({ clientNonce: "x" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/sso/generate")
          .set("Cookie", cookie)
          .send({})
      ).status,
    ).toBe(400);
    const ok = await request(app)
      .post("/api/sso/generate")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(userId))
      .send({ clientNonce: "http-nonce" });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.handoffToken).toBe("string");
    const jwks = createLocalJWKSet(await getJwks());
    await expect(
      jwtVerify(ok.body.handoffToken, jwks, {
        issuer: ENV.ssoIssuer,
        audience: ENV.ssoAudience,
      }),
    ).resolves.toBeTruthy();
  });

  it("JWKS público é servido e o launch-code é one-time e expira", async () => {
    const jwksRes = await request(app).get("/.well-known/jwks.json");
    expect(jwksRes.status).toBe(200);
    expect(jwksRes.body.keys?.[0]?.kty).toBe("RSA");
    expect(jwksRes.body.keys?.[0]?.d).toBeUndefined(); // nunca a chave privada

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const created = await createLaunchCode(
      userId,
      institutionId,
      "nonce-launch",
      user.sessionVersion,
    );
    expect(created.ok).toBe(true);
    const first = await redeemLaunchCode(created.code!);
    expect(first.ok).toBe(true);
    expect(first.html).toContain("form");
    const second = await redeemLaunchCode(created.code!);
    expect(second.ok).toBe(false);

    const expired = await createLaunchCode(
      userId,
      institutionId,
      "nonce-expirado",
      user.sessionVersion,
    );
    await db
      .update(ssoLaunchCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(ssoLaunchCodes.code, expired.code!),
          eq(ssoLaunchCodes.userId, userId),
        ),
      );
    const late = await redeemLaunchCode(expired.code!);
    expect(late.ok).toBe(false);

    const http = await request(app)
      .post("/api/sso/launch-code")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(userId))
      .send({ clientNonce: "http-launch" });
    expect(http.status).toBe(200);
    expect(http.body.launchUrl).toMatch(
      /\/api\/sso\/launch\?code=[0-9a-f]{64}$/,
    );
    const page = await request(app).get(
      `/api/sso/launch?code=${http.body.launchUrl.split("code=")[1]}`,
    );
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
  });
});
