/**
 * Worker propositalmente inerte da fundação de eventos operacionais.
 *
 * A flag é opt-in explícita e, mesmo habilitada, esta primeira frente não
 * reivindica deliveries nem carrega adaptadores de push/e-mail. Assim, uma
 * configuração acidental não pode transformar a migration em disparo real.
 */
export const OPERATIONAL_DELIVERY_WORKER_ENABLED_FLAG =
  "OPERATIONAL_DELIVERY_WORKER_ENABLED";

export type OperationalDeliveryWorkerRun = {
  mode: "DISABLED" | "INERT_NO_TRANSPORT";
  claimed: 0;
  providerAccepted: 0;
  delivered: 0;
  failed: 0;
};

/**
 * Só o literal `true` ativa a fundação. Valores como `1`, `yes`, ausência ou
 * capitalização diferente permanecem desabilitados para evitar ativação por
 * convenção de ambiente não revisada.
 */
export function isOperationalDeliveryWorkerEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment[OPERATIONAL_DELIVERY_WORKER_ENABLED_FLAG] === "true";
}

/**
 * Nenhuma chamada a provedor ou banco é feita nesta versão. Uma frente futura
 * deverá acrescentar claim transacional, renovação de lease e adaptadores por
 * canal, preservando QUEUED/PROCESSING/PROVIDER_ACCEPTED/DELIVERED/FAILED/DEAD.
 */
export async function runOperationalDeliveryWorker(
  environment: Record<string, string | undefined> = process.env,
): Promise<OperationalDeliveryWorkerRun> {
  if (!isOperationalDeliveryWorkerEnabled(environment)) {
    return {
      mode: "DISABLED",
      claimed: 0,
      providerAccepted: 0,
      delivered: 0,
      failed: 0,
    };
  }

  return {
    mode: "INERT_NO_TRANSPORT",
    claimed: 0,
    providerAccepted: 0,
    delivered: 0,
    failed: 0,
  };
}
