// hooks/use-sso-handoff.ts — SSO handoff flow: Escala → Comunica+
import { useCallback, useRef, useState } from "react";
import { Platform, Linking } from "react-native";
import * as Auth from "@/lib/_core/auth";

interface DutyContext {
  dutyType: "PLANTAO" | "SOBREAVISO";
  serviceName: string;
  dutyStart: string;
  dutyEnd: string;
}

interface SsoGenerateResponse {
  handoffToken: string;
  targetUrl: string;
  dutyContext: DutyContext;
}

interface SsoErrorResponse {
  error: string;
  code: "no_active_duty" | "context_conflict" | "org_not_mapped" | "internal_error";
}

interface SsoState {
  loading: boolean;
  error: string | null;
  errorCode: string | null;
}

function getBaseUrl(): string {
  const envUrl = (process.env.EXPO_PUBLIC_API_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/$/, "");
  const fallbackPort = (process.env.EXPO_PUBLIC_API_PORT || "3000").trim();
  if (Platform.OS === "android") return `http://10.0.2.2:${fallbackPort}`;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${fallbackPort}`;
  }
  return `http://localhost:${fallbackPort}`;
}

function generateNonce(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useSsoHandoff() {
  const [state, setState] = useState<SsoState>({
    loading: false,
    error: null,
    errorCode: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const launch = useCallback(async (tenantId?: number) => {
    // Prevent double-trigger
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ loading: true, error: null, errorCode: null });

    try {
      // 1. Generate clientNonce
      const clientNonce = generateNonce();

      // 2. Build request headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (tenantId) {
        headers["x-tenant-id"] = String(tenantId);
      }

      // Platform-specific auth
      if (Platform.OS !== "web") {
        const token = await Auth.getSessionToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
      }

      // 3. Call /api/sso/generate
      const baseUrl = getBaseUrl();
      const res = await fetch(`${baseUrl}/api/sso/generate`, {
        method: "POST",
        headers,
        credentials: Platform.OS === "web" ? "include" : undefined,
        body: JSON.stringify({ clientNonce }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as SsoErrorResponse | null;
        setState({
          loading: false,
          error: errBody?.error ?? `Erro ${res.status} ao gerar token SSO.`,
          errorCode: errBody?.code ?? null,
        });
        return;
      }

      const data = (await res.json()) as SsoGenerateResponse;

      // 4. Send handoff token to Comunica+
      if (Platform.OS === "web") {
        // Web: Form POST (never query string)
        submitFormPost(data.targetUrl, {
          handoffToken: data.handoffToken,
          handoffMethod: "REDIRECT_CODE",
          clientNonce,
          sourceApp: "ESCALAS_WEB",
          responseMode: "redirect",
          redirectTo: "/entry",
        });
        // Form submit navigates away; loading stays true
        return;
      }

      // Mobile: JSON POST
      const exchangeRes = await fetch(data.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handoffToken: data.handoffToken,
          handoffMethod: "BACKEND_TOKEN_EXCHANGE",
          clientNonce,
          sourceApp: "ESCALAS_MOBILE",
          responseMode: "json",
        }),
        signal: controller.signal,
      });

      if (!exchangeRes.ok) {
        const errBody = await exchangeRes.json().catch(() => null);
        const msg =
          (errBody as any)?.message ??
          (errBody as any)?.error ??
          `Comunica+ retornou ${exchangeRes.status}`;
        setState({ loading: false, error: msg, errorCode: (errBody as any)?.code ?? null });
        return;
      }

      const exchangeData = (await exchangeRes.json()) as {
        ok: boolean;
        session?: { accessToken: string };
      };

      if (!exchangeData.ok || !exchangeData.session?.accessToken) {
        setState({ loading: false, error: "Resposta SSO inválida do Comunica+.", errorCode: null });
        return;
      }

      // Open Comunica+ with the session token
      // The mobile app would typically deep-link or open a WebView
      const comunicaUrl = data.targetUrl.replace("/auth/sso/exchange", "");
      const deepLink = `${comunicaUrl}/entry?sso_session=1`;
      await Linking.openURL(deepLink);

      setState({ loading: false, error: null, errorCode: null });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState({
        loading: false,
        error: (err as Error).message || "Falha ao conectar com Comunica+.",
        errorCode: null,
      });
    }
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null, errorCode: null }));
  }, []);

  return {
    launch,
    clearError,
    loading: state.loading,
    error: state.error,
    errorCode: state.errorCode,
  };
}

/**
 * Submits a form POST (web only). The handoff token travels in the body,
 * never in URL/query string. Content-Type: application/x-www-form-urlencoded.
 */
function submitFormPost(url: string, fields: Record<string, string>) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.style.display = "none";

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}
