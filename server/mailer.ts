// server/mailer.ts — envio de e-mail transacional.
//
// Sem dependência nova: quando RESEND_API_KEY existe, usa a API HTTP da
// Resend via fetch (remetente MAIL_FROM). Sem a chave (dev/staging), o
// conteúdo é logado no console — o link de redefinição aparece no log
// do servidor, suficiente para testar o fluxo ponta a ponta.
//
// `mailer.sendMail` é chamado via o objeto (e não como função solta) de
// propósito: permite `vi.spyOn(mailer, "sendMail")` nos testes para
// capturar o link sem bater na rede.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailResult {
  delivered: boolean;
  transport: "resend" | "console";
  error?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Escala+ <no-reply@escalas.app>";

async function sendViaResend(apiKey: string, from: string, msg: MailMessage): Promise<MailResult> {
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mailer] Resend respondeu ${res.status}: ${body.slice(0, 300)}`);
      return { delivered: false, transport: "resend", error: `HTTP ${res.status}` };
    }
    return { delivered: true, transport: "resend" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mailer] Falha ao chamar Resend:", message);
    return { delivered: false, transport: "resend", error: message };
  }
}

export const mailer = {
  async sendMail(msg: MailMessage): Promise<MailResult> {
    const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
    if (apiKey) {
      const from = (process.env.MAIL_FROM ?? "").trim() || DEFAULT_FROM;
      return sendViaResend(apiKey, from, msg);
    }
    // Sem provedor configurado: log no console (dev/staging sem chave).
    // Conteúdo vindo do usuário (e-mail, assunto, corpo) vai serializado
    // em JSON: quebras de linha viram "\n" escapado, então ninguém forja
    // linhas de log (CodeQL js/log-injection) e o link continua legível.
    console.log(
      "[mailer] (sem RESEND_API_KEY — e-mail NÃO enviado) " +
        JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text }, null, 2),
    );
    return { delivered: false, transport: "console" };
  },
};
