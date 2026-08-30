/**
 * Cliente de integração com Hospital Alert via proxy autenticado do Escala+.
 * Nenhuma API key ou URL upstream trafega no bundle do app.
 */

import { apiFetch } from "./_core/api";
import { HOSPITAL_ALERT_CONFIG } from "./hospitalAlertConfig";

export interface HospitalAlertResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  httpStatus?: number;
}

export interface SyncUserPayload {
  externalUserId: string;
  organizationId: string;
  name: string;
  email: string;
  role?: string;
}

export interface StartShiftPayload {
  externalUserId: string;
  organizationId: string;
  serviceId: number;
  sectorId?: number | null;
  coverageType: "GLOBAL" | "SECTOR_SPECIFIC";
  staffingStatus?: string;
  sourceApp: string;
}

export interface EndShiftPayload {
  externalUserId: string;
  organizationId: string;
  sourceApp: string;
}

export interface IntegrationStatus {
  ok: boolean;
  organizationId: string;
  user: {
    exists: boolean;
    userId?: number;
    externalUserId: string;
    name?: string;
    email?: string;
    role?: string;
  };
  connection: {
    connected: boolean;
    lastSyncAt: string | null;
    lastSyncStatus: "success" | "error" | "never";
    lastSyncSourceApp?: string;
    lastError: string | null;
  };
  shift: {
    active: boolean;
    shiftId?: number;
    startedAt?: string;
    endedAt?: string | null;
    service?: { id: number; name: string };
    sector?: { id: number; name: string };
    coverageType?: string;
    staffingStatus?: string;
    sourceApp?: string;
  };
  serverTime: string;
  version: string;
}

async function proxyRequest<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<HospitalAlertResponse<T>> {
  const method = options.method ?? "POST";
  const result = await apiFetch<{ ok?: boolean; data?: T; error?: string }>(
    `/api/integrations/hospital-alert${path}`,
    {
      method,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      headers: { "Content-Type": "application/json" },
    },
  );

  if (!result.ok || !result.data) {
    return {
      ok: false,
      error: result.error ?? result.data?.error ?? "Falha na integração",
      httpStatus: result.status,
    };
  }

  if (result.data.ok === false) {
    return {
      ok: false,
      error: result.data.error ?? "Falha na integração",
      httpStatus: result.status,
    };
  }

  return {
    ok: true,
    data: result.data.data as T,
    httpStatus: result.status,
  };
}

function shouldRetry(status?: number): boolean {
  if (status === undefined) return true;
  if (status >= 500) return true;
  if (status === 429 || status === 408) return true;
  return false;
}

async function executeWithRetry<T>(
  fn: () => Promise<HospitalAlertResponse<T>>,
  attempts: number = HOSPITAL_ALERT_CONFIG.RETRY.ATTEMPTS,
): Promise<HospitalAlertResponse<T>> {
  let last: HospitalAlertResponse<T> = { ok: false, error: "Erro desconhecido" };

  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last.ok || !shouldRetry(last.httpStatus)) {
      return last;
    }
    if (i < attempts - 1) {
      const backoffMs =
        HOSPITAL_ALERT_CONFIG.RETRY.BACKOFF_MS[i] ??
        HOSPITAL_ALERT_CONFIG.RETRY.BACKOFF_MS.at(-1) ??
        10_000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  return last;
}

export async function syncUser(
  payload: SyncUserPayload,
): Promise<HospitalAlertResponse> {
  return executeWithRetry(() =>
    proxyRequest("/sync-user", { method: "POST", body: payload }),
  );
}

export async function startShift(
  payload: StartShiftPayload,
): Promise<HospitalAlertResponse> {
  return executeWithRetry(() =>
    proxyRequest("/shifts/start", { method: "POST", body: payload }),
  );
}

export async function endShift(
  payload: EndShiftPayload,
): Promise<HospitalAlertResponse> {
  return executeWithRetry(() =>
    proxyRequest("/shifts/end", { method: "POST", body: payload }),
  );
}

export async function getIntegrationStatus(
  externalUserId: string,
  organizationId: string = HOSPITAL_ALERT_CONFIG.ORGANIZATION_ID,
): Promise<HospitalAlertResponse<IntegrationStatus>> {
  const query = new URLSearchParams({
    externalUserId,
    organizationId,
  });
  return executeWithRetry(() =>
    proxyRequest<IntegrationStatus>(`/status?${query.toString()}`, {
      method: "GET",
    }),
  );
}
