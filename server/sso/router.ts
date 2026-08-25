// server/sso/router.ts — SSO endpoints (JWKS + token generation + launch)
import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { AuthenticationInfrastructureError, sdk } from "../_core/sdk";
import { getJwks } from "./keys";
import { generateHandoffToken } from "./generate";
import { createLaunchCode, redeemLaunchCode, buildErrorHtml } from "./launch";
import {
  listActiveInstitutionIdsForUser,
  parseTenantIdHeader,
} from "../_core/tenant";
import { resolveTrustedPublicBaseUrl } from "../_core/public-url";
import { ExpectedUserConstraintError } from "../_core/expected-user";
import { SessionInstanceConstraintError } from "../_core/session-instance";

export const ssoRouter = Router();

class SsoInstitutionAccessError extends Error {}

async function resolveSsoInstitution(
  userId: number,
  institutionId: number,
): Promise<number> {
  const allowedInstitutionIds = await listActiveInstitutionIdsForUser(userId);
  if (
    allowedInstitutionIds.length === 0 ||
    !allowedInstitutionIds.includes(institutionId)
  ) {
    throw new SsoInstitutionAccessError();
  }
  return institutionId;
}

// GET /.well-known/jwks.json — Public key for Comunica+ to verify tokens
ssoRouter.get(
  "/jwks.json",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const jwks = await getJwks();
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.json(jwks);
    } catch {
      console.error("[SSO] JWKS_GENERATION_FAILED");
      res.status(500).json({ error: "Falha ao gerar JWKS" });
    }
  },
);

// POST /api/sso/generate — Generate handoff token (authenticated)
ssoRouter.post(
  "/generate",
  async (req: Request, res: Response): Promise<void> => {
    // 1. Authenticate
    let user;
    try {
      user = await sdk.authenticateRequest(req);
    } catch (error) {
      if (error instanceof AuthenticationInfrastructureError) {
        res.status(error.status).json({
          error: "Infraestrutura de autenticação indisponível",
          code: error.code,
        });
        return;
      }
      if (
        error instanceof ExpectedUserConstraintError ||
        error instanceof SessionInstanceConstraintError
      ) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      res.status(401).json({ error: "Não autenticado" });
      return;
    }

    // 2. Validate input
    const { clientNonce } = req.body as { clientNonce?: unknown };
    const normalizedClientNonce =
      typeof clientNonce === "string" ? clientNonce.trim() : "";
    if (!normalizedClientNonce || normalizedClientNonce.length > 191) {
      res
        .status(400)
        .json({ error: "clientNonce deve ter entre 1 e 191 caracteres" });
      return;
    }

    // 3. Resolve tenant
    const parsedTenantId = parseTenantIdHeader(req.headers["x-tenant-id"]);
    if (parsedTenantId === null) {
      res
        .status(400)
        .json({ error: "x-tenant-id explicito e valido e obrigatorio" });
      return;
    }
    let institutionId: number;
    try {
      institutionId = await resolveSsoInstitution(user.id, parsedTenantId);
    } catch (error) {
      if (error instanceof SsoInstitutionAccessError) {
        res.status(403).json({ error: "Sem vínculo institucional ativo" });
        return;
      }
      console.error("[SSO] GENERATE_TENANT_RESOLUTION_FAILED");
      res.status(500).json({ error: "Falha ao validar vínculo institucional" });
      return;
    }

    // 4. Generate token. Role and identity are rebuilt canonically inside the
    // generator; no caller-provided or fallback role can enter the JWT.
    const result = await generateHandoffToken({
      user,
      institutionId,
      clientNonce: normalizedClientNonce,
    });

    if (!result.ok) {
      const statusMap = {
        no_active_duty: 422,
        context_conflict: 409,
        org_not_mapped: 503,
        invalid_input: 400,
        authority_invalid: 403,
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
  },
);

// POST /api/sso/launch-code — Create one-time launch code (authenticated).
// Mobile flow: the app opens the returned launchUrl in the external
// browser; GET /launch consumes the code and completes the handoff there.
ssoRouter.post(
  "/launch-code",
  async (req: Request, res: Response): Promise<void> => {
    let user;
    try {
      user = await sdk.authenticateRequest(req);
    } catch (error) {
      if (error instanceof AuthenticationInfrastructureError) {
        res.status(error.status).json({
          error: "Infraestrutura de autenticação indisponível",
          code: error.code,
        });
        return;
      }
      if (
        error instanceof ExpectedUserConstraintError ||
        error instanceof SessionInstanceConstraintError
      ) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      res.status(401).json({ error: "Não autenticado" });
      return;
    }

    const parsedTenantId = parseTenantIdHeader(req.headers["x-tenant-id"]);
    if (parsedTenantId === null) {
      res
        .status(400)
        .json({ error: "x-tenant-id explicito e valido e obrigatorio" });
      return;
    }
    let institutionId: number;
    try {
      institutionId = await resolveSsoInstitution(user.id, parsedTenantId);
    } catch (error) {
      if (error instanceof SsoInstitutionAccessError) {
        res.status(403).json({ error: "Sem vínculo institucional ativo" });
        return;
      }
      console.error("[SSO] LAUNCH_TENANT_RESOLUTION_FAILED");
      res.status(500).json({ error: "Falha ao validar vínculo institucional" });
      return;
    }

    const rawClientNonce = (req.body as { clientNonce?: unknown })?.clientNonce;
    if (rawClientNonce !== undefined && typeof rawClientNonce !== "string") {
      res.status(400).json({ error: "clientNonce invalido" });
      return;
    }
    const clientNonce =
      typeof rawClientNonce === "string" ? rawClientNonce.trim() : randomUUID();
    if (!clientNonce || clientNonce.length > 191) {
      res
        .status(400)
        .json({ error: "clientNonce deve ter entre 1 e 191 caracteres" });
      return;
    }

    const publicBaseUrl = resolveTrustedPublicBaseUrl();
    if (!publicBaseUrl) {
      console.error(
        "[SSO] APP_PUBLIC_URL ausente ou invalida; launch-code bloqueado",
      );
      res.status(503).json({ error: "Login automatico indisponivel" });
      return;
    }

    const result = await createLaunchCode(
      user.id,
      institutionId,
      clientNonce,
      user.sessionVersion,
    );
    if (!result.ok || !result.code) {
      res
        .status(result.status ?? 500)
        .json({ error: result.error ?? "Falha ao criar código" });
      return;
    }

    res.json({
      launchUrl: `${publicBaseUrl}/api/sso/launch?code=${result.code}`,
    });
  },
);

// GET /api/sso/launch?code= — Consume code, return auto-submit HTML.
// Aberto sem autenticação (roda no browser externo, sem cookies do app);
// a segurança vem de 28 bytes CSPRNG + sessionVersion, one-time e TTL 90s.
ssoRouter.get("/launch", async (req: Request, res: Response): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const result = await redeemLaunchCode(code);

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!result.ok) {
    res
      .status(result.status ?? 400)
      .send(buildErrorHtml(result.error ?? "Erro desconhecido"));
    return;
  }
  res.type("html").send(result.html);
});
