import { resolveTrustedPublicBaseUrl } from "./_core/public-url";
import type { MailMessage } from "./mailer";

export function buildScheduleInviteMail(input: {
  to: string;
  hospitalName: string;
  sectorName: string;
  code: string;
  expiresAt: Date;
}): MailMessage | null {
  const publicBaseUrl = resolveTrustedPublicBaseUrl();
  if (!publicBaseUrl) return null;
  const inviteUrl = `${publicBaseUrl}/join-schedule?invite=${encodeURIComponent(input.code)}`;
  const validUntil = input.expiresAt.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });
  const text = [
    "Comunica Escalas",
    "",
    `Você foi convidado(a) para a escala ${input.hospitalName} — ${input.sectorName}.`,
    "O convite vale por 24 horas e só pode ser usado por você, uma vez.",
    "",
    "Entre no Escala+ com o e-mail desta mensagem e abra o link:",
    inviteUrl,
    "",
    `Ou, já logado, cole o convite: ${input.code}`,
    `Válido até ${validUntil}.`,
    "",
    "Se você não esperava este e-mail, ignore.",
  ].join("\n");
  return {
    to: input.to,
    subject: `Convite para a escala ${input.hospitalName} — ${input.sectorName}`,
    text,
  };
}
