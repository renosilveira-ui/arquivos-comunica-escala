import { createHmac } from "node:crypto";
import type { MailMessage } from "./mailer";

const PROVIDER_REQUEST_FINGERPRINT_DOMAIN =
  "escala:schedule-invite-provider-request:v1\0";

// Deve permanecer igual ao fallback do mailer. O teste de integração por fonte
// fecha a divergência sem exigir alteração no módulo concorrente de e-mail.
export const SCHEDULE_INVITE_DEFAULT_MAIL_FROM =
  "Escala+ <no-reply@escalas.app>";

type ScheduleInviteMailEnvironment = {
  MAIL_FROM?: string;
};

function resolveScheduleInviteMailFrom(
  env: ScheduleInviteMailEnvironment,
): string {
  return (env.MAIL_FROM ?? "").trim() || SCHEDULE_INVITE_DEFAULT_MAIL_FROM;
}

/**
 * HMAC da representação exata que o mailer entrega à Resend. A ordem dos
 * campos é deliberadamente fixa e acompanha a serialização do provider. O
 * banco guarda somente este digest, nunca destinatário, código ou conteúdo;
 * sem o pepper não há oráculo offline para o código curto contido no request.
 */
export function fingerprintScheduleInviteProviderRequest(
  message: MailMessage,
  pepper: string,
  env: ScheduleInviteMailEnvironment = { MAIL_FROM: process.env.MAIL_FROM },
): string {
  if (!pepper) throw new Error("Pepper de fingerprint do request ausente");
  const canonicalRequest = JSON.stringify({
    from: resolveScheduleInviteMailFrom(env),
    to: [message.to],
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });
  return createHmac("sha256", pepper)
    .update(PROVIDER_REQUEST_FINGERPRINT_DOMAIN)
    .update(canonicalRequest)
    .digest("hex");
}
