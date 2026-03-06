/**
 * Processador de fila de integração com HospitalAlert
 * Processa itens pendentes da fila offline quando API disponível
 */

import * as Queue from "./integrationQueue";
import * as HospitalAlertClient from "./hospitalAlertClient";
import { HOSPITAL_ALERT_CONFIG } from "./hospitalAlertConfig";
import { logAudit } from "./auditLog";

// ============================================================================
// QUEUE PROCESSOR
// ============================================================================

let isProcessing = false;

/**
 * Processa fila de integração
 * Executa itens pendentes em ordem de prioridade: syncUser → startShift → endShift
 */
export async function processIntegrationQueue(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  stopped: boolean;
}> {
  // Evitar processamento concorrente
  if (isProcessing) {
    console.log("[QueueProcessor] Processamento já em andamento");
    return { processed: 0, succeeded: 0, failed: 0, stopped: false };
  }
  
  isProcessing = true;
  
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let stopped = false;
  
  try {
    console.log("[QueueProcessor] Iniciando processamento da fila");
    
    // Buscar itens pendentes
    const pendingItems = await Queue.getPendingItems();
    
    if (pendingItems.length === 0) {
      console.log("[QueueProcessor] Nenhum item pendente");
      return { processed: 0, succeeded: 0, failed: 0, stopped: false };
    }
    
    console.log(`[QueueProcessor] ${pendingItems.length} itens pendentes`);
    
    // Processar cada item
    for (const item of pendingItems) {
      processed++;
      
      console.log(`[QueueProcessor] Processando item ${item.id} (${item.type})`);
      
      // Executar operação baseado no tipo
      let result: HospitalAlertClient.HospitalAlertResponse;
      
      switch (item.type) {
        case "syncUser":
          result = await HospitalAlertClient.syncUser(item.payload);
          break;
        case "startShift":
          result = await HospitalAlertClient.startShift(item.payload);
          break;
        case "endShift":
          result = await HospitalAlertClient.endShift(item.payload);
          break;
        default:
          console.error(`[QueueProcessor] Tipo desconhecido: ${item.type}`);
          continue;
      }
      
      // Processar resultado
      if (result.ok) {
        await Queue.markSuccess(item.id);
        succeeded++;
        console.log(`[QueueProcessor] Item ${item.id} processado com sucesso`);
      } else {
        // Verificar se é erro fatal (401, 403)
        const isFatalAuthError = result.httpStatus && [401, 403].includes(result.httpStatus);
        
        if (isFatalAuthError) {
          await Queue.markFatalError(item.id, result.error || "Erro de autenticação");
          failed++;
          stopped = true;
          console.error(`[QueueProcessor] Erro de autenticação fatal: ${result.error}`);
          break; // Parar processamento
        }
        
        // Verificar se é erro fatal de payload (400, 404)
        const isFatalPayloadError = result.httpStatus && [400, 404].includes(result.httpStatus);
        
        if (isFatalPayloadError) {
          await Queue.markFatalError(item.id, result.error || "Erro fatal");
          failed++;
          console.error(`[QueueProcessor] Erro fatal de payload: ${result.error}`);
          continue; // Continuar com próximo item
        }
        
        // Erro transitório: marcar para retry
        await Queue.markError(item.id, result.error || "Erro desconhecido", item.attempts);
        failed++;
        console.warn(`[QueueProcessor] Erro transitório: ${result.error}`);
      }
    }
    
    console.log(`[QueueProcessor] Processamento concluído: ${processed} processados, ${succeeded} sucesso, ${failed} falhas`);
    
    // Log de auditoria do processamento
    await logAudit("processQueue", failed === 0, undefined, failed > 0 ? `${failed} falhas` : undefined);
    
    return { processed, succeeded, failed, stopped };
  } finally {
    isProcessing = false;
  }
}

/**
 * Verifica se processador está em execução
 */
export function isQueueProcessing(): boolean {
  return isProcessing;
}
