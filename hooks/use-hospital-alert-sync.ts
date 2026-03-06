/**
 * Hook useHospitalAlertSync - Cliente completo de integração HospitalAlert
 * 
 * Gerencia sincronização automática entre app de escalas e HospitalAlert:
 * - auth.syncUser no login
 * - shifts.start ao detectar escala ativa
 * - shifts.end quando escala termina
 * - retry/backoff 1s/3s/10s
 * - fila offline persistente
 * - idempotência e dedupe
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useAuth } from "./use-auth";
import * as Orchestrator from "@/lib/integrationOrchestrator";
import * as ShiftDetector from "@/lib/shiftDetector";
import * as HospitalAlertClient from "@/lib/hospitalAlertClient";
import { processIntegrationQueue } from "@/lib/integrationQueueProcessor";
import { loadQueue } from "@/lib/integrationQueue";
import { logAudit } from "@/lib/auditLog";

// ============================================================================
// TYPES
// ============================================================================

export interface HospitalAlertStatus {
  connected: boolean;
  shiftActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: "success" | "error" | "never";
  lastError: string | null;
  serverTime?: string | null;
  service?: { id: number; name: string } | null;
  sector?: { id: number; name: string } | null;
  coverageType?: "GLOBAL" | "SECTOR_SPECIFIC" | null;
}

export interface HospitalAlertSyncReturn {
  status: HospitalAlertStatus;
  actions: {
    syncNow: () => Promise<void>;
    startIfNeeded: () => Promise<void>;
    endIfNeeded: () => Promise<void>;
  };
  meta: {
    isLoading: boolean;
    isSyncing: boolean;
    queueSize: number;
  };
}

// ============================================================================
// STORAGE KEYS
// ============================================================================

const LAST_STATUS_KEY = "@hospital_shifts:hospitalAlertLastStatus";
const LAST_AUTO_SYNC_KEY = "@hospital_shifts:lastAutoSync";

// ============================================================================
// HOOK
// ============================================================================

export function useHospitalAlertSync(): HospitalAlertSyncReturn {
  const { user, isAuthenticated } = useAuth();
  
  const [status, setStatus] = useState<HospitalAlertStatus>({
    connected: false,
    shiftActive: false,
    lastSyncAt: null,
    lastSyncStatus: "never",
    lastError: null,
  });
  
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [queueSize, setQueueSize] = useState(0);
  
  const lastProcessedShiftId = useRef<number | null>(null);
  const processingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // ============================================================================
  // CACHE STATUS
  // ============================================================================
  
  /**
   * Carrega status cacheado do AsyncStorage
   */
  const loadCachedStatus = useCallback(async (): Promise<HospitalAlertStatus | null> => {
    try {
      const json = await AsyncStorage.getItem(LAST_STATUS_KEY);
      if (!json) return null;
      return JSON.parse(json);
    } catch (error) {
      console.error("[useHospitalAlertSync] Erro ao carregar status cacheado:", error);
      return null;
    }
  }, []);
  
  /**
   * Salva status no cache
   */
  const saveCachedStatus = useCallback(async (newStatus: HospitalAlertStatus) => {
    try {
      await AsyncStorage.setItem(LAST_STATUS_KEY, JSON.stringify(newStatus));
    } catch (error) {
      console.error("[useHospitalAlertSync] Erro ao salvar status:", error);
    }
  }, []);
  
  // ============================================================================
  // FETCH STATUS
  // ============================================================================
  
  /**
   * Busca status real do HospitalAlert via integration.getStatus
   */
  const fetchStatus = useCallback(async (): Promise<void> => {
    if (!user) return;
    
    setIsLoading(true);
    
    try {
      const result = await Orchestrator.getIntegrationStatus(user.id);
      
      if (result.ok && result.data) {
        const newStatus: HospitalAlertStatus = {
          connected: result.data.connection.connected,
          shiftActive: result.data.shift.active,
          lastSyncAt: result.data.connection.lastSyncAt,
          lastSyncStatus: result.data.connection.lastSyncStatus,
          lastError: result.data.connection.lastError,
          serverTime: result.data.serverTime,
          service: result.data.shift.service,
          sector: result.data.shift.sector,
          coverageType: result.data.shift.coverageType as any,
        };
        
        setStatus(newStatus);
        await saveCachedStatus(newStatus);
        await logAudit("getStatus", true);
      } else {
        // Falha ao buscar status: usar cache
        const cached = await loadCachedStatus();
        if (cached) {
          setStatus({
            ...cached,
            connected: false,
            lastSyncStatus: "error",
            lastError: result.error || "Erro ao buscar status",
          });
        }
        await logAudit("getStatus", false, result.httpStatus, result.error);
      }
    } catch (error: any) {
      console.error("[useHospitalAlertSync] Erro ao buscar status:", error);
      
      // Usar cache em caso de erro
      const cached = await loadCachedStatus();
      if (cached) {
        setStatus({
          ...cached,
          connected: false,
          lastSyncStatus: "error",
          lastError: error.message || "Erro desconhecido",
        });
      }
      await logAudit("getStatus", false, undefined, error.message);
    } finally {
      setIsLoading(false);
    }
  }, [user, loadCachedStatus, saveCachedStatus]);
  
  // ============================================================================
  // ACTIONS
  // ============================================================================
  
  /**
   * Sincroniza usuário e atualiza status
   */
  const syncNow = useCallback(async (): Promise<void> => {
    if (!user || isSyncing) return;
    
    setIsSyncing(true);
    
    try {
      // 1. syncUser
      await Orchestrator.syncUser({
        id: user.id,
        openId: user.openId,
        name: user.name || "",
        email: user.email || "",
        role: "MEDICO", // TODO: Adicionar role ao User type
      });
      
      // 2. Processar fila
      await processIntegrationQueue();
      
      // 3. Atualizar status
      await fetchStatus();
      
      // 4. Se escala ativa, chamar startIfNeeded
      const activeShift = ShiftDetector.getActiveShift(user.id);
      if (activeShift) {
        await startIfNeeded();
      }
    } catch (error) {
      console.error("[useHospitalAlertSync] Erro em syncNow:", error);
    } finally {
      setIsSyncing(false);
    }
  }, [user, isSyncing, fetchStatus]);
  
  /**
   * Inicia shift se necessário (idempotente)
   */
  const startIfNeeded = useCallback(async (): Promise<void> => {
    if (!user) return;
    
    try {
      // Buscar status atual
      const result = await Orchestrator.getIntegrationStatus(user.id);
      
      // Se já tem shift ativo no HospitalAlert, não fazer nada
      if (result.ok && result.data?.shift.active) {
        console.log("[useHospitalAlertSync] Shift já ativo no HospitalAlert");
        return;
      }
      
      // Buscar escala ativa local
      const activeShift = ShiftDetector.getActiveShift(user.id);
      if (!activeShift) {
        console.log("[useHospitalAlertSync] Nenhuma escala ativa local");
        return;
      }
      
      // Executar syncUser se necessário
      if (result.ok && result.data && !result.data.user.exists) {
        await Orchestrator.syncUser({
          id: user.id,
          openId: user.openId,
          name: user.name || "",
          email: user.email || "",
          role: "MEDICO",
        });
      }
      
      // Executar startShift
      await Orchestrator.startShift(
        {
          id: user.id,
          openId: user.openId,
          name: user.name || "",
          email: user.email || "",
          role: "MEDICO",
        },
        {
          id: activeShift.id,
          serviceId: activeShift.serviceId,
          sectorId: activeShift.sectorId,
          coverageType: activeShift.coverageType,
          staffingStatus: activeShift.staffingStatus,
          startTime: activeShift.startTime,
          endTime: activeShift.endTime,
        }
      );
      
      // Atualizar status
      await fetchStatus();
    } catch (error) {
      console.error("[useHospitalAlertSync] Erro em startIfNeeded:", error);
    }
  }, [user, fetchStatus]);
  
  /**
   * Finaliza shift se necessário (idempotente)
   */
  const endIfNeeded = useCallback(async (): Promise<void> => {
    if (!user) return;
    
    try {
      // Buscar status atual
      const result = await Orchestrator.getIntegrationStatus(user.id);
      
      // Se não tem shift ativo no HospitalAlert, não fazer nada
      if (!result.ok || !result.data?.shift.active) {
        console.log("[useHospitalAlertSync] Nenhum shift ativo no HospitalAlert");
        return;
      }
      
      // Executar endShift
      await Orchestrator.endShift(
        {
          id: user.id,
          openId: user.openId,
          name: user.name || "",
          email: user.email || "",
          role: "MEDICO",
        },
        result.data.shift.shiftId || 0
      );
      
      // Atualizar status
      await fetchStatus();
    } catch (error) {
      console.error("[useHospitalAlertSync] Erro em endIfNeeded:", error);
    }
  }, [user, fetchStatus]);
  
  // ============================================================================
  // AUTO-SYNC AO ABRIR APP (CONSERVADOR)
  // ============================================================================
  
  /**
   * Verifica se deve executar auto-sync
   */
  const shouldAutoSync = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    
    // Verificar se existe escala ativa agora
    const activeShift = ShiftDetector.getActiveShift(user.id);
    if (!activeShift) return false;
    
    // Verificar debounce global (60s)
    try {
      const lastAutoSyncStr = await AsyncStorage.getItem(LAST_AUTO_SYNC_KEY);
      if (lastAutoSyncStr) {
        const lastAutoSync = new Date(lastAutoSyncStr);
        const elapsed = Date.now() - lastAutoSync.getTime();
        if (elapsed < 60 * 1000) {
          console.log("[useHospitalAlertSync] Auto-sync em debounce");
          return false;
        }
      }
    } catch (error) {
      console.error("[useHospitalAlertSync] Erro ao verificar debounce:", error);
    }
    
    // Verificar condições para auto-sync
    const { lastSyncAt, lastSyncStatus } = status;
    
    if (lastSyncAt === null) return true;
    if (lastSyncStatus === "error") return true;
    
    const lastSync = new Date(lastSyncAt);
    const elapsed = Date.now() - lastSync.getTime();
    if (elapsed > 5 * 60 * 1000) return true; // Mais de 5 minutos
    
    return false;
  }, [user, status]);
  
  /**
   * Executa auto-sync
   */
  const executeAutoSync = useCallback(async () => {
    const should = await shouldAutoSync();
    if (!should) return;
    
    console.log("[useHospitalAlertSync] Executando auto-sync");
    
    // Registrar timestamp do auto-sync
    await AsyncStorage.setItem(LAST_AUTO_SYNC_KEY, new Date().toISOString());
    
    // Executar syncNow
    await syncNow();
  }, [shouldAutoSync, syncNow]);
  
  // ============================================================================
  // LIFECYCLE
  // ============================================================================
  
  // Carregar status cacheado ao montar
  useEffect(() => {
    loadCachedStatus().then(cached => {
      if (cached) {
        setStatus(cached);
      }
    });
  }, [loadCachedStatus]);
  
  // Buscar status ao autenticar
  useEffect(() => {
    if (isAuthenticated && user) {
      fetchStatus();
    }
  }, [isAuthenticated, user, fetchStatus]);
  
  // syncUser no login
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    console.log("[useHospitalAlertSync] Usuário autenticado, executando syncUser");
    
    Orchestrator.syncUser({
      id: user.id,
      openId: user.openId,
      name: user.name || "",
      email: user.email || "",
      role: "MEDICO",
    });
  }, [isAuthenticated, user]);
  
  // Detectar escala ativa e chamar startShift/endShift
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    const checkActiveShift = () => {
      const activeShift = ShiftDetector.getActiveShift(user.id);
      
      if (activeShift && activeShift.isActive) {
        // Escala ativa detectada
        if (lastProcessedShiftId.current !== activeShift.id) {
          console.log("[useHospitalAlertSync] Escala ativa detectada:", activeShift.id);
          startIfNeeded();
          lastProcessedShiftId.current = activeShift.id;
        }
      } else {
        // Nenhuma escala ativa
        if (lastProcessedShiftId.current !== null) {
          console.log("[useHospitalAlertSync] Escala encerrada:", lastProcessedShiftId.current);
          endIfNeeded();
          lastProcessedShiftId.current = null;
        }
      }
    };
    
    // Verificar imediatamente
    checkActiveShift();
    
    // Verificar a cada minuto
    const interval = setInterval(checkActiveShift, 60 * 1000);
    
    return () => {
      clearInterval(interval);
    };
  }, [isAuthenticated, user, startIfNeeded, endIfNeeded]);
  
  // Processar fila ao montar e quando NetInfo mudar para online
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    // Processar fila imediatamente
    processIntegrationQueue();
    
    // Listener de NetInfo
    const unsubscribe = NetInfo.addEventListener((state: any) => {
      if (state.isConnected) {
        console.log("[useHospitalAlertSync] Rede online, processando fila");
        processIntegrationQueue();
      }
    });
    
    return () => {
      unsubscribe();
    };
  }, [isAuthenticated, user]);
  
  // Processar fila ao voltar do background
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === "active") {
        console.log("[useHospitalAlertSync] App voltou para foreground");
        processIntegrationQueue();
        executeAutoSync();
      }
    };
    
    const subscription = AppState.addEventListener("change", handleAppStateChange);
    
    return () => {
      subscription.remove();
    };
  }, [isAuthenticated, user, executeAutoSync]);
  
  // Processar fila periodicamente (a cada 5 minutos)
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    processingInterval.current = setInterval(() => {
      console.log("[useHospitalAlertSync] Processamento periódico da fila");
      processIntegrationQueue();
    }, 5 * 60 * 1000);
    
    return () => {
      if (processingInterval.current) {
        clearInterval(processingInterval.current);
      }
    };
  }, [isAuthenticated, user]);
  
  // Atualizar queueSize periodicamente
  useEffect(() => {
    const updateQueueSize = async () => {
      const queue = await loadQueue();
      setQueueSize(queue.filter(item => item.status === "pending").length);
    };
    
    updateQueueSize();
    
    const interval = setInterval(updateQueueSize, 10 * 1000); // A cada 10s
    
    return () => {
      clearInterval(interval);
    };
  }, []);
  
  // ============================================================================
  // RETURN
  // ============================================================================
  
  return {
    status,
    actions: {
      syncNow,
      startIfNeeded,
      endIfNeeded,
    },
    meta: {
      isLoading,
      isSyncing,
      queueSize,
    },
  };
}
