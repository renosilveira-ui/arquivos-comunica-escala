type NotificationData = Readonly<Record<string, unknown>>;

/**
 * Lease de identidade que autoriza somente a apresentação visual em primeiro
 * plano. Não é uma sessão, nem concede acesso a dados ou a rotas.
 */
export type VerifiedNotificationForegroundSubject = Readonly<{
  userId: number;
  generation: number;
}>;

let foregroundSubject: VerifiedNotificationForegroundSubject | null = null;
let nextForegroundSubjectGeneration = 0;

export function parseNotificationRecipientUserId(
  value: unknown,
): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Só o NotificationListener chama esta função depois da admissão VERIFIED da
 * sessão atual. Uma nova publicação substitui atomicamente o lease anterior.
 */
export function publishVerifiedNotificationForegroundSubject(
  userId: number,
): VerifiedNotificationForegroundSubject {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Sujeito de notificação em primeiro plano inválido");
  }
  const subject = Object.freeze({
    userId,
    generation: ++nextForegroundSubjectGeneration,
  });
  foregroundSubject = subject;
  return subject;
}

/**
 * Cleanup do consumer account-scoped: nunca pode apagar a publicação de uma
 * sessão B que já substituiu a sessão A no mesmo processo.
 */
export function releaseVerifiedNotificationForegroundSubject(
  subject: VerifiedNotificationForegroundSubject,
): void {
  if (foregroundSubject === subject) foregroundSubject = null;
}

/**
 * BEGIN de transição de sessão. É intencionalmente incondicional: enquanto a
 * próxima identidade não for VERIFIED, nenhum push pode ser apresentado.
 */
export function clearVerifiedNotificationForegroundSubject(): void {
  foregroundSubject = null;
}

export function shouldPresentForegroundNotification(
  data: NotificationData | null | undefined,
): boolean {
  return (
    foregroundSubject !== null &&
    parseNotificationRecipientUserId(data?.recipientUserId) ===
      foregroundSubject.userId
  );
}
