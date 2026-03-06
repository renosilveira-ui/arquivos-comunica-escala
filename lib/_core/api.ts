// lib/_core/api.ts — Wrapper HTTP para chamadas à API do server
import { Platform } from "react-native";
import * as Auth from "./auth";

function getBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) return envUrl;
  if (Platform.OS === "android") return "http://10.0.2.2:3000";
  return "http://localhost:3000";
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T | null> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };

  // Em native, anexar token de sessão
  if (Platform.OS !== "web") {
    const token = await Auth.getSessionToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: Platform.OS === "web" ? "include" : undefined,
  });

  if (!res.ok) return null;
  return res.json();
}

/** Busca o usuário autenticado no server */
export async function getMe(): Promise<Auth.User | null> {
  return apiFetch<Auth.User>("/api/trpc/auth.me");
}

/** Faz logout no server */
export async function logout(): Promise<void> {
  await apiFetch("/api/trpc/auth.logout", { method: "POST" });
}
