// lib/sso-launch.ts — Abre o Comunica+ a partir do Escala (mobile)
//
// Todo handoff mobile passa pelo launch-code tenant-bound:
//
// POST /api/sso/launch-code (autenticado, Bearer) → recebe launchUrl
// one-time → Linking.openURL abre o browser externo → o servidor
// completa o handoff (form auto-submit) → browser cai logado no
// Comunica+. O token JWT nunca passa pelo app nem por URL.
//
// Usado por:
//   - NotificationListener (toque no push type=sso_ready)
//   - useSsoHandoff (botão manual "Abrir Comunica+", branch mobile)

import { Linking } from "react-native";
import * as Auth from "@/lib/_core/auth";
import { getApiBaseUrl } from "@/lib/_core/api";

export interface SsoLaunchResult {
  ok: boolean;
  error?: string;
}

export interface SsoLaunchOptions {
  signal?: AbortSignal;
  canNavigate?: () => boolean;
}

const SSO_INVALID_TENANT_MESSAGE =
  "Selecione uma instituicao valida antes de abrir o Comunica+";
const SSO_PREPARATION_FAILED_MESSAGE =
  "Não foi possível preparar o login no Comunica+. Tente novamente.";
const SSO_OPEN_FAILED_MESSAGE =
  "Não foi possível abrir o Comunica+. Tente novamente.";
const SSO_CANCELLED_MESSAGE = "A abertura do Comunica+ foi cancelada.";

function isCancelled(options: SsoLaunchOptions): boolean {
  return options.signal?.aborted === true || options.canNavigate?.() === false;
}

export function isValidSsoTenantId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * Pushes SSO carregam o tenant que originou a intencao. A URL recebida no
 * payload nunca e autoridade de navegacao: o destino nasce exclusivamente do
 * launch-code emitido pelo servidor.
 */
export async function openComunicaFromNotification(
  data: Readonly<Record<string, unknown>>,
  options: SsoLaunchOptions = {},
): Promise<SsoLaunchResult> {
  if (!isValidSsoTenantId(data.institutionId)) {
    return { ok: false, error: "Instituicao do push SSO ausente ou invalida" };
  }
  return openComunica(data.institutionId, options);
}

/**
 * Solicita um launch-code e abre o browser no fluxo de handoff.
 * Mobile-only — no web o handoff é form-POST direto (useSsoHandoff).
 */
export async function openComunicaViaLaunchCode(
  tenantId: number,
  options: SsoLaunchOptions = {},
): Promise<SsoLaunchResult> {
  if (!isValidSsoTenantId(tenantId)) {
    return { ok: false, error: SSO_INVALID_TENANT_MESSAGE };
  }
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-tenant-id": String(tenantId),
    };

    const token = await Auth.getSessionToken();
    if (isCancelled(options)) return { ok: false, error: SSO_CANCELLED_MESSAGE };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${getApiBaseUrl()}/api/sso/launch-code`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal: options.signal,
    });

    if (isCancelled(options)) return { ok: false, error: SSO_CANCELLED_MESSAGE };
    if (!res.ok) {
      await res.json().catch(() => null);
      return { ok: false, error: SSO_PREPARATION_FAILED_MESSAGE };
    }

    const data = (await res.json()) as { launchUrl?: string };
    if (isCancelled(options)) return { ok: false, error: SSO_CANCELLED_MESSAGE };
    if (typeof data.launchUrl !== "string" || !data.launchUrl) {
      return { ok: false, error: SSO_PREPARATION_FAILED_MESSAGE };
    }

    // Último fence antes do único efeito irreversível do fluxo mobile.
    if (isCancelled(options)) return { ok: false, error: SSO_CANCELLED_MESSAGE };
    await Linking.openURL(data.launchUrl);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: isCancelled(options) ? SSO_CANCELLED_MESSAGE : SSO_OPEN_FAILED_MESSAGE,
    };
  }
}

/**
 * Abre somente a URL one-time emitida pelo servidor para o tenant autenticado.
 * Um scheme nativo nu não carrega handoff nem prova o tenant e, por isso, não
 * pode representar sucesso de SSO.
 */
export async function openComunica(
  tenantId: number,
  options: SsoLaunchOptions = {},
): Promise<SsoLaunchResult> {
  if (!isValidSsoTenantId(tenantId)) {
    return { ok: false, error: SSO_INVALID_TENANT_MESSAGE };
  }
  return openComunicaViaLaunchCode(tenantId, options);
}
