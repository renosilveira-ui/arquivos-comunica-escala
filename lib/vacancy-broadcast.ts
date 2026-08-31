/**
 * Contrato do aviso deliberado de plantão vago (gestor → plantonistas).
 * Sem disparo automático em markVacant / unassignDirect.
 */

export const VACANCY_AVAILABLE_PUSH_TYPE = "vacancy_available";
export const VACANCY_AVAILABLE_PUSH_TITLE = "Plantão vago disponível";
export const VACANCY_AVAILABLE_DEEP_LINK = "/(tabs)/vacancies";

/** 15 min: cobre double-tap sem impedir um segundo aviso se a vaga continuar aberta. */
export const VACANCY_BROADCAST_COOLDOWN_MS = 15 * 60 * 1000;

export function vacancyBroadcastCooldownBucket(now: Date): number {
  return Math.floor(now.getTime() / VACANCY_BROADCAST_COOLDOWN_MS);
}

export function vacancyBroadcastDedupKey(input: {
  shiftInstanceId: number;
  userId: number;
  now: Date;
}): string {
  return `vacancy-notify:${input.shiftInstanceId}:${input.userId}:${vacancyBroadcastCooldownBucket(input.now)}`;
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
