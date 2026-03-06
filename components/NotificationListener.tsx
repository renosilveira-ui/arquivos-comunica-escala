/**
 * Componente que escuta notificações e executa ações
 * Usado para chamar syncNow() quando usuário toca em notificação de erro
 */

import { useEffect } from "react";
import * as Notifications from "expo-notifications";

export function NotificationListener() {
  // Não usar useHospitalAlertSync aqui para evitar dependência circular
  // Importar ação diretamente quando necessário
  
  useEffect(() => {
    // Listener para quando usuário toca na notificação
    const subscription = Notifications.addNotificationResponseReceivedListener(async (response) => {
      console.log("[NotificationListener] Usuário tocou na notificação:", response);
      
      const data = response.notification.request.content.data;
      
      // Se é notificação de erro de sincronização, processar fila
      if (data?.type === "sync_error") {
        console.log("[NotificationListener] Processando fila após tocar em notificação de erro");
        // Importar dinamicamente para evitar dependência circular
        const { processIntegrationQueue } = await import("@/lib/integrationQueueProcessor");
        await processIntegrationQueue();
      }
    });
    
    return () => {
      subscription.remove();
    };
  }, []);
  
  return null; // Componente invisível
}
