// lib/sso-launch.ts — Abre o Comunica+ logado via launch-code (mobile)
//
// Fluxo: POST /api/sso/launch-code (autenticado, Bearer) → recebe
// launchUrl one-time → Linking.openURL abre o browser externo → o
// servidor completa o handoff (form auto-submit) → browser cai logado
// no Comunica+. O token JWT nunca passa pelo app nem por URL.
//
// Usado por:
//   - NotificationListener (toque no push type=sso_ready)
//   - useSsoHandoff (botão manual "Abrir Comunica+", branch mobile)

import { Platform, Linking } from "react-native";
import * as Auth from "@/lib/_core/auth";

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

export interface SsoLaunchResult {
  ok: boolean;
  error?: string;
}

/**
 * Solicita um launch-code e abre o browser no fluxo de handoff.
 * Mobile-only — no web o handoff é form-POST direto (useSsoHandoff).
 */
export async function openComunicaViaLaunchCode(
  tenantId?: number,
): Promise<SsoLaunchResult> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (tenantId) headers["x-tenant-id"] = String(tenantId);

    const token = await Auth.getSessionToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${getBaseUrl()}/api/sso/launch-code`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error ?? `Erro ${res.status} ao preparar login` };
    }

    const data = (await res.json()) as { launchUrl?: string };
    if (!data.launchUrl) {
      return { ok: false, error: "Resposta inválida do servidor" };
    }

    await Linking.openURL(data.launchUrl);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Falha ao abrir Comunica+" };
  }
}
