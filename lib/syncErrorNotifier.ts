/**
 * Módulo de notificação de erros de sincronização
 * Exibe aviso discreto apenas após 3 falhas consecutivas, com cooldown
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

// ============================================================================
// CONSTANTS
// ============================================================================

const STORAGE_KEY = "@hospital_shifts:syncErrorState";
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hora
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

// ============================================================================
// TYPES
// ============================================================================

interface SyncErrorState {
  consecutiveFailures: number;
  lastNotificationAt: string | null;
  lastError: string | null;
}

// ============================================================================
// STORAGE
// ============================================================================

/**
 * Carrega estado de erros do AsyncStorage
 */
async function loadState(): Promise<SyncErrorState> {
  try {
    const json = await AsyncStorage.getItem(STORAGE_KEY);
    if (!json) {
      return {
        consecutiveFailures: 0,
        lastNotificationAt: null,
        lastError: null,
      };
    }
    return JSON.parse(json);
  } catch (error) {
    console.error("[SyncErrorNotifier] Erro ao carregar estado:", error);
    return {
      consecutiveFailures: 0,
      lastNotificationAt: null,
      lastError: null,
    };
  }
}

/**
 * Salva estado de erros no AsyncStorage
 */
async function saveState(state: SyncErrorState): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("[SyncErrorNotifier] Erro ao salvar estado:", error);
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Registra sucesso de sincronização (reseta contador)
 */
export async function recordSuccess(): Promise<void> {
  await saveState({
    consecutiveFailures: 0,
    lastNotificationAt: null,
    lastError: null,
  });
}

/**
 * Registra falha de sincronização
 * Se atingir threshold e cooldown expirou, registra a ocorrência. A integração
 * HospitalAlert é legada e não tem um destinatário de conta comprovado; por
 * isso ela não pode disparar nenhuma notificação local do sistema operacional.
 */
export async function recordFailure(
  error: string,
  hasActiveShift: boolean
): Promise<void> {
  // Não notificar se não há escala ativa
  if (!hasActiveShift) {
    console.log("[SyncErrorNotifier] Sem escala ativa, não notificar");
    return;
  }
  
  const state = await loadState();
  const newConsecutiveFailures = state.consecutiveFailures + 1;
  
  console.log(`[SyncErrorNotifier] Falha ${newConsecutiveFailures}/${CONSECUTIVE_FAILURES_THRESHOLD}`);
  
  // Atualizar estado
  const newState: SyncErrorState = {
    consecutiveFailures: newConsecutiveFailures,
    lastNotificationAt: state.lastNotificationAt,
    lastError: error,
  };
  
  // Verificar se deve notificar
  if (newConsecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
    const shouldNotify = await checkCooldown(state.lastNotificationAt);
    
    if (shouldNotify) {
      console.warn(
        "[SyncErrorNotifier] Aviso local legado suprimido por não possuir vínculo de conta",
      );
      newState.lastNotificationAt = new Date().toISOString();
      newState.consecutiveFailures = 0; // Reset após registrar no cooldown
    }
  }
  
  await saveState(newState);
}

/**
 * Verifica se cooldown expirou
 */
async function checkCooldown(lastNotificationAt: string | null): Promise<boolean> {
  if (!lastNotificationAt) return true;
  
  const lastNotification = new Date(lastNotificationAt);
  const elapsed = Date.now() - lastNotification.getTime();
  
  return elapsed >= COOLDOWN_MS;
}

/**
 * Reseta estado (útil para testes)
 */
export async function resetState(): Promise<void> {
  await saveState({
    consecutiveFailures: 0,
    lastNotificationAt: null,
    lastError: null,
  });
}

/**
 * Obtém estado atual (útil para debug)
 */
export async function getState(): Promise<SyncErrorState> {
  return await loadState();
}
