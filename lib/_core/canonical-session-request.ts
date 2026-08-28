import { Platform } from "react-native";
import { getApiBaseUrl } from "./api-base-url";
import { withRequestDeadline } from "../request-deadline";
import { getActiveWebSessionWorkflowSignal } from "./web-session-workflow";

const EXPECTED_SESSION_USER_HEADER = "x-client-expected-user-id";

export type CanonicalSessionRequestResult<T> = Readonly<{
  ok: boolean;
  status: number;
  data: T | null;
  credentialPresented: boolean;
}>;

/**
 * Prova de que o servidor recusou uma credencial realmente recebida.
 * Abort/rede nunca conta: o fetch não completou. Na web, `credentials:
 * include` só pede o cookie — só o body do `/me` confirma se ele chegou.
 */
export function resolveCredentialPresented(input: {
  requestCompleted: boolean;
  nativeAuthorizationAttached: boolean;
  webCredentialsIncluded: boolean;
  responseData: unknown;
}): boolean {
  if (!input.requestCompleted) return false;
  if (input.nativeAuthorizationAttached) return true;
  if (!input.webCredentialsIncluded) return false;
  return (
    typeof input.responseData === "object" &&
    input.responseData !== null &&
    (input.responseData as { credentialPresented?: unknown })
      .credentialPresented === true
  );
}

export async function requestCanonicalSession<T>(input: {
  expectedUserId?: number;
  nativeToken?: string;
}): Promise<CanonicalSessionRequestResult<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (input.expectedUserId !== undefined) {
    headers[EXPECTED_SESSION_USER_HEADER] = String(input.expectedUserId);
  }
  if (Platform.OS !== "web" && input.nativeToken) {
    headers.Authorization = `Bearer ${input.nativeToken}`;
  }
  const nativeAuthorizationAttached = headers.Authorization !== undefined;
  const webCredentialsIncluded = Platform.OS === "web";
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  const deadline = withRequestDeadline(workflowSignal ?? undefined);
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
      headers,
      cache: "no-store",
      ...(Platform.OS === "web" ? { credentials: "include" as const } : {}),
      signal: deadline.signal,
    });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      credentialPresented: resolveCredentialPresented({
        requestCompleted: true,
        nativeAuthorizationAttached,
        webCredentialsIncluded,
        responseData: data,
      }),
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      credentialPresented: resolveCredentialPresented({
        requestCompleted: false,
        nativeAuthorizationAttached,
        webCredentialsIncluded,
        responseData: null,
      }),
    };
  } finally {
    deadline.cleanup();
  }
}
