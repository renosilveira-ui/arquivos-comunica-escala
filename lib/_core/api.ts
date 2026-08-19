// lib/_core/api.ts — Wrapper HTTP para chamadas à API do server
import { Platform } from "react-native";
import * as Auth from "./auth";

function getBaseUrl(): string {
  const envUrl = (process.env.EXPO_PUBLIC_API_URL ?? "").trim();

  // Same-origin mode: when EXPO_PUBLIC_API_URL is empty or "/", the web
  // frontend is served by the same Express server that hosts the API, so
  // relative paths work and cookies are first-party (no cross-origin issues).
  if (Platform.OS === "web" && (!envUrl || envUrl === "/")) {
    return "";
  }

  if (envUrl) return envUrl.replace(/\/$/, "");

  // Fallback permitido apenas em desenvolvimento local.
  if (process.env.NODE_ENV === "production") {
    throw new Error("EXPO_PUBLIC_API_URL não configurado em produção");
  }

  const fallbackPort = (process.env.EXPO_PUBLIC_API_PORT || "3000").trim();
  if (Platform.OS === "android") return `http://10.0.2.2:${fallbackPort}`;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${fallbackPort}`;
  }
  return `http://localhost:${fallbackPort}`;
}

async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };

  if (Platform.OS !== "web") {
    const token = await Auth.getSessionToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      credentials: Platform.OS === "web" ? "include" : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha de conexão com o servidor.";
    return { ok: false, status: 0, data: null, error: message };
  }

  let data: T | null = null;
  try {
    data = await res.json();
  } catch {
    // ignore empty body
  }

  return { ok: res.ok, status: res.status, data };
}

export type AuthUser = {
  id: number;
  name: string | null;
  email: string | null;
  role: "admin" | "manager" | "doctor" | "nurse" | "tech";
  /** PENDING = auto-cadastro aguardando aprovação do gestor (app bloqueado). */
  approvalStatus?: "PENDING" | "APPROVED";
};

type LoginResponse = { user: AuthUser; token?: string };
type MeResponse = { user: AuthUser };

export const authApi = {
  async login(
    email: string,
    password: string,
  ): Promise<{ ok: boolean; user?: AuthUser; error?: string }> {
    const res = await apiFetch<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (res.ok && res.data?.user) {
      // Native: save token to SecureStore for Bearer auth on subsequent requests.
      // Web: cookie is set automatically by the browser.
      if (Platform.OS !== "web" && res.data.token) {
        await Auth.setSessionToken(res.data.token);
      }
      return { ok: true, user: res.data.user };
    }
    const errMsg =
      (res.data as any)?.error ??
      res.error ??
      "Credenciais inválidas";
    return { ok: false, error: errMsg };
  },

  async logout(): Promise<void> {
    await apiFetch("/api/auth/logout", { method: "POST" });
  },

  async me(): Promise<AuthUser | null> {
    const res = await apiFetch<MeResponse>("/api/auth/me");
    return res.ok ? (res.data?.user ?? null) : null;
  },

  /**
   * Variante do me() que distingue "sessão inválida" (401/403 — deslogar
   * de verdade) de "falha de rede/servidor" (timeout, 5xx, cold start do
   * Render — manter a sessão em cache). Tratar os dois igual expulsava
   * o usuário logado toda vez que o staging hibernado demorava a acordar.
   */
  async meDetailed(): Promise<{
    user: AuthUser | null;
    sessionInvalid: boolean;
    networkOrServerError: boolean;
  }> {
    const res = await apiFetch<MeResponse>("/api/auth/me");
    if (res.ok) {
      return { user: res.data?.user ?? null, sessionInvalid: false, networkOrServerError: false };
    }
    const sessionInvalid = res.status === 401 || res.status === 403;
    return {
      user: null,
      sessionInvalid,
      networkOrServerError: !sessionInvalid, // status 0 (fetch falhou) ou 5xx
    };
  },

  /** Instituições disponíveis para a tela pública de cadastro. */
  async listSignupInstitutions(): Promise<{ id: number; name: string }[]> {
    const res = await apiFetch<{ institutions: { id: number; name: string }[] }>(
      "/api/auth/signup-institutions",
    );
    return res.ok ? (res.data?.institutions ?? []) : [];
  },

  /** Auto-cadastro público — conta nasce pendente de aprovação do gestor. */
  async signup(input: {
    name: string;
    email: string;
    password: string;
    institutionId: number;
    specialty?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const res = await apiFetch<{ ok?: boolean; error?: string }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
    });
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
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await apiFetch<{ ok?: boolean; error?: string }>(
      "/api/auth/change-password",
      {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
        headers: { "Content-Type": "application/json" },
      },
    );
    if (res.ok && res.data?.ok) return { ok: true };
    const errMsg =
      (res.data as any)?.error ?? res.error ?? "Erro ao alterar senha";
    return { ok: false, error: errMsg };
  },
};
