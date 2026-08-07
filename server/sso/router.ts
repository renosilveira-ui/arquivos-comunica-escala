// server/sso/router.ts — SSO endpoints (JWKS + token generation + launch)
import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { sdk } from "../_core/sdk";
import { getJwks } from "./keys";
import { generateHandoffToken } from "./generate";
import { createLaunchCode, redeemLaunchCode, buildErrorHtml } from "./launch";
import { resolveInstitutionForUser } from "../_core/tenant";
import { getDb } from "../db";
import { eq, and } from "drizzle-orm";
import { professionalInstitutions } from "../../drizzle/schema";

export const ssoRouter = Router();

// GET /.well-known/jwks.json — Public key for Comunica+ to verify tokens
ssoRouter.get("/jwks.json", async (_req: Request, res: Response): Promise<void> => {
  try {
    const jwks = await getJwks();
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(jwks);
  } catch (err) {
    console.error("[SSO] JWKS generation failed:", err);
    res.status(500).json({ error: "Falha ao gerar JWKS" });
  }
});

// POST /api/sso/generate — Generate handoff token (authenticated)
ssoRouter.post("/generate", async (req: Request, res: Response): Promise<void> => {
  // 1. Authenticate
  let user;
  try {
    user = await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }

  // 2. Validate input
  const { clientNonce } = req.body as { clientNonce?: unknown };
  if (typeof clientNonce !== "string" || !clientNonce.trim()) {
    res.status(400).json({ error: "clientNonce é obrigatório" });
    return;
  }

  // 3. Resolve tenant
  const tenantHeader = req.headers["x-tenant-id"];
  const parsedTenantId = typeof tenantHeader === "string" ? Number(tenantHeader) : null;
  const tenant = await resolveInstitutionForUser(
    user.id,
    Number.isFinite(parsedTenantId) ? parsedTenantId : null,
  );

  if (!tenant.institutionId) {
    res.status(403).json({ error: "Sem vínculo institucional ativo" });
    return;
  }

  // 4. Resolve role in institution
  let roleInInstitution = "USER";
  try {
    const db = await getDb();
    if (db) {
      const [link] = await db
        .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.userId, user.id),
            eq(professionalInstitutions.institutionId, tenant.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        )
        .limit(1);
      if (link) roleInInstitution = link.roleInInstitution;
    }
  } catch {
    // Fall back to USER
  }

  // 5. Generate token
  const result = await generateHandoffToken({
    user,
    institutionId: tenant.institutionId,
    clientNonce: clientNonce.trim(),
    roleInInstitution,
  });

  if (!result.ok) {
    const statusMap = {
      no_active_duty: 422,
      context_conflict: 409,
      org_not_mapped: 503,
      internal_error: 500,
    } as const;

    res.status(statusMap[result.code]).json({
      error: result.message,
      code: result.code,
    });
    return;
  }

  res.json({
    handoffToken: result.handoffToken,
    targetUrl: result.targetUrl,
    dutyContext: {
      dutyType: result.dutyContext.duty?.dutyType,
      serviceName: result.dutyContext.duty?.serviceName,
      dutyStart: result.dutyContext.duty?.dutyStart,
      dutyEnd: result.dutyContext.duty?.dutyEnd,
    },
  });
});

// POST /api/sso/launch-code — Create one-time launch code (authenticated).
// Mobile flow: the app opens the returned launchUrl in the external
// browser; GET /launch consumes the code and completes the handoff there.
ssoRouter.post("/launch-code", async (req: Request, res: Response): Promise<void> => {
  let user;
  try {
    user = await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }

  const tenantHeader = req.headers["x-tenant-id"];
  const parsedTenantId = typeof tenantHeader === "string" ? Number(tenantHeader) : null;
  const tenant = await resolveInstitutionForUser(
    user.id,
    Number.isFinite(parsedTenantId) ? parsedTenantId : null,
  );

  if (!tenant.institutionId) {
    res.status(403).json({ error: "Sem vínculo institucional ativo" });
    return;
  }

  const clientNonce =
    typeof (req.body as { clientNonce?: unknown })?.clientNonce === "string"
      ? String((req.body as { clientNonce: string }).clientNonce).trim()
      : randomUUID();

  const result = await createLaunchCode(user.id, tenant.institutionId, clientNonce);
  if (!result.ok || !result.code) {
    res.status(500).json({ error: result.error ?? "Falha ao criar código" });
    return;
  }

  // URL absoluta do próprio servidor (mesmo host desta requisição).
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  res.json({ launchUrl: `${proto}://${host}/api/sso/launch?code=${result.code}` });
});

// GET /api/sso/launch?code= — Consume code, return auto-submit HTML.
// Aberto sem autenticação (roda no browser externo, sem cookies do app);
// a segurança vem do código one-time de 32 bytes CSPRNG com TTL 90s.
ssoRouter.get("/launch", async (req: Request, res: Response): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const result = await redeemLaunchCode(code);

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!result.ok) {
    res.status(result.status ?? 400).send(buildErrorHtml(result.error ?? "Erro desconhecido"));
    return;
  }
  res.type("html").send(result.html);
});
