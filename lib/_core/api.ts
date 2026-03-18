// lib/_core/api.ts — Wrapper HTTP para chamadas à API do server
import { Platform } from "react-native";
import * as Auth from "./auth";

function getBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) return envUrl;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.location.origin;
  }
  if (Platform.OS === "android") return "http://10.0.2.2:3000";
  return "http://localhost:3000";
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
};

type LoginResponse = { user: AuthUser };
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
      // Na native, o server retorna o token no header ou cookie — para native
      // usamos Bearer via SecureStore; o cookie session é suficiente para web.
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
};
