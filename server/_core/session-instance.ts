import { createHmac, timingSafeEqual } from "node:crypto";
import { ENV } from "./env";

export const SESSION_INSTANCE_HEADER = "x-client-session-instance";
export const SESSION_PROTOCOL_HEADER = "x-client-session-protocol";
export const SESSION_BINDING_CAPABILITY = "exact-v1";
export const SESSION_BINDING_VERSION = 1 as const;

export type SessionBindingVersion = typeof SESSION_BINDING_VERSION;

export type SessionBindingCapabilityState = Readonly<{
  capability: typeof SESSION_BINDING_CAPABILITY;
  supported: boolean;
}>;

export type SessionBindingState = SessionBindingCapabilityState &
  Readonly<{
    sessionVersion: SessionBindingVersion | null;
  }>;

export type SessionInstanceConstraintErrorCode =
  | "MALFORMED_SESSION_INSTANCE"
  | "SESSION_INSTANCE_MISMATCH"
  | "SESSION_INSTANCE_REQUIRED";

const SESSION_INSTANCE_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;

export type SessionBindingProtocolErrorCode =
  | "MALFORMED_SESSION_PROTOCOL"
  | "SESSION_BINDING_REAUTH_REQUIRED"
  | "SESSION_BINDING_CAPABILITY_UNAVAILABLE";

export class SessionBindingProtocolError extends Error {
  constructor(
    readonly code: SessionBindingProtocolErrorCode,
    readonly status: 400 | 428 | 503,
  ) {
    super(
      code === "MALFORMED_SESSION_PROTOCOL"
        ? `${SESSION_PROTOCOL_HEADER} inválido`
        : code === "SESSION_BINDING_REAUTH_REQUIRED"
          ? "Entre novamente para ativar a proteção da sessão"
          : "O protocolo de vinculação de sessão solicitado não está disponível nesta réplica",
    );
    this.name = "SessionBindingProtocolError";
  }
}

export class SessionInstanceConstraintError extends Error {
  constructor(
    readonly code: SessionInstanceConstraintErrorCode,
    readonly status: 400 | 409 | 428,
  ) {
    super(
      code === "MALFORMED_SESSION_INSTANCE"
        ? `${SESSION_INSTANCE_HEADER} inválido`
        : code === "SESSION_INSTANCE_REQUIRED"
          ? "Atualize a aplicação antes de executar esta operação"
          : "A sessão autenticada não corresponde à instância esperada",
    );
    this.name = "SessionInstanceConstraintError";
  }
}

/**
 * Constraint opaca do JWT exato, nunca autoridade. O HMAC evita publicar um
 * hash reutilizável do token e permanece estável somente para esta instalação
 * do servidor e para esta credencial específica.
 */
export function sessionInstanceProof(sessionToken: string): string {
  const digest = createHmac("sha256", ENV.cookieSecret)
    .update("escala-session-instance-v1\0")
    .update(sessionToken)
    .digest("base64url");
  return `v1.${digest}`;
}

/**
 * Negotiation is explicit and closed: an unknown value is never interpreted
 * as legacy and `exact-v1` is never silently downgraded when the runtime gate
 * is disabled.
 */
export function parseRequestedSessionBindingVersion(
  rawHeader: unknown,
  capabilitySupported: boolean,
): SessionBindingVersion | null {
  if (rawHeader === undefined) return null;
  if (rawHeader !== SESSION_BINDING_CAPABILITY) {
    throw new SessionBindingProtocolError("MALFORMED_SESSION_PROTOCOL", 400);
  }
  if (!capabilitySupported) {
    throw new SessionBindingProtocolError(
      "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
      503,
    );
  }
  return SESSION_BINDING_VERSION;
}

/**
 * A rotation inherits exact-v1 from the authenticated JWT even during a
 * rollout rollback. A legacy token can opt in only while this replica
 * advertises the capability; it is never upgraded by the proof header alone.
 */
export function resolveSessionBindingVersionForRotation(
  rawHeader: unknown,
  capabilitySupported: boolean,
  currentVersion: SessionBindingVersion | null = null,
): SessionBindingVersion | null {
  if (currentVersion === SESSION_BINDING_VERSION) {
    if (rawHeader !== undefined && rawHeader !== SESSION_BINDING_CAPABILITY) {
      throw new SessionBindingProtocolError("MALFORMED_SESSION_PROTOCOL", 400);
    }
    return SESSION_BINDING_VERSION;
  }
  const requested = parseRequestedSessionBindingVersion(
    rawHeader,
    capabilitySupported,
  );
  if (requested === SESSION_BINDING_VERSION) {
    throw new SessionBindingProtocolError(
      "SESSION_BINDING_REAUTH_REQUIRED",
      428,
    );
  }
  return null;
}

export function sessionBindingCapabilityState(
  supported: boolean,
): SessionBindingCapabilityState {
  return { capability: SESSION_BINDING_CAPABILITY, supported };
}

export function sessionBindingState(
  supported: boolean,
  sessionVersion: SessionBindingVersion | null,
): SessionBindingState {
  return {
    ...sessionBindingCapabilityState(supported),
    sessionVersion,
  };
}

function parseSessionInstanceConstraint(rawHeader: unknown): string | null {
  if (rawHeader === undefined) return null;
  if (
    typeof rawHeader !== "string" ||
    !SESSION_INSTANCE_PATTERN.test(rawHeader)
  ) {
    throw new SessionInstanceConstraintError("MALFORMED_SESSION_INSTANCE", 400);
  }
  return rawHeader;
}

export function assertSessionInstanceConstraint(
  rawHeader: unknown,
  authenticatedSessionToken: string | undefined,
  options: Readonly<{
    required?: boolean;
    allowMissingCredential?: boolean;
  }> = {},
): void {
  const expected = parseSessionInstanceConstraint(rawHeader);
  if (expected === null) {
    if (options.required) {
      throw new SessionInstanceConstraintError(
        "SESSION_INSTANCE_REQUIRED",
        428,
      );
    }
    return;
  }
  if (!authenticatedSessionToken) {
    if (options.allowMissingCredential) return;
    throw new SessionInstanceConstraintError("SESSION_INSTANCE_MISMATCH", 409);
  }
  const actual = sessionInstanceProof(authenticatedSessionToken);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (
    expectedBytes.length !== actualBytes.length ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    throw new SessionInstanceConstraintError("SESSION_INSTANCE_MISMATCH", 409);
  }
}
