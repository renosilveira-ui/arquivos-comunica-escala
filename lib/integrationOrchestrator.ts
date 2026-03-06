/**
 * Orquestrador de integração com HospitalAlert
 * Gerencia fluxo de syncUser, startShift, endShift com debounce e fila offline
 */

import * as HospitalAlertClient from "./hospitalAlertClient";
import * as Queue from "./integrationQueue";
import { HOSPITAL_ALERT_CONFIG } from "./hospitalAlertConfig";
import { logAudit } from "./auditLog";
import * as SyncErrorNotifier from "./syncErrorNotifier";

// ============================================================================
// TYPES
// ============================================================================

export interface UserData {
  id: number;
  openId: string;
  name: string;
  email: string;
  role?: string;
}

export interface ShiftData {
  id: number;
  serviceId: number;
  sectorId?: number | null;
  coverageType: "GLOBAL" | "SECTOR_SPECIFIC";
  staffingStatus?: string;
  startTime: Date;
  endTime: Date;
}

// ============================================================================
// SYNC USER
// ============================================================================

/**
 * Sincroniza usuário com HospitalAlert
 * Chamado no login ou quando dados do usuário mudarem
 */
export async function syncUser(user: UserData): Promise<{ success: boolean; error?: string }> {
  const externalUserId = `shiftsapp:${user.id}`;
  
  // Verificar debounce
  const debounced = await Queue.isDebounced("syncUser", externalUserId);
  if (debounced) {
    console.log("[IntegrationOrchestrator] syncUser em debounce:", externalUserId);
    return { success: false, error: "Debounce ativo" };
  }
  
  // Registrar debounce
  await Queue.recordDebounce("syncUser", externalUserId);
  
  // Preparar payload
  const payload: HospitalAlertClient.SyncUserPayload = {
    externalUserId,
    organizationId: HOSPITAL_ALERT_CONFIG.ORGANIZATION_ID,
    name: user.name,
    email: user.email,
    role: user.role,
  };
  
  // Enfileirar operação
  const queueId = await Queue.enqueue("syncUser", payload);
  
  // Tentar executar imediatamente
  const result = await HospitalAlertClient.syncUser(payload);
  
  if (result.ok) {
    await Queue.markSuccess(queueId);
    await logAudit("syncUser", true, result.httpStatus);
    await SyncErrorNotifier.recordSuccess();
    console.log("[IntegrationOrchestrator] syncUser sucesso:", externalUserId);
    return { success: true };
  } else {
    // Verificar se é erro fatal (401, 403, 400, 404)
    const isFatalError = result.httpStatus && [400, 401, 403, 404].includes(result.httpStatus);
    
    if (isFatalError) {
      await Queue.markFatalError(queueId, result.error || "Erro fatal");
      await logAudit("syncUser", false, result.httpStatus, result.error);
      console.error("[IntegrationOrchestrator] syncUser erro fatal:", result.error);
      return { success: false, error: result.error };
    } else {
      // Erro transitório: marcar para retry
      await Queue.markError(queueId, result.error || "Erro desconhecido", 0);
      await logAudit("syncUser", false, result.httpStatus, result.error);
      
      // Registrar falha para notificação (se houver escala ativa)
      // TODO: Passar hasActiveShift do contexto
      await SyncErrorNotifier.recordFailure(result.error || "Erro desconhecido", false);
      
      console.warn("[IntegrationOrchestrator] syncUser erro transitório:", result.error);
      return { success: false, error: result.error };
    }
  }
}

// ============================================================================
// START SHIFT
// ============================================================================

/**
 * Inicia plantão no HospitalAlert
 * Chamado automaticamente ao detectar escala ativa
 */
export async function startShift(
  user: UserData,
  shift: ShiftData
): Promise<{ success: boolean; error?: string }> {
  const externalUserId = `shiftsapp:${user.id}`;
  const debounceKey = `${externalUserId}_${shift.id}`;
  
  // Verificar debounce
  const debounced = await Queue.isDebounced("startShift", debounceKey);
  if (debounced) {
    console.log("[IntegrationOrchestrator] startShift em debounce:", debounceKey);
    return { success: false, error: "Debounce ativo" };
  }
  
  // Registrar debounce
  await Queue.recordDebounce("startShift", debounceKey);
  
  // Preparar payload
  const payload: HospitalAlertClient.StartShiftPayload = {
    externalUserId,
    organizationId: HOSPITAL_ALERT_CONFIG.ORGANIZATION_ID,
    serviceId: shift.serviceId,
    sectorId: shift.sectorId,
    coverageType: shift.coverageType,
    staffingStatus: shift.staffingStatus,
    sourceApp: HOSPITAL_ALERT_CONFIG.SOURCE_APP,
  };
  
  // Enfileirar operação
  const queueId = await Queue.enqueue("startShift", payload);
  
  // Tentar executar imediatamente
  const result = await HospitalAlertClient.startShift(payload);
  
  if (result.ok) {
    await Queue.markSuccess(queueId);
    await logAudit("startShift", true, result.httpStatus);
    await SyncErrorNotifier.recordSuccess();
    console.log("[IntegrationOrchestrator] startShift sucesso:", debounceKey);
    return { success: true };
  } else {
    // Verificar se é erro fatal
    const isFatalError = result.httpStatus && [400, 401, 403, 404].includes(result.httpStatus);
    
    if (isFatalError) {
      await Queue.markFatalError(queueId, result.error || "Erro fatal");
      await logAudit("startShift", false, result.httpStatus, result.error);
      console.error("[IntegrationOrchestrator] startShift erro fatal:", result.error);
      return { success: false, error: result.error };
    } else {
      // Erro transitório: marcar para retry
      await Queue.markError(queueId, result.error || "Erro desconhecido", 0);
      await logAudit("startShift", false, result.httpStatus, result.error);
      
      // Registrar falha para notificação (tem escala ativa)
      await SyncErrorNotifier.recordFailure(result.error || "Erro desconhecido", true);
      
      console.warn("[IntegrationOrchestrator] startShift erro transitório:", result.error);
      return { success: false, error: result.error };
    }
  }
}

// ============================================================================
// END SHIFT
// ============================================================================

/**
 * Finaliza plantão no HospitalAlert
 * Chamado automaticamente quando escala termina ou usuário encerra manualmente
 */
export async function endShift(
  user: UserData,
  shiftId: number
): Promise<{ success: boolean; error?: string }> {
  const externalUserId = `shiftsapp:${user.id}`;
  const debounceKey = `${externalUserId}_${shiftId}`;
  
  // Verificar debounce
  const debounced = await Queue.isDebounced("endShift", debounceKey);
  if (debounced) {
    console.log("[IntegrationOrchestrator] endShift em debounce:", debounceKey);
    return { success: false, error: "Debounce ativo" };
  }
  
  // Registrar debounce
  await Queue.recordDebounce("endShift", debounceKey);
  
  // Preparar payload
  const payload: HospitalAlertClient.EndShiftPayload = {
    externalUserId,
    organizationId: HOSPITAL_ALERT_CONFIG.ORGANIZATION_ID,
    sourceApp: HOSPITAL_ALERT_CONFIG.SOURCE_APP,
  };
  
  // Enfileirar operação
  const queueId = await Queue.enqueue("endShift", payload);
  
  // Tentar executar imediatamente
  const result = await HospitalAlertClient.endShift(payload);
  
  if (result.ok) {
    await Queue.markSuccess(queueId);
    await logAudit("endShift", true, result.httpStatus);
    await SyncErrorNotifier.recordSuccess();
    console.log("[IntegrationOrchestrator] endShift sucesso:", debounceKey);
    return { success: true };
  } else {
    // Verificar se é erro fatal
    const isFatalError = result.httpStatus && [400, 401, 403, 404].includes(result.httpStatus);
    
    if (isFatalError) {
      await Queue.markFatalError(queueId, result.error || "Erro fatal");
      await logAudit("endShift", false, result.httpStatus, result.error);
      console.error("[IntegrationOrchestrator] endShift erro fatal:", result.error);
      return { success: false, error: result.error };
    } else {
      // Erro transitório: marcar para retry
      await Queue.markError(queueId, result.error || "Erro desconhecido", 0);
      await logAudit("endShift", false, result.httpStatus, result.error);
      
      // Registrar falha para notificação (sem escala ativa, pois está encerrando)
      await SyncErrorNotifier.recordFailure(result.error || "Erro desconhecido", false);
      
      console.warn("[IntegrationOrchestrator] endShift erro transitório:", result.error);
      return { success: false, error: result.error };
    }
  }
}

// ============================================================================
// GET INTEGRATION STATUS
// ============================================================================

/**
 * Busca status da integração com HospitalAlert
 */
export async function getIntegrationStatus(
  userId: number
): Promise<HospitalAlertClient.HospitalAlertResponse<HospitalAlertClient.IntegrationStatus>> {
  const externalUserId = `shiftsapp:${userId}`;
  return await HospitalAlertClient.getIntegrationStatus(externalUserId);
}
