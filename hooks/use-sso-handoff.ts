import { apiFetch } from "@/lib/_core/api";
import * as Auth from "@/lib/_core/auth";
import { getActiveTenantSnapshot } from "@/lib/tenant-state";
// hooks/use-sso-handoff.ts — SSO handoff flow: Escala → Comunica+
import { useCallback, useEffect, useRef, useState } from "react";
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
  code?:
    | "no_active_duty"
    | "context_conflict"
    | "org_not_mapped"
    | "invalid_input"
    | "authority_invalid"
    | "internal_error";
}

interface SsoState {
  loading: boolean;
  error: string | null;
  errorCode: string | null;
}

interface NonceCryptoSource {
  randomUUID?: () => string;
  getRandomValues?: (target: Uint8Array) => Uint8Array;
}

const INITIAL_SSO_STATE: SsoState = {
  loading: false,
  error: null,
  errorCode: null,
};
const SSO_CONNECTION_FAILED_MESSAGE =
  "Não foi possível conectar ao Comunica+. Tente novamente.";
const SSO_INVALID_RESPONSE_MESSAGE =
  "O Comunica+ devolveu uma resposta inválida. Tente novamente.";

type SsoRequest = Readonly<{
  signal: AbortSignal;
  isCurrent: () => boolean;
}>;

export type SsoHandoffFence = Readonly<{
  begin: () => SsoRequest;
  invalidate: () => void;
}>;

export function createSsoHandoffFence(): SsoHandoffFence {
  let generation = 0;
  let activeController: AbortController | null = null;
  return {
    begin() {
      activeController?.abort();
      const controller = new AbortController();
      const requestGeneration = ++generation;
      activeController = controller;
      return {
        signal: controller.signal,
        isCurrent: () =>
          !controller.signal.aborted &&
          generation === requestGeneration &&
          activeController === controller,
      };
    },
    invalidate() {
      generation += 1;
      activeController?.abort();
      activeController = null;
    },
  };
}

type WebSsoResult =
  | { ok: true }
  | { ok: false; cancelled: true }
  | { ok: false; error: string; errorCode: string | null };

function parseSsoErrorCode(value: unknown): SsoErrorResponse["code"] {
  if (
    value === "EXPECTED_USER_MISMATCH" ||
    value === "MALFORMED_EXPECTED_USER_ID" ||
    value === "SESSION_INSTANCE_MISMATCH" ||
    value === "SESSION_INSTANCE_REQUIRED" ||
    value === "MALFORMED_SESSION_INSTANCE"
  ) {
    return "authority_invalid";
  }
  return value === "no_active_duty" ||
    value === "context_conflict" ||
    value === "org_not_mapped" ||
    value === "invalid_input" ||
    value === "authority_invalid" ||
    value === "internal_error"
    ? value
    : undefined;
}

function controlledSsoError(code: SsoErrorResponse["code"]): string {
  switch (code) {
    case "no_active_duty":
      return "Você não tem plantão ou sobreaviso ativo neste momento.";
    case "context_conflict":
      return "Há mais de um plantão ativo. Selecione o contexto antes de continuar.";
    case "org_not_mapped":
      return "Esta instituição ainda não está habilitada no Comunica+.";
    case "invalid_input":
      return "Não foi possível iniciar o login automático.";
    case "authority_invalid":
      return "Sua sessão ou vínculo institucional mudou. Entre novamente.";
    default:
      return SSO_CONNECTION_FAILED_MESSAGE;
  }
}

export function generateSsoClientNonce(
  source: NonceCryptoSource | undefined = globalThis.crypto,
): string {
  if (source?.randomUUID) {
    return source.randomUUID();
  }
  if (!source?.getRandomValues) {
    throw new Error("Gerador criptográfico indisponível para iniciar o SSO");
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function runWebSsoHandoff(
  tenantId: number,
  request: SsoRequest,
  submit: typeof submitFormPost = submitFormPost,
): Promise<WebSsoResult> {
  try {
    // O form POST é um efeito irreversível sob o cookie do navegador. O mesmo
    // Web Lock que cerca login/logout precisa abranger ticket → generate →
    // submit, impedindo que outra aba troque a identidade entre a resposta e a
    // navegação.
    return await Auth.runExclusiveWebSessionMutation(async (workflowSignal) => {
      const transportTicket = Auth.captureSessionTransportTicket();
      const isCurrent = () =>
        workflowSignal?.aborted !== true &&
        transportTicket !== null &&
        request.isCurrent() &&
        Auth.isSessionTransportTicketCurrent(transportTicket);
      if (!isCurrent()) return { ok: false, cancelled: true };

      const clientNonce = generateSsoClientNonce();
      const res = await apiFetch<
        Partial<SsoGenerateResponse> & SsoErrorResponse
      >("/api/sso/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": String(tenantId),
        },
        body: JSON.stringify({ clientNonce }),
        signal: request.signal,
      });

      if (!isCurrent()) return { ok: false, cancelled: true };
      if (!res.ok) {
        const errorCode = parseSsoErrorCode(res.data?.code);
        return {
          ok: false,
          error: controlledSsoError(errorCode),
          errorCode: errorCode ?? null,
        };
      }

      const data = res.data;
      if (!isCurrent()) return { ok: false, cancelled: true };
      if (
        typeof data?.targetUrl !== "string" ||
        !data.targetUrl ||
        typeof data.handoffToken !== "string" ||
        !data.handoffToken
      ) {
        return {
          ok: false,
          error: SSO_INVALID_RESPONSE_MESSAGE,
          errorCode: null,
        };
      }

      const submitted = submit(
        data.targetUrl,
        {
          handoffToken: data.handoffToken,
          handoffMethod: "REDIRECT_CODE",
          clientNonce,
          sourceApp: "ESCALAS_WEB",
          responseMode: "redirect",
          redirectTo: "/entry",
        },
        isCurrent,
      );
      return submitted ? { ok: true } : { ok: false, cancelled: true };
    });
  } catch {
    return request.isCurrent()
      ? { ok: false, error: SSO_CONNECTION_FAILED_MESSAGE, errorCode: null }
      : { ok: false, cancelled: true };
  }
}

export function useSsoHandoff(activeTenantId: number | null | undefined) {
  const [state, setState] = useState<SsoState>(INITIAL_SSO_STATE);
  const fenceRef = useRef<SsoHandoffFence | null>(null);
  if (fenceRef.current === null) fenceRef.current = createSsoHandoffFence();

  useEffect(() => {
    setState(INITIAL_SSO_STATE);
    const fence = fenceRef.current;
    return () => fence?.invalidate();
  }, [activeTenantId]);

  const launch = useCallback(async () => {
    const fenceRequest = fenceRef.current!.begin();
    const tenantSnapshot = getActiveTenantSnapshot();
    const request: SsoRequest = {
      signal: fenceRequest.signal,
      isCurrent: () => {
        if (
          !fenceRequest.isCurrent() ||
          tenantSnapshot.institutionId !== activeTenantId
        ) {
          return false;
        }
        const liveTenant = getActiveTenantSnapshot();
        return (
          liveTenant.institutionId === tenantSnapshot.institutionId &&
          liveTenant.revision === tenantSnapshot.revision
        );
      },
    };

    // A prop React pode ficar atrasada em relação à memória síncrona do tenant.
    // Não inicia rede nem loading se a troca já aconteceu.
    if (!request.isCurrent()) return;

    setState({ loading: true, error: null, errorCode: null });

    try {
      const { isValidSsoTenantId } = await import("@/lib/sso-launch");
      if (!request.isCurrent()) return;
      if (!isValidSsoTenantId(activeTenantId)) {
        setState({
          loading: false,
          error: "Selecione uma instituicao valida antes de abrir o Comunica+.",
          errorCode: "invalid_input",
        });
        return;
      }

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
        if (!request.isCurrent()) return;
        const launchResult = await openComunica(activeTenantId, {
          signal: request.signal,
          canNavigate: request.isCurrent,
        });
        if (!request.isCurrent()) return;
        if (!launchResult.ok) {
          setState({
            loading: false,
            error: launchResult.error ?? SSO_CONNECTION_FAILED_MESSAGE,
            errorCode: null,
          });
          return;
        }
        setState({ loading: false, error: null, errorCode: null });
        return;
      }

      const result = await runWebSsoHandoff(activeTenantId, request);
      if (!request.isCurrent() || "cancelled" in result) return;
      if (!result.ok) {
        setState({
          loading: false,
          error: result.error,
          errorCode: result.errorCode,
        });
        return;
      }
      // Form submit navigates away; loading stays true
    } catch {
      if (!request.isCurrent()) return;
      setState({
        loading: false,
        error: SSO_CONNECTION_FAILED_MESSAGE,
        errorCode: null,
      });
    }
  }, [activeTenantId]);

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
function submitFormPost(
  url: string,
  fields: Record<string, string>,
  canSubmit: () => boolean,
): boolean {
  if (!canSubmit()) return false;
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
  // Último fence antes da navegação irreversível e depois da montagem do DOM.
  if (!canSubmit()) {
    form.remove();
    return false;
  }
  form.submit();
  return true;
}
