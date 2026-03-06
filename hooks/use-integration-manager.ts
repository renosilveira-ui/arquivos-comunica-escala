/**
 * Hook para gerenciar integração com HospitalAlert
 * Orquestra syncUser, startShift, endShift e processamento de fila
 */

import { useEffect, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useAuth } from "./use-auth";
import * as Orchestrator from "@/lib/integrationOrchestrator";
import * as ShiftDetector from "@/lib/shiftDetector";
import { processIntegrationQueue } from "@/lib/integrationQueueProcessor";

/**
 * Hook principal de gerenciamento de integração
 * Executa automaticamente:
 * - syncUser no login
 * - startShift ao detectar escala ativa
 * - endShift quando escala termina
 * - processIntegrationQueue ao abrir app, voltar do background, ou ficar online
 */
export function useIntegrationManager() {
  const { user, isAuthenticated } = useAuth();
  const lastProcessedShiftId = useRef<number | null>(null);
  const processingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Processar fila ao montar e quando NetInfo mudar para online
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    // Processar fila imediatamente ao montar
    processIntegrationQueue();
    
    // Listener de NetInfo
    const unsubscribe = NetInfo.addEventListener((state: any) => {
      if (state.isConnected) {
        console.log("[IntegrationManager] Rede online, processando fila");
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
        console.log("[IntegrationManager] App voltou para foreground, processando fila");
        processIntegrationQueue();
      }
    };
    
    const subscription = AppState.addEventListener("change", handleAppStateChange);
    
    return () => {
      subscription.remove();
    };
  }, [isAuthenticated, user]);
  
  // Processar fila periodicamente (a cada 5 minutos)
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    processingInterval.current = setInterval(() => {
      console.log("[IntegrationManager] Processamento periódico da fila");
      processIntegrationQueue();
    }, 5 * 60 * 1000); // 5 minutos
    
    return () => {
      if (processingInterval.current) {
        clearInterval(processingInterval.current);
      }
    };
  }, [isAuthenticated, user]);
  
  // syncUser no login
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    console.log("[IntegrationManager] Usuário autenticado, executando syncUser");
    
    Orchestrator.syncUser({
      id: user.id,
      openId: user.openId,
      name: user.name || "",
      email: user.email || "",
      role: "MEDICO", // TODO: Adicionar role ao User type
    });
  }, [isAuthenticated, user]);
  
  // Detectar escala ativa e chamar startShift/endShift
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    
    // Verificar escala ativa a cada minuto
    const checkActiveShift = () => {
      const activeShift = ShiftDetector.getActiveShift(user.id);
      
      if (activeShift && activeShift.isActive) {
        // Escala ativa detectada
        if (lastProcessedShiftId.current !== activeShift.id) {
          console.log("[IntegrationManager] Escala ativa detectada:", activeShift.id);
          
          // Chamar startShift
          Orchestrator.startShift(
            {
              id: user.id,
              openId: user.openId,
              name: user.name || "",
              email: user.email || "",
              role: "MEDICO", // TODO: Adicionar role ao User type
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
          
          lastProcessedShiftId.current = activeShift.id;
        }
      } else {
        // Nenhuma escala ativa
        if (lastProcessedShiftId.current !== null) {
          console.log("[IntegrationManager] Escala encerrada:", lastProcessedShiftId.current);
          
          // Chamar endShift
          Orchestrator.endShift(
            {
              id: user.id,
              openId: user.openId,
              name: user.name || "",
              email: user.email || "",
              role: "MEDICO", // TODO: Adicionar role ao User type
            },
            lastProcessedShiftId.current
          );
          
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
  }, [isAuthenticated, user]);
}
