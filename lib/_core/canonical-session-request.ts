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
  const credentialPresented =
    Platform.OS === "web" || headers.Authorization !== undefined;
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
      credentialPresented,
    };
  } catch {
    return { ok: false, status: 0, data: null, credentialPresented };
  } finally {
    deadline.cleanup();
  }
}
