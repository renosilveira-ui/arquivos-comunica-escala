/**
 * Configuração central para integração com HospitalAlert
 * API key e URLs sensíveis devem vir de env/secure store
 */

// Lazy accessor for expo-constants — returns undefined in Node/test environments
function getExpoConstants(): { expoConfig?: { extra?: Record<string, string> } } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-constants")?.default;
  } catch {
    return undefined;
  }
}

export const HOSPITAL_ALERT_CONFIG = {
  // Base URL do HospitalAlert (configurável via env)
  BASE_URL: process.env.HOSPITAL_ALERT_URL || getExpoConstants()?.expoConfig?.extra?.hospitalAlertUrl || "http://localhost:3001",
  
  // API Key para autenticação (NUNCA hardcoded - deve vir de env)
  API_KEY: process.env.HOSPITAL_ALERT_API_KEY || getExpoConstants()?.expoConfig?.extra?.hospitalAlertApiKey || "",
  
  // Organization ID
  ORGANIZATION_ID: "hsc",
  
  // Versão da integração
  INTEGRATION_VERSION: "v1",
  
  // Source app identifier
  SOURCE_APP: "SHIFTS_APP",
  
  // HTTP timeout (5-8 segundos)
  TIMEOUT_MS: 8000,
  
  // Retry configuration
  RETRY: {
    ATTEMPTS: 3,
    BACKOFF_MS: [1000, 3000, 10000], // 1s, 3s, 10s
    NEXT_ATTEMPT_DELAY_MS: 15 * 60 * 1000, // 15 minutos
  },
  
  // Queue configuration
  QUEUE: {
    MAX_SIZE: 50,
    KEEP_SUCCESS_COUNT: 20,
  },
  
  // Debounce configuration
  DEBOUNCE: {
    START_SHIFT_MS: 60 * 1000, // 60 segundos
    END_SHIFT_MS: 60 * 1000,
    SYNC_USER_MS: 15 * 1000, // 15 segundos
  },
  
  // Status check configuration
  STATUS: {
    CONNECTED_THRESHOLD_MS: 10 * 60 * 1000, // 10 minutos
    REFETCH_INTERVAL_MS: 30 * 1000, // 30 segundos
  },
} as const;

/**
 * Valida se a configuração está completa
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!HOSPITAL_ALERT_CONFIG.BASE_URL) {
    errors.push("HOSPITAL_ALERT_URL não configurado");
  }
  
  if (!HOSPITAL_ALERT_CONFIG.API_KEY) {
    errors.push("HOSPITAL_ALERT_API_KEY não configurado");
  }
  
  if (!HOSPITAL_ALERT_CONFIG.ORGANIZATION_ID) {
    errors.push("ORGANIZATION_ID não configurado");
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}
