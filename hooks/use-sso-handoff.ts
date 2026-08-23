import { getApiBaseUrl } from "@/lib/_core/api";
// hooks/use-sso-handoff.ts — SSO handoff flow: Escala → Comunica+
import { useCallback, useRef, useState } from "react";
import { Platform } from "react-native";

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
      // ── Mobile: launch-code ──────────────────────────────────────
      // O handoff acontece no BROWSER do médico (form auto-submit
      // servido por GET /api/sso/launch), que é onde a sessão/cookie
      // do Comunica+ precisa nascer. O fluxo antigo fazia o exchange
      // via fetch dentro do app e a sessão morria aqui. O /generate
      // também acontece server-side no resgate do código — nenhuma
      // chamada extra do app.
      if (Platform.OS !== "web") {
        // Fase 3: app nativo do Comunica+ primeiro; browser logado
        // (launch-code) apenas quando o app não está instalado.
        const { openComunica } = await import("@/lib/sso-launch");
        const launchResult = await openComunica(tenantId);
        if (!launchResult.ok) {
          setState({
            loading: false,
            error: launchResult.error ?? "Falha ao abrir Comunica+.",
            errorCode: null,
          });
          return;
        }
        setState({ loading: false, error: null, errorCode: null });
        return;
      }

      // ── Web: form POST direto ────────────────────────────────────
      // 1. Generate clientNonce
      const clientNonce = generateNonce();

      // 2. Build request headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (tenantId) {
        headers["x-tenant-id"] = String(tenantId);
      }

      // 3. Call /api/sso/generate
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/sso/generate`, {
        method: "POST",
        headers,
        credentials: "include",
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

      // 4. Send handoff token to Comunica+ — form POST (never query string)
      submitFormPost(data.targetUrl, {
        handoffToken: data.handoffToken,
        handoffMethod: "REDIRECT_CODE",
        clientNonce,
        sourceApp: "ESCALAS_WEB",
        responseMode: "redirect",
        redirectTo: "/entry",
      });
      // Form submit navigates away; loading stays true
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
