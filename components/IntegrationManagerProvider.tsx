/**
 * Provider para gerenciar integração com HospitalAlert
 * Deve envolver toda a aplicação para funcionar corretamente
 */

import { useIntegrationManager } from "@/hooks/use-integration-manager";

function IntegrationManagerBootstrap() {
  useIntegrationManager();
  return null;
}

export function IntegrationManagerProvider({ children }: { children: React.ReactNode }) {
  // Integração legada desativada por padrão para não gerar chamadas
  // para localhost:3001 quando o serviço não está ativo.
  const integrationEnabled = process.env.EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED === "true";
  return (
    <>
      {integrationEnabled ? <IntegrationManagerBootstrap /> : null}
      {children}
    </>
  );
}
