// lib/sso-launch.ts — Abre o Comunica+ a partir do Escala (mobile)
//
// Fase 3 da integração: preferir o APP NATIVO do Comunica+
// (comunicamais://), que mantém sessão própria persistente — o médico
// cai direto no app, não no navegador. Se o app não estiver instalado,
// fallback para o fluxo browser logado via launch-code:
//
// POST /api/sso/launch-code (autenticado, Bearer) → recebe launchUrl
// one-time → Linking.openURL abre o browser externo → o servidor
// completa o handoff (form auto-submit) → browser cai logado no
// Comunica+. O token JWT nunca passa pelo app nem por URL.
//
// Usado por:
//   - NotificationListener (toque no push type=sso_ready)
//   - useSsoHandoff (botão manual "Abrir Comunica+", branch mobile)

import { Platform, Linking } from "react-native";
import * as Auth from "@/lib/_core/auth";
import { getApiBaseUrl } from "@/lib/_core/api";

/** Scheme registrado pelo app nativo do Comunica+ (native/app.json). */
const COMUNICA_APP_URL = "comunicamais://";


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

    const res = await fetch(`${getApiBaseUrl()}/api/sso/launch-code`, {
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

/**
 * Abre o Comunica+ — app nativo se instalado, senão browser logado.
 *
 * O app nativo guarda a própria sessão (SecureStore), então abri-lo já
 * resolve o caso comum. Se o médico estiver deslogado lá, ele cai na
 * tela de login do próprio app — comportamento aceitável e explícito.
 * `openURL` para scheme sem handler rejeita a promise (iOS e Android),
 * e aí caímos no fluxo browser via launch-code.
 */
export async function openComunica(tenantId?: number): Promise<SsoLaunchResult> {
  if (Platform.OS !== "web") {
    try {
      await Linking.openURL(COMUNICA_APP_URL);
      return { ok: true };
    } catch {
      // App não instalado — segue para o browser logado.
    }
  }
  return openComunicaViaLaunchCode(tenantId);
}
