/**
 * Provider para gerenciar integração com HospitalAlert
 * Deve envolver toda a aplicação para funcionar corretamente
 */

import { useIntegrationManager } from "@/hooks/use-integration-manager";

export function IntegrationManagerProvider({ children }: { children: React.ReactNode }) {
  // Hook executa automaticamente toda a lógica de integração
  useIntegrationManager();
  
  return <>{children}</>;
}
