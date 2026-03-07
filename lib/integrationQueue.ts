/**
 * Fila offline persistente para integração com HospitalAlert
 * Armazena chamadas pendentes no AsyncStorage e processa quando API disponível
 */

import { HOSPITAL_ALERT_CONFIG } from "./hospitalAlertConfig";

// Lazy accessor: in tests globalThis.AsyncStorage is mocked;
// at runtime we load the real module on first use.
function getAsyncStorage(): typeof import("@react-native-async-storage/async-storage").default {
  if ((globalThis as any).AsyncStorage) {
    return (globalThis as any).AsyncStorage;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@react-native-async-storage/async-storage");
  return mod?.default ?? mod;
}

const AsyncStorage = new Proxy({} as any, {
  get(_target, prop) {
    return (getAsyncStorage() as any)[prop];
  },
});

// ============================================================================
// TYPES
// ============================================================================

export type QueueItemType = "syncUser" | "startShift" | "endShift";

export type QueueItemStatus = "pending" | "success" | "error";

export interface QueueItem {
  id: string;
  type: QueueItemType;
  payload: any;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  status: QueueItemStatus;
  lastError?: string;
}

// ============================================================================
// STORAGE KEYS
// ============================================================================

const QUEUE_STORAGE_KEY = "@hospital_shifts:integrationQueue";
const DEBOUNCE_STORAGE_KEY = "@hospital_shifts:integrationDebounce";

// ============================================================================
// QUEUE OPERATIONS
// ============================================================================

/**
 * Carrega fila do AsyncStorage
 */
export async function loadQueue(): Promise<QueueItem[]> {
  try {
    const json = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
    if (!json) return [];
    
    const queue = JSON.parse(json) as QueueItem[];
    return queue;
  } catch (error) {
    console.error("[IntegrationQueue] Erro ao carregar fila:", error);
    return [];
  }
}

/**
 * Salva fila no AsyncStorage
 */
export async function saveQueue(queue: QueueItem[]): Promise<void> {
  try {
    // Limitar tamanho da fila
    let filteredQueue = queue;
    
    // Remover itens success antigos (manter apenas últimos 20)
    const successItems = queue.filter(item => item.status === "success");
    const otherItems = queue.filter(item => item.status !== "success");
    
    const recentSuccess = successItems
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, HOSPITAL_ALERT_CONFIG.QUEUE.KEEP_SUCCESS_COUNT);
    
    filteredQueue = [...otherItems, ...recentSuccess];
    
    // Limitar tamanho total
    if (filteredQueue.length > HOSPITAL_ALERT_CONFIG.QUEUE.MAX_SIZE) {
      filteredQueue = filteredQueue
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, HOSPITAL_ALERT_CONFIG.QUEUE.MAX_SIZE);
    }
    
    await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(filteredQueue));
  } catch (error) {
    console.error("[IntegrationQueue] Erro ao salvar fila:", error);
  }
}

/**
 * Adiciona item à fila com dedupe para evitar duplicados
 */
export async function enqueue(type: QueueItemType, payload: any): Promise<string> {
  const queue = await loadQueue();
  
  // Dedupe: verificar se já existe item pending idêntico
  if (type === "startShift") {
    const duplicate = queue.find(
      item =>
        item.status === "pending" &&
        item.type === "startShift" &&
        item.payload.externalUserId === payload.externalUserId &&
        item.payload.serviceId === payload.serviceId &&
        item.payload.sectorId === payload.sectorId &&
        item.payload.coverageType === payload.coverageType
    );
    
    if (duplicate) {
      console.log("[IntegrationQueue] startShift duplicado ignorado:", duplicate.id);
      return duplicate.id;
    }
  }
  
  if (type === "endShift") {
    const duplicate = queue.find(
      item =>
        item.status === "pending" &&
        item.type === "endShift" &&
        item.payload.externalUserId === payload.externalUserId
    );
    
    if (duplicate) {
      console.log("[IntegrationQueue] endShift duplicado ignorado:", duplicate.id);
      return duplicate.id;
    }
  }
  
  const id = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const item: QueueItem = {
    id,
    type,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: "pending",
  };
  
  queue.push(item);
  await saveQueue(queue);
  
  console.log("[IntegrationQueue] Item enfileirado:", id, type);
  
  return id;
}

/**
 * Atualiza item na fila
 */
export async function updateQueueItem(
  id: string,
  updates: Partial<QueueItem>
): Promise<void> {
  const queue = await loadQueue();
  
  const index = queue.findIndex(item => item.id === id);
  if (index === -1) {
    console.warn("[IntegrationQueue] Item não encontrado:", id);
    return;
  }
  
  queue[index] = { ...queue[index], ...updates };
  await saveQueue(queue);
  
  console.log("[IntegrationQueue] Item atualizado:", id, updates.status);
}

/**
 * Remove item da fila
 */
export async function dequeue(id: string): Promise<void> {
  const queue = await loadQueue();
  const filteredQueue = queue.filter(item => item.id !== id);
  await saveQueue(filteredQueue);
  
  console.log("[IntegrationQueue] Item removido:", id);
}

/**
 * Busca próximos itens pendentes para processar
 * Respeita ordem de prioridade: syncUser → startShift → endShift
 */
export async function getPendingItems(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  const now = new Date();
  
  // Filtrar apenas itens pending que podem ser processados agora
  const pendingItems = queue.filter(item => {
    if (item.status !== "pending") return false;
    
    // Se tem nextAttemptAt, verificar se já passou
    if (item.nextAttemptAt) {
      const nextAttempt = new Date(item.nextAttemptAt);
      if (nextAttempt > now) return false;
    }
    
    return true;
  });
  
  // Ordenar por prioridade: syncUser > startShift > endShift
  const priorityOrder: Record<QueueItemType, number> = {
    syncUser: 1,
    startShift: 2,
    endShift: 3,
  };
  
  return pendingItems.sort((a, b) => {
    const priorityDiff = priorityOrder[a.type] - priorityOrder[b.type];
    if (priorityDiff !== 0) return priorityDiff;
    
    // Mesma prioridade: ordenar por data de criação (mais antigo primeiro)
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

/**
 * Marca item como sucesso
 */
export async function markSuccess(id: string): Promise<void> {
  await updateQueueItem(id, {
    status: "success",
    lastAttemptAt: new Date().toISOString(),
  });
}

/**
 * Marca item como erro e agenda próxima tentativa
 */
export async function markError(
  id: string,
  error: string,
  attempts: number
): Promise<void> {
  const maxAttempts = HOSPITAL_ALERT_CONFIG.RETRY.ATTEMPTS;
  
  let nextAttemptAt: string | undefined;
  
  // Se ainda não atingiu o máximo de tentativas, agendar próxima tentativa
  if (attempts < maxAttempts) {
    const backoffMs = HOSPITAL_ALERT_CONFIG.RETRY.BACKOFF_MS[attempts] || 10000;
    nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
  } else {
    // Após máximo de tentativas, agendar para +15 minutos
    nextAttemptAt = new Date(Date.now() + HOSPITAL_ALERT_CONFIG.RETRY.NEXT_ATTEMPT_DELAY_MS).toISOString();
  }
  
  await updateQueueItem(id, {
    status: "pending", // Manter pending para retry
    attempts: attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    nextAttemptAt,
    lastError: error,
  });
}

/**
 * Marca item como erro fatal (não retry)
 */
export async function markFatalError(id: string, error: string): Promise<void> {
  await updateQueueItem(id, {
    status: "error",
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
  });
}

/**
 * Limpa fila (usar com cuidado)
 */
export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_STORAGE_KEY);
  console.log("[IntegrationQueue] Fila limpa");
}

// ============================================================================
// DEBOUNCE OPERATIONS
// ============================================================================

interface DebounceRecord {
  [key: string]: string; // key: tipo_operação, value: timestamp ISO
}

/**
 * Carrega registro de debounce
 */
async function loadDebounceRecord(): Promise<DebounceRecord> {
  try {
    const json = await AsyncStorage.getItem(DEBOUNCE_STORAGE_KEY);
    if (!json) return {};
    return JSON.parse(json);
  } catch (error) {
    console.error("[IntegrationQueue] Erro ao carregar debounce:", error);
    return {};
  }
}

/**
 * Salva registro de debounce
 */
async function saveDebounceRecord(record: DebounceRecord): Promise<void> {
  try {
    await AsyncStorage.setItem(DEBOUNCE_STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    console.error("[IntegrationQueue] Erro ao salvar debounce:", error);
  }
}

/**
 * Verifica se operação está em debounce
 */
export async function isDebounced(type: QueueItemType, key: string): Promise<boolean> {
  const record = await loadDebounceRecord();
  const debounceKey = `${type}_${key}`;
  
  const lastAttempt = record[debounceKey];
  if (!lastAttempt) return false;
  
  const debounceMs = HOSPITAL_ALERT_CONFIG.DEBOUNCE[`${type.toUpperCase()}_MS` as keyof typeof HOSPITAL_ALERT_CONFIG.DEBOUNCE] || 60000;
  const elapsed = Date.now() - new Date(lastAttempt).getTime();
  
  return elapsed < debounceMs;
}

/**
 * Registra tentativa de operação para debounce
 */
export async function recordDebounce(type: QueueItemType, key: string): Promise<void> {
  const record = await loadDebounceRecord();
  const debounceKey = `${type}_${key}`;
  record[debounceKey] = new Date().toISOString();
  await saveDebounceRecord(record);
}

/**
 * Limpa registro de debounce
 */
export async function clearDebounce(): Promise<void> {
  await AsyncStorage.removeItem(DEBOUNCE_STORAGE_KEY);
  console.log("[IntegrationQueue] Debounce limpo");
}
