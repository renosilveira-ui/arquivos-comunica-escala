import { createRemoteJWKSet, jwtVerify, type JWTPayload, errors as joseErrors } from "jose";
import { z } from "zod";
import { ENV } from "./env";

const claimsSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  tenant_key: z.string().min(1),
  iss: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  email: z.string().email().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
});

type VerifiedSsoClaims = z.infer<typeof claimsSchema>;

let cachedJwksUri: string | null = null;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwksClient() {
  const jwksUri = ENV.comunicaJwksUri.trim();
  if (!jwksUri) {
    throw new Error("COMUNICA_JWKS_URI não configurado");
  }

  if (!cachedJwks || cachedJwksUri !== jwksUri) {
    cachedJwks = createRemoteJWKSet(new URL(jwksUri));
    cachedJwksUri = jwksUri;
  }

  return cachedJwks;
}

export async function verifyComunicamaisSsoToken(token: string): Promise<VerifiedSsoClaims> {
  if (!ENV.comunicaIssuer.trim()) {
    throw new Error("COMUNICA_ISSUER não configurado");
  }
  if (!ENV.comunicaAudience.trim()) {
    throw new Error("COMUNICA_AUDIENCE não configurado");
  }

  const { payload } = await jwtVerify(token, getJwksClient(), {
    algorithms: ["RS256"],
    issuer: ENV.comunicaIssuer,
    audience: ENV.comunicaAudience,
  });

  const parsed = claimsSchema.safeParse(payload as JWTPayload);
  if (!parsed.success) {
    throw new Error("Token SSO inválido: claims obrigatórios ausentes");
  }

  return parsed.data;
}

export function isSsoJwtError(error: unknown): boolean {
  return error instanceof joseErrors.JWTExpired || error instanceof joseErrors.JOSEError;
}
