/**
 * Logs de auditoria local para integração HospitalAlert
 * Mantém últimos 20 logs para debug (sem dados sensíveis)
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

// ============================================================================
// TYPES
// ============================================================================

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  operation: "syncUser" | "startShift" | "endShift" | "getStatus" | "processQueue";
  success: boolean;
  httpStatus?: number;
  errorSummary?: string;
}

// ============================================================================
// STORAGE
// ============================================================================

const AUDIT_LOG_STORAGE_KEY = "@hospital_shifts:auditLog";
const MAX_LOG_ENTRIES = 20;

/**
 * Carrega logs de auditoria
 */
export async function loadAuditLog(): Promise<AuditLogEntry[]> {
  try {
    const json = await AsyncStorage.getItem(AUDIT_LOG_STORAGE_KEY);
    if (!json) return [];
    
    const logs = JSON.parse(json) as AuditLogEntry[];
    return logs;
  } catch (error) {
    console.error("[AuditLog] Erro ao carregar logs:", error);
    return [];
  }
}

/**
 * Salva logs de auditoria
 */
async function saveAuditLog(logs: AuditLogEntry[]): Promise<void> {
  try {
    // Manter apenas últimos 20 logs
    const recentLogs = logs
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, MAX_LOG_ENTRIES);
    
    await AsyncStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(recentLogs));
  } catch (error) {
    console.error("[AuditLog] Erro ao salvar logs:", error);
  }
}

/**
 * Adiciona entrada ao log de auditoria
 */
export async function logAudit(
  operation: AuditLogEntry["operation"],
  success: boolean,
  httpStatus?: number,
  errorSummary?: string
): Promise<void> {
  const logs = await loadAuditLog();
  
  const entry: AuditLogEntry = {
    id: `${operation}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    operation,
    success,
    httpStatus,
    errorSummary,
  };
  
  logs.push(entry);
  await saveAuditLog(logs);
  
  console.log("[AuditLog] Registrado:", operation, success ? "✓" : "✗", errorSummary || "");
}

/**
 * Limpa logs de auditoria
 */
export async function clearAuditLog(): Promise<void> {
  await AsyncStorage.removeItem(AUDIT_LOG_STORAGE_KEY);
  console.log("[AuditLog] Logs limpos");
}

/**
 * Busca último log de uma operação específica
 */
export async function getLastLog(operation: AuditLogEntry["operation"]): Promise<AuditLogEntry | null> {
  const logs = await loadAuditLog();
  const filtered = logs.filter(log => log.operation === operation);
  
  if (filtered.length === 0) return null;
  
  return filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
}
