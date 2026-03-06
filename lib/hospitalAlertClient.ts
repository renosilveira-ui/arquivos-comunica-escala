/**
 * Cliente de integração com HospitalAlert
 * Gerencia chamadas à API do HospitalAlert com retry, backoff e fila offline
 */

import axios, { AxiosError } from "axios";
import { HOSPITAL_ALERT_CONFIG } from "./hospitalAlertConfig";

// ============================================================================
// TYPES
// ============================================================================

export interface HospitalAlertResponse<T = any> {
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

// ============================================================================
// HTTP CLIENT
// ============================================================================

/**
 * Cria headers padrão para requisições ao HospitalAlert
 */
function getHeaders(): Record<string, string> {
  return {
    "Authorization": `Bearer ${HOSPITAL_ALERT_CONFIG.API_KEY}`,
    "X-Organization-Id": HOSPITAL_ALERT_CONFIG.ORGANIZATION_ID,
    "Content-Type": "application/json",
  };
}

/**
 * Determina se um erro HTTP deve ser retried
 */
function shouldRetry(error: AxiosError): boolean {
  if (!error.response) {
    // Network error, timeout, etc
    return true;
  }
  
  const status = error.response.status;
  
  // Retry em erros transitórios
  if (status >= 500) return true; // 5xx
  if (status === 429) return true; // Rate limit
  if (status === 408) return true; // Request timeout
  
  // Não retry em erros de cliente
  if (status === 400) return false; // Bad request
  if (status === 401) return false; // Unauthorized
  if (status === 403) return false; // Forbidden
  if (status === 404) return false; // Not found
  
  return false;
}

/**
 * Executa requisição HTTP com retry e backoff
 */
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  attempts: number = HOSPITAL_ALERT_CONFIG.RETRY.ATTEMPTS
): Promise<HospitalAlertResponse<T>> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await fn();
      return {
        ok: true,
        data,
        httpStatus: 200,
      };
    } catch (error) {
      lastError = error as Error;
      
      // Se não deve retry, retorna erro imediatamente
      if (error instanceof AxiosError && !shouldRetry(error)) {
        return {
          ok: false,
          error: error.response?.data?.message || error.message,
          httpStatus: error.response?.status,
        };
      }
      
      // Se não é a última tentativa, aguarda backoff
      if (i < attempts - 1) {
        const backoffMs = HOSPITAL_ALERT_CONFIG.RETRY.BACKOFF_MS[i] || 10000;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  
  // Todas as tentativas falharam
  return {
    ok: false,
    error: lastError?.message || "Erro desconhecido após múltiplas tentativas",
    httpStatus: lastError instanceof AxiosError ? lastError.response?.status : undefined,
  };
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Sincroniza dados do usuário com HospitalAlert
 */
export async function syncUser(payload: SyncUserPayload): Promise<HospitalAlertResponse> {
  console.log("[HospitalAlertClient] syncUser:", payload.externalUserId);
  
  return executeWithRetry(async () => {
    const response = await axios.post(
      `${HOSPITAL_ALERT_CONFIG.BASE_URL}/api/trpc/auth.syncUser`,
      payload,
      { 
        headers: getHeaders(),
        timeout: HOSPITAL_ALERT_CONFIG.TIMEOUT_MS,
      }
    );
    return response.data;
  });
}

/**
 * Inicia plantão no HospitalAlert
 */
export async function startShift(payload: StartShiftPayload): Promise<HospitalAlertResponse> {
  console.log("[HospitalAlertClient] startShift:", payload.externalUserId);
  
  return executeWithRetry(async () => {
    const response = await axios.post(
      `${HOSPITAL_ALERT_CONFIG.BASE_URL}/api/trpc/shifts.start`,
      payload,
      { 
        headers: getHeaders(),
        timeout: HOSPITAL_ALERT_CONFIG.TIMEOUT_MS,
      }
    );
    return response.data;
  });
}

/**
 * Finaliza plantão no HospitalAlert
 */
export async function endShift(payload: EndShiftPayload): Promise<HospitalAlertResponse> {
  console.log("[HospitalAlertClient] endShift:", payload.externalUserId);
  
  return executeWithRetry(async () => {
    const response = await axios.post(
      `${HOSPITAL_ALERT_CONFIG.BASE_URL}/api/trpc/shifts.end`,
      payload,
      { 
        headers: getHeaders(),
        timeout: HOSPITAL_ALERT_CONFIG.TIMEOUT_MS,
      }
    );
    return response.data;
  });
}

/**
 * Busca status da integração com HospitalAlert
 */
export async function getIntegrationStatus(
  externalUserId: string,
  organizationId: string = HOSPITAL_ALERT_CONFIG.ORGANIZATION_ID
): Promise<HospitalAlertResponse<IntegrationStatus>> {
  console.log("[HospitalAlertClient] getIntegrationStatus:", externalUserId);
  
  return executeWithRetry(async () => {
    const response = await axios.get(
      `${HOSPITAL_ALERT_CONFIG.BASE_URL}/api/trpc/integration.getStatus`,
      {
        params: { externalUserId, organizationId },
        headers: getHeaders(),
        timeout: HOSPITAL_ALERT_CONFIG.TIMEOUT_MS,
      }
    );
    return response.data;
  });
}
