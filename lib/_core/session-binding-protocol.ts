export const SESSION_BINDING_CAPABILITY = "exact-v1" as const;
export const SESSION_BINDING_PROTOCOL_HEADER =
  "x-client-session-protocol" as const;

export type SessionBindingCapabilityState = Readonly<{
  capability: typeof SESSION_BINDING_CAPABILITY;
  supported: boolean;
}>;

export type SessionBindingState = SessionBindingCapabilityState &
  Readonly<{
    sessionVersion: 1 | null;
  }>;

export class SessionBindingClientConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBindingClientConfigurationError";
  }
}

/**
 * O build continua legacy por padrão. Qualquer valor ambíguo falha fechado em
 * vez de habilitar ou desabilitar silenciosamente uma fronteira de sessão.
 */
export function exactSessionBindingClientActive(): boolean {
  const value = (
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE ?? "0"
  ).trim();
  if (value === "0" || value === "") return false;
  if (value === "1") return true;
  throw new SessionBindingClientConfigurationError(
    "EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE deve ser 0 ou 1",
  );
}

export function requestedSessionBindingProtocol():
  typeof SESSION_BINDING_CAPABILITY | undefined {
  return exactSessionBindingClientActive()
    ? SESSION_BINDING_CAPABILITY
    : undefined;
}

export function isSupportedExactSessionBindingCapability(
  value: unknown,
): value is SessionBindingCapabilityState & Readonly<{ supported: true }> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { capability?: unknown }).capability ===
      SESSION_BINDING_CAPABILITY &&
    (value as { supported?: unknown }).supported === true
  );
}

export function isSupportedExactSessionBinding(
  value: unknown,
): value is SessionBindingState &
  Readonly<{ supported: true; sessionVersion: 1 }> {
  return (
    isSupportedExactSessionBindingCapability(value) &&
    (value as { sessionVersion?: unknown }).sessionVersion === 1
  );
}
