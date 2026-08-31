/**
 * Contrato do aviso deliberado de plantão vago (gestor → plantonistas).
 * Sem disparo automático em markVacant / unassignDirect.
 */

export const VACANCY_AVAILABLE_PUSH_TYPE = "vacancy_available";
export const VACANCY_AVAILABLE_PUSH_TITLE = "Plantão vago disponível";
export const VACANCY_AVAILABLE_DEEP_LINK = "/(tabs)/vacancies";

/** 15 min: cobre double-tap sem impedir um segundo aviso se a vaga continuar aberta. */
export const VACANCY_BROADCAST_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Cooldown temporal real: elapsed desde o último broadcast deste plantão.
 * Não usa bucket de relógio — a virada de época (12:14:59 → 12:15:01)
 * continuaria bloqueada.
 */
export function vacancyBroadcastStillCoolingDown(
  lastBroadcastAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!lastBroadcastAt) return false;
  const lastMs = lastBroadcastAt.getTime();
  if (!Number.isFinite(lastMs)) return false;
  return now.getTime() - lastMs < VACANCY_BROADCAST_COOLDOWN_MS;
}

export function vacancyBroadcastDedupKey(input: {
  shiftInstanceId: number;
  userId: number;
  now: Date;
}): string {
  // Wave id = instante desta mutation (capturado uma vez na TX).
  // Unicidade do outbox, não janela de cooldown — o gate é createdAt.
  return `vacancy-notify:${input.shiftInstanceId}:${input.userId}:${input.now.getTime()}`;
}

export function vacancyBroadcastDedupPrefix(shiftInstanceId: number): string {
  return `vacancy-notify:${shiftInstanceId}:`;
}

export function shouldInvalidateVacancyQueriesOnNotification(
  type: unknown,
): boolean {
  return type === VACANCY_AVAILABLE_PUSH_TYPE;
}

export function vacancyBroadcastFeedbackMessage(notifiedCount: number): string {
  if (notifiedCount <= 0) {
    return "Nenhum médico elegível encontrado para este plantão.";
  }
  if (notifiedCount === 1) {
    return "Aviso enviado para 1 médico elegível.";
  }
  return `Aviso enviado para ${notifiedCount} médicos elegíveis.`;
}
