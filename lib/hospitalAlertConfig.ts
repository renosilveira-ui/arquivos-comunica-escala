/**
 * Configuração do cliente para integração Hospital Alert.
 * Segredos e URL upstream ficam no servidor (/api/integrations/hospital-alert).
 */

export const HOSPITAL_ALERT_CONFIG = {
  ORGANIZATION_ID: "hsc",
  INTEGRATION_VERSION: "v1",
  SOURCE_APP: "SHIFTS_APP",
  TIMEOUT_MS: 8000,
  RETRY: {
    ATTEMPTS: 3,
    BACKOFF_MS: [1000, 3000, 10000] as const,
    NEXT_ATTEMPT_DELAY_MS: 15 * 60 * 1000,
  },
  QUEUE: {
    MAX_SIZE: 50,
    KEEP_SUCCESS_COUNT: 20,
  },
  DEBOUNCE: {
    START_SHIFT_MS: 60 * 1000,
    END_SHIFT_MS: 60 * 1000,
    SYNC_USER_MS: 15 * 1000,
  },
  STATUS: {
    CONNECTED_THRESHOLD_MS: 10 * 60 * 1000,
    REFETCH_INTERVAL_MS: 30 * 1000,
  },
} as const;

export function isHospitalAlertIntegrationEnabled(): boolean {
  return process.env.EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED === "true";
}

export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isHospitalAlertIntegrationEnabled()) {
    errors.push("Integração Hospital Alert desabilitada no cliente");
  }
  if (!HOSPITAL_ALERT_CONFIG.ORGANIZATION_ID) {
    errors.push("ORGANIZATION_ID não configurado");
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}
