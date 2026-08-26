// lib/_core/api.ts — Wrapper HTTP para chamadas à API do server.
//
// ÚNICA fonte da URL base e dos headers de sessão/tenant do app. Cópias
// locais (admin, aprovar trocas, SSO) divergiam: na web same-origin
// (EXPO_PUBLIC_API_URL="" no Render) caíam em http://localhost:3000 e não
// mandavam x-tenant-id — auditoria 22/08, parte 2.
import { Platform } from "react-native";
import * as Auth from "./auth";
import { getApiBaseUrl } from "./api-base-url";
import {
  isSupportedExactSessionBindingCapability,
  requestedSessionBindingProtocol,
  SESSION_BINDING_PROTOCOL_HEADER,
  type SessionBindingCapabilityState,
  type SessionBindingState,
} from "./session-binding-protocol";
import { getActiveWebSessionWorkflowSignal } from "./web-session-workflow";
import { getActiveInstitutionId } from "../tenant-state";
import type {
  MedicalSpecialtyCode,
  OperationalProfileCode,
} from "../medical-specialties";

export { getApiBaseUrl } from "./api-base-url";

let sessionMutationTail: Promise<void> = Promise.resolve();

type ApiFetchResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  /**
   * Prova local de que o request saiu pelo canal autenticado. No nativo isto
   * significa um Bearer efetivamente anexado; no web, `credentials: include`
   * enviou o cookie corrente ao mesmo origin. Um 401 nativo sem esta prova
   * não autoriza apagar a única credencial local.
   */
  credentialPresented: boolean;
};

type ApiTransportMode = "normal" | "auth-transition" | "public";
const EXPECTED_SESSION_USER_HEADER = "x-client-expected-user-id";
const SESSION_INSTANCE_HEADER = "x-client-session-instance";

export type AuthMutationErrorCode =
  | "EXPECTED_USER_MISMATCH"
  | "MALFORMED_EXPECTED_USER_ID"
  | "SESSION_INSTANCE_MISMATCH"
  | "MALFORMED_SESSION_INSTANCE"
  | "SESSION_INSTANCE_REQUIRED"
  | "MALFORMED_SESSION_PROTOCOL"
  | "SESSION_BINDING_CAPABILITY_UNAVAILABLE"
  | "SESSION_BINDING_REAUTH_REQUIRED";

class AuthMutationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: AuthMutationErrorCode,
  ) {
    super(message);
    this.name = "AuthMutationRequestError";
  }
}

export function isExpectedUserMismatchError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    isSessionMutationMismatchCode((error as { code?: unknown }).code)
  );
}

export function isSessionMutationMismatchCode(value: unknown): boolean {
  return (
    value === "EXPECTED_USER_MISMATCH" || value === "SESSION_INSTANCE_MISMATCH"
  );
}

function authMutationErrorCode(
  value: unknown,
): AuthMutationErrorCode | undefined {
  return value === "EXPECTED_USER_MISMATCH" ||
    value === "MALFORMED_EXPECTED_USER_ID" ||
    value === "SESSION_INSTANCE_MISMATCH" ||
    value === "MALFORMED_SESSION_INSTANCE" ||
    value === "SESSION_INSTANCE_REQUIRED" ||
    value === "MALFORMED_SESSION_PROTOCOL" ||
    value === "SESSION_BINDING_CAPABILITY_UNAVAILABLE" ||
    value === "SESSION_BINDING_REAUTH_REQUIRED"
    ? value
    : undefined;
}

function blockedTransportResult<T>(message: string): ApiFetchResult<T> {
  return {
    ok: false,
    status: 0,
    data: null,
    error: message,
    credentialPresented: false,
  };
}

/**
 * Serializa as únicas chamadas que podem criar/limpar a sessão HTTP. No web,
 * o navegador aplica Set-Cookie antes de o CAS React observar a resposta;
 * manter a ordem de intenção impede dois logins do mesmo AuthProvider de
 * terminarem com UI B e cookie A.
 */
function serializeSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionMutationTail.then(operation, operation);
  sessionMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function mergeAbortSignals(
  callerSignal: AbortSignal | null | undefined,
  workflowSignal: AbortSignal | null,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  const signals = Array.from(
    new Set(
      [callerSignal ?? undefined, workflowSignal ?? undefined].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    ),
  );
  if (signals.length <= 1) {
    return { signal: signals[0], cleanup: () => undefined };
  }

  const controller = new AbortController();
  const listeners: (readonly [AbortSignal, () => void])[] = [];
  for (const source of signals) {
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(source.reason);
    };
    if (source.aborted) abort();
    else {
      source.addEventListener("abort", abort, { once: true });
      listeners.push([source, abort]);
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [source, listener] of listeners) {
        source.removeEventListener("abort", listener);
      }
    },
  };
}

async function apiFetchInternal<T>(
  path: string,
  options?: RequestInit,
  quarantinedSessionToken?: string,
  transportMode: ApiTransportMode = "normal",
  expectedSessionUserId?: number,
  sessionTransitionCredential?: Auth.SessionTransitionCredential,
  expectedSessionInstance?: string,
  requestedSessionProtocol?: "exact-v1",
): Promise<ApiFetchResult<T>> {
  if (
    sessionTransitionCredential !== undefined &&
    (transportMode !== "auth-transition" ||
      quarantinedSessionToken !== undefined)
  ) {
    return blockedTransportResult(
      "Credencial de transição fora do canal autorizado",
    );
  }
  // REST protegido recebe o mesmo CAS do tRPC. O ticket é capturado antes de
  // tenant/token e repetido imediatamente antes de `fetch`, impedindo que uma
  // callback A atravesse BEGIN e saia com cookie/Bearer B.
  const transportTicket =
    transportMode === "normal"
      ? Auth.captureSessionTransportTicket()
      : undefined;
  if (transportMode === "normal" && transportTicket === null) {
    return blockedTransportResult(
      "Transporte bloqueado até a sessão ser revalidada",
    );
  }
  const transportExpectedUserId =
    transportMode === "normal" && typeof transportTicket === "number"
      ? Auth.getSessionTransportExpectedUserId(transportTicket)
      : expectedSessionUserId;
  const transportSessionInstance =
    transportMode === "normal" &&
    Platform.OS === "web" &&
    typeof transportTicket === "number"
      ? Auth.getSessionTransportSessionInstance(transportTicket)
      : undefined;
  if (
    (transportMode === "normal" || expectedSessionUserId !== undefined) &&
    (transportExpectedUserId === null ||
      transportExpectedUserId === undefined ||
      !Number.isSafeInteger(transportExpectedUserId) ||
      transportExpectedUserId <= 0)
  ) {
    return blockedTransportResult("Identidade esperada da sessão indisponível");
  }
  if (transportMode === "normal" && Platform.OS === "web") {
    if (!transportSessionInstance) {
      return blockedTransportResult(
        "Instância canônica da sessão web indisponível",
      );
    }
    const gate = await Auth.getWebSessionGateState();
    if (gate.state !== "CLEAR") {
      return blockedTransportResult(
        "Transporte web bloqueado por sessão em reconciliação",
      );
    }
  }
  const url = `${getApiBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };

  // `apiFetch` público nunca aceita autoridade escolhida pelo caller. O único
  // escape é privado, nativo e preso ao logout ou ao `/me` de recovery de um
  // Bearer ainda não admitido. Remova variações de caixa para não haver um
  // segundo header.
  for (const headerName of Object.keys(headers)) {
    if (
      headerName.toLowerCase() === "authorization" ||
      headerName.toLowerCase() === EXPECTED_SESSION_USER_HEADER ||
      headerName.toLowerCase() === SESSION_INSTANCE_HEADER ||
      headerName.toLowerCase() === SESSION_BINDING_PROTOCOL_HEADER
    )
      delete headers[headerName];
  }
  if (
    transportExpectedUserId !== null &&
    transportExpectedUserId !== undefined
  ) {
    headers[EXPECTED_SESSION_USER_HEADER] = String(transportExpectedUserId);
  }
  if (transportSessionInstance) {
    headers[SESSION_INSTANCE_HEADER] = transportSessionInstance;
  }
  if (expectedSessionInstance) {
    headers[SESSION_INSTANCE_HEADER] = expectedSessionInstance;
  }
  if (requestedSessionProtocol) {
    headers[SESSION_BINDING_PROTOCOL_HEADER] = requestedSessionProtocol;
  }
  if (quarantinedSessionToken !== undefined) {
    if (
      Platform.OS === "web" ||
      (path !== "/api/auth/logout" && path !== "/api/auth/me")
    ) {
      throw new Error("Override de sessão fora do endpoint de revogação");
    }
    headers.Authorization = `Bearer ${quarantinedSessionToken}`;
  }

  // Mesmo tenant que o tRPC (lib/trpc.ts): sem isto o servidor caía na
  // primeira instituição do usuário, não na ativa.
  if (transportMode !== "public") {
    const activeInstitutionId = await getActiveInstitutionId();
    if (activeInstitutionId) {
      headers["x-tenant-id"] = String(activeInstitutionId);
    }
  }

  if (sessionTransitionCredential !== undefined) {
    let authority: ReturnType<
      typeof Auth.consumeSessionTransitionCredentialForRequest
    >;
    try {
      authority = Auth.consumeSessionTransitionCredentialForRequest(
        sessionTransitionCredential,
        path,
        options?.method ?? "GET",
      );
    } catch (error) {
      return blockedTransportResult(
        error instanceof Error
          ? error.message
          : "Credencial de transição inválida",
      );
    }
    if (
      expectedSessionUserId !== undefined &&
      expectedSessionUserId !== authority.expectedUserId
    ) {
      return blockedTransportResult(
        "Identidade da credencial de transição divergente",
      );
    }
    headers[EXPECTED_SESSION_USER_HEADER] = String(authority.expectedUserId);
    if (authority.sessionInstance) {
      if (
        expectedSessionInstance !== undefined &&
        expectedSessionInstance !== authority.sessionInstance
      ) {
        return blockedTransportResult(
          "Instância da credencial de transição divergente",
        );
      }
      headers[SESSION_INSTANCE_HEADER] = authority.sessionInstance;
    }
    if (authority.authorization) {
      headers.Authorization = authority.authorization;
    }
  }

  if (Platform.OS !== "web" && transportMode !== "public") {
    const token =
      quarantinedSessionToken === undefined &&
      sessionTransitionCredential === undefined
        ? await Auth.getSessionToken()
        : null;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (transportMode === "normal" && !headers.Authorization) {
      return blockedTransportResult(
        "Bearer bloqueado até a sessão ser revalidada",
      );
    }
  }

  const credentialPresented =
    (Platform.OS === "web" && transportMode !== "public") ||
    Boolean(headers.Authorization);

  if (
    transportMode === "normal" &&
    (transportTicket == null ||
      !Auth.isSessionTransportTicketCurrent(transportTicket))
  ) {
    return blockedTransportResult("Sessão mudou antes do envio do request");
  }

  const workflowSignal = getActiveWebSessionWorkflowSignal();
  const requestAbort = mergeAbortSignals(options?.signal, workflowSignal);
  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: requestAbort.signal,
      credentials:
        Platform.OS === "web"
          ? transportMode === "public"
            ? "omit"
            : "include"
          : undefined,
    });
    let data: T | null = null;
    try {
      data = await res.json();
    } catch (error) {
      if (requestAbort.signal?.aborted) throw error;
      // Corpo vazio/malformado não muda o status HTTP, mas o deadline precisa
      // continuar conectado até esta leitura terminar para não reter o Web Lock.
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      credentialPresented,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Falha de conexão com o servidor.";
    return {
      ok: false,
      status: 0,
      data: null,
      error: message,
      credentialPresented,
    };
  } finally {
    requestAbort.cleanup();
  }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<ApiFetchResult<T>> {
  return apiFetchInternal<T>(path, options);
}

export type AuthUser = {
  id: number;
  name: string | null;
  email: string | null;
  role: "admin" | "manager" | "doctor" | "nurse" | "tech";
  /** PENDING = auto-cadastro aguardando aprovação do gestor (app bloqueado). */
  approvalStatus?: "PENDING" | "APPROVED";
  /** Senha temporária definida pelo admin: o app força a troca antes de qualquer tela. */
  mustChangePassword?: boolean;
};

export type SessionBindingStatus = SessionBindingState;

export type SessionBindingMutationPurpose =
  "login" | "rotate-session" | "delete-account";

declare const sessionBindingCapabilityReceiptBrand: unique symbol;

/**
 * Prova opaca, purpose-bound e one-shot de que o preflight exact-v1 terminou
 * antes de qualquer efeito local da mutação. Só `prepare...` consegue cunhá-la;
 * o endpoint a consome antes de enviar o primeiro byte mutante.
 */
export type SessionBindingCapabilityReceipt = Readonly<{
  [sessionBindingCapabilityReceiptBrand]: true;
}>;

const sessionBindingCapabilityReceipts = new WeakMap<
  object,
  Readonly<{
    purpose: SessionBindingMutationPurpose;
    requestedProtocol: "exact-v1" | undefined;
  }>
>();

type LoginResponse = {
  user: AuthUser;
  token?: string;
  sessionInstance?: string;
  sessionBinding?: SessionBindingStatus;
};
type MeResponse = { user: AuthUser };

export type SessionRevocationProof =
  | Readonly<{
      status: "ROTATED";
      revocationUserId: number;
    }>
  | Readonly<{
      status: "ALREADY_INVALID";
      revocationUserId?: number;
    }>;

type LogoutResponse = {
  ok?: boolean;
  sessionFenceRotated?: boolean;
  revocation?: unknown;
  revocationUserId?: unknown;
  error?: string;
  code?: string;
};

function sessionRevocationProof(
  data: LogoutResponse | null,
): SessionRevocationProof | null {
  if (data?.ok !== true) return null;

  const hasRevocationUserId = Object.prototype.hasOwnProperty.call(
    data,
    "revocationUserId",
  );
  const revocationUserId = data.revocationUserId;
  const hasValidRevocationUserId =
    typeof revocationUserId === "number" &&
    Number.isSafeInteger(revocationUserId) &&
    revocationUserId > 0;

  if (data.revocation === "ROTATED") {
    return hasRevocationUserId && hasValidRevocationUserId
      ? { status: "ROTATED", revocationUserId }
      : null;
  }
  if (data.revocation !== "ALREADY_INVALID") return null;
  if (!hasRevocationUserId) return { status: "ALREADY_INVALID" };
  return hasValidRevocationUserId
    ? { status: "ALREADY_INVALID", revocationUserId }
    : null;
}

type DetailedSessionResponse = Awaited<
  ReturnType<typeof Auth.validateCanonicalSession>
>;

async function requireExactSessionBindingCapability(): Promise<
  "exact-v1" | undefined
> {
  const protocol = requestedSessionBindingProtocol();
  if (!protocol) return undefined;
  const response = await apiFetchInternal<SessionBindingCapabilityState>(
    "/api/auth/session-binding-capability",
    { method: "GET", cache: "no-store" },
    undefined,
    "public",
  );
  if (
    !response.ok ||
    !isSupportedExactSessionBindingCapability(response.data)
  ) {
    throw new AuthMutationRequestError(
      "O servidor ainda não confirmou suporte global ao protocolo exact-v1",
      response.status,
      "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
    );
  }
  return protocol;
}

async function prepareSessionBindingMutation(
  purpose: SessionBindingMutationPurpose,
): Promise<SessionBindingCapabilityReceipt> {
  const requestedProtocol = await requireExactSessionBindingCapability();
  const receipt = Object.freeze({}) as SessionBindingCapabilityReceipt;
  sessionBindingCapabilityReceipts.set(receipt, {
    purpose,
    requestedProtocol,
  });
  return receipt;
}

async function consumeSessionBindingCapabilityReceipt(
  purpose: SessionBindingMutationPurpose,
  receipt?: SessionBindingCapabilityReceipt,
): Promise<"exact-v1" | undefined> {
  if (!receipt) return requireExactSessionBindingCapability();
  const state = sessionBindingCapabilityReceipts.get(receipt);
  sessionBindingCapabilityReceipts.delete(receipt);
  if (!state || state.purpose !== purpose) {
    throw new AuthMutationRequestError(
      "A prova de capacidade exact-v1 está ausente, expirada ou pertence a outra operação",
      0,
      "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
    );
  }
  return state.requestedProtocol;
}

export const authApi = {
  prepareSessionBindingMutation,

  async login(
    email: string,
    password: string,
    capabilityReceipt?: SessionBindingCapabilityReceipt,
    webLogin?: Auth.WebLoginInProgress,
  ): Promise<{
    ok: boolean;
    user?: AuthUser;
    token?: string;
    sessionInstance?: string;
    sessionBinding?: SessionBindingStatus;
    error?: string;
  }> {
    const requestedProtocol = await consumeSessionBindingCapabilityReceipt(
      "login",
      capabilityReceipt,
    );
    if (Platform.OS === "web") {
      if (!webLogin) {
        throw new Error("Capability do gate de login web indisponível");
      }
      Auth.consumeWebLoginInProgressForRequest(webLogin);
    }
    const res = await serializeSessionMutation(() =>
      apiFetchInternal<LoginResponse>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ email, password }),
        },
        undefined,
        "auth-transition",
        undefined,
        undefined,
        undefined,
        requestedProtocol,
      ),
    );
    if (res.ok && res.data?.user) {
      // O caller publica o Bearer somente se o epoch do login ainda for o
      // atual. Persistir aqui permitia que uma resposta de login tardia
      // ressuscitasse um token depois de logout/outra conta.
      return {
        ok: true,
        user: res.data.user,
        token: res.data.token,
        sessionInstance: res.data.sessionInstance,
        sessionBinding: res.data.sessionBinding,
      };
    }
    const errMsg =
      (res.data as any)?.error ?? res.error ?? "Credenciais inválidas";
    return { ok: false, error: errMsg };
  },

  async logout(
    pushToken?: string | null,
    expectedUserId?: number,
    expectedSessionInstance?: string,
  ): Promise<SessionRevocationProof> {
    const result = await serializeSessionMutation(() =>
      apiFetchInternal<LogoutResponse>(
        "/api/auth/logout",
        {
          method: "POST",
          body: JSON.stringify(pushToken ? { pushToken } : {}),
        },
        undefined,
        "auth-transition",
        expectedUserId,
        undefined,
        expectedSessionInstance,
      ),
    );
    const proof = sessionRevocationProof(result.data);
    // Em qualquer plataforma, apagar apenas a credencial local sem confirmar o
    // CAS de sessionVersion deixaria cópias do Bearer válidas no servidor. No
    // web, o fence HttpOnly é uma prova adicional: sem ele, uma resposta antiga
    // ainda poderia reinstalar o cookie depois do logout.
    if (
      !result.ok ||
      proof === null ||
      (Platform.OS === "web" && result.data?.sessionFenceRotated !== true)
    ) {
      const code = authMutationErrorCode(result.data?.code);
      throw new AuthMutationRequestError(
        code
          ? (result.data?.error ??
              "A identidade da sessão divergiu da identidade esperada")
          : "O servidor não confirmou a revogação da sessão",
        result.status,
        code,
      );
    }
    return proof;
  },

  /**
   * Revoga um Bearer nativo ainda em quarentena. `getSessionToken()` não pode
   * expô-lo antes do commit local, portanto o rollback usa a credencial exata
   * recebida do servidor. Somente um 2xx com body tipado ROTATED ou
   * ALREADY_INVALID confirma o efeito/idempotência. Qualquer 401, rede ou 5xx
   * permanece ambíguo e exige repetir o próprio logout.
   */
  async revokeSessionToken(
    token: string,
    pushToken?: string | null,
  ): Promise<SessionRevocationProof> {
    if (!token.trim()) throw new Error("Token de sessão vazio");
    const result = await serializeSessionMutation(() =>
      apiFetchInternal<LogoutResponse>(
        "/api/auth/logout",
        {
          method: "POST",
          body: JSON.stringify(pushToken ? { pushToken } : {}),
        },
        token,
        "auth-transition",
      ),
    );
    const proof = sessionRevocationProof(result.data);
    if (!result.ok || proof === null) {
      throw new Error(
        "O servidor não confirmou a revogação do token em quarentena",
      );
    }
    return proof;
  },

  async me(): Promise<AuthUser | null> {
    const res = await apiFetchInternal<MeResponse>(
      "/api/auth/me",
      undefined,
      undefined,
      "auth-transition",
    );
    return res.ok ? (res.data?.user ?? null) : null;
  },

  /**
   * Variante do me() que distingue "sessão inválida" (401/403 — deslogar
   * de verdade) de "falha de rede/servidor" (timeout, 5xx, cold start do
   * Render — manter a sessão em cache). Tratar os dois igual expulsava
   * o usuário logado toda vez que o staging hibernado demorava a acordar.
   */
  async meDetailed(
    expectedSessionUserId?: number,
  ): Promise<DetailedSessionResponse> {
    return Auth.validateCanonicalSession(expectedSessionUserId);
  },

  /**
   * Revalida exclusivamente o Bearer PENDING de um logout nativo cuja resposta
   * foi ambígua. O override privado só alcança `/me`; nenhum outro endpoint
   * aceita autoridade escolhida pelo caller.
   */
  async revalidateSessionToken(
    token: string,
    expectedSessionUserId: number,
  ): Promise<DetailedSessionResponse> {
    if (Platform.OS === "web" || !token.trim()) {
      throw new Error("Bearer de recovery inválido");
    }
    return Auth.validateCanonicalSession(expectedSessionUserId, token);
  },

  /** Instituições disponíveis para a tela pública de cadastro. */
  async listSignupInstitutions(): Promise<{ id: number; name: string }[]> {
    const res = await apiFetchInternal<{
      institutions: { id: number; name: string }[];
    }>("/api/auth/signup-institutions", undefined, undefined, "public");
    return res.ok ? (res.data?.institutions ?? []) : [];
  },

  /** Auto-cadastro público — conta nasce pendente de aprovação do gestor. */
  async signup(input: {
    name: string;
    email: string;
    password: string;
    institutionId: number;
    medicalSpecialtyCode: MedicalSpecialtyCode | null;
    operationalProfileCode: OperationalProfileCode | null;
  }): Promise<{ ok: boolean; error?: string }> {
    const res = await apiFetchInternal<{ ok?: boolean; error?: string }>(
      "/api/auth/signup",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      undefined,
      "public",
    );
    if (res.ok && res.data?.ok) return { ok: true };
    return {
      ok: false,
      error: (res.data as any)?.error ?? res.error ?? "Erro ao criar cadastro",
    };
  },

  /**
   * Change own password. Requires current password (anti-CSRF /
   * anti-stolen-token mitigation) + new password.
   */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    credential: Auth.SessionTransitionCredential,
    capabilityReceipt?: SessionBindingCapabilityReceipt,
  ): Promise<{
    ok: boolean;
    token?: string;
    error?: string;
    status?: number;
    code?: AuthMutationErrorCode;
  }> {
    if (!credential) {
      return {
        ok: false,
        error: "Credencial de transição da sessão indisponível",
      };
    }
    const requestedProtocol = await consumeSessionBindingCapabilityReceipt(
      "rotate-session",
      capabilityReceipt,
    );
    const res = await serializeSessionMutation(() =>
      apiFetchInternal<{
        ok?: boolean;
        token?: string;
        error?: string;
        code?: string;
      }>(
        "/api/auth/change-password",
        {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword }),
          headers: { "Content-Type": "application/json" },
        },
        undefined,
        "auth-transition",
        undefined,
        credential,
        undefined,
        requestedProtocol,
      ),
    );
    if (res.ok && res.data?.ok) {
      // Assim como no login, o caller só aplica o Bearer depois do CAS do
      // epoch. A resposta HTTP não tem autoridade para gravar sozinha.
      return { ok: true, token: res.data.token };
    }
    const errMsg =
      (res.data as any)?.error ?? res.error ?? "Erro ao alterar senha";
    return {
      ok: false,
      error: errMsg,
      status: res.status,
      code: authMutationErrorCode(res.data?.code),
    };
  },

  /**
   * "Esqueci minha senha". O servidor responde 200 neutro sempre (sem
   * enumeração de contas) — a tela mostra mensagem neutra em qualquer caso.
   */
  async forgotPassword(
    email: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await apiFetchInternal<{ ok?: boolean; error?: string }>(
      "/api/auth/forgot-password",
      {
        method: "POST",
        body: JSON.stringify({ email }),
      },
      undefined,
      "public",
    );
    if (res.ok) return { ok: true };
    return {
      ok: false,
      error:
        (res.data as any)?.error ??
        res.error ??
        "Não foi possível enviar o pedido",
    };
  },

  /** Redefine a senha com o token recebido por e-mail. */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await apiFetchInternal<{ ok?: boolean; error?: string }>(
      "/api/auth/reset-password",
      {
        method: "POST",
        body: JSON.stringify({ token, newPassword }),
      },
      undefined,
      "public",
    );
    if (res.ok && res.data?.ok) return { ok: true };
    return {
      ok: false,
      error: (res.data as any)?.error ?? res.error ?? "Erro ao redefinir senha",
    };
  },

  /**
   * Exclusão da própria conta (Apple 5.1.1(v)). Exige a senha atual.
   * 409 = plantões futuros alocados (mensagem do servidor explica).
   */
  async deleteAccount(
    password: string,
    credential: Auth.SessionTransitionCredential,
    capabilityReceipt?: SessionBindingCapabilityReceipt,
    reversibleWebRevocation?: Auth.ReversibleWebSessionRevocation,
  ): Promise<{
    ok: boolean;
    status: number;
    error?: string;
    code?: AuthMutationErrorCode;
  }> {
    if (!credential) {
      return {
        ok: false,
        status: 0,
        error: "Credencial de transição da sessão indisponível",
      };
    }
    // O receipt exact-v1 e a capability reversível são one-shot. Consumir
    // qualquer um fora da mesma fila do DELETE permitiria que login/logout
    // atravessasse entre a perda local da prova e o efeito HTTP irreversível.
    return serializeSessionMutation(async () => {
      await consumeSessionBindingCapabilityReceipt(
        "delete-account",
        capabilityReceipt,
      );
      if (Platform.OS === "web") {
        if (!reversibleWebRevocation) {
          return {
            ok: false,
            status: 0,
            error: "Capability reversível do DELETE web indisponível",
          };
        }
        Auth.consumeReversibleWebSessionRevocationForRequest(
          reversibleWebRevocation,
        );
      }
      const res = await apiFetchInternal<{
        ok?: boolean;
        error?: string;
        code?: string;
        sessionFenceRotated?: boolean;
      }>(
        "/api/auth/me",
        {
          method: "DELETE",
          body: JSON.stringify({ password }),
        },
        undefined,
        "auth-transition",
        undefined,
        credential,
      );
      if (
        res.ok &&
        res.data?.ok &&
        (Platform.OS !== "web" || res.data.sessionFenceRotated === true)
      ) {
        return { ok: true, status: res.status };
      }
      return {
        ok: false,
        status: res.status,
        code: authMutationErrorCode(res.data?.code),
        error:
          (res.data as any)?.error ??
          res.error ??
          (Platform.OS === "web" && res.ok
            ? "O servidor não confirmou o encerramento da sessão"
            : "Erro ao excluir conta"),
      };
    });
  },
};
