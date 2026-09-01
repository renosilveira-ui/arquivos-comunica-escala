// server/mailer.ts — envio de e-mail transacional.
//
// Sem dependência nova: quando RESEND_API_KEY existe, usa a API HTTP da
// Resend via fetch (remetente MAIL_FROM). Sem a chave (dev/staging), o
// mailer registra somente um evento de observabilidade redigido e retorna
// delivered=false — callers fail-closed (convite, forgot-password). O log
// local não prova entrega nem contém dados da mensagem.
//
// `mailer.sendMail` é chamado via o objeto (e não como função solta) de
// propósito: permite `vi.spyOn(mailer, "sendMail")` nos testes para
// observar o contrato de entrega sem bater na rede.

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
/** Teto da chamada HTTP à Resend. Sem retry nesta frente. */
export const MAIL_HTTP_TIMEOUT_MS = 15_000;

const NO_PROVIDER_OBSERVABILITY = {
  eventType: "TRANSACTIONAL_EMAIL_NOT_SENT",
  channel: "EMAIL",
  providerConfigured: false,
  delivered: false,
} as const;

function logMailNotSentWithoutProvider(): void {
  // Não inclua destinatário, assunto, corpo, HTML, links, tokens ou senhas.
  // O objeto é intencionalmente constante para que o fallback nunca faça um
  // dado da mensagem atravessar a fronteira de observabilidade.
  console.log(`[mailer] ${JSON.stringify(NO_PROVIDER_OBSERVABILITY)}`);
}

function isTimeoutOrAbort(err: unknown): boolean {
  return err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError");
}

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
      signal: AbortSignal.timeout(MAIL_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Não ecoa o corpo da Resend: pode espelhar destinatário/assunto.
      console.error(`[mailer] Resend respondeu ${res.status}`);
      return { delivered: false, transport: "resend", error: `HTTP ${res.status}` };
    }
    return { delivered: true, transport: "resend" };
  } catch (err) {
    if (isTimeoutOrAbort(err)) {
      console.error("[mailer] Timeout ao chamar Resend");
      return { delivered: false, transport: "resend", error: "TIMEOUT" };
    }
    console.error("[mailer] Falha ao chamar Resend");
    return { delivered: false, transport: "resend", error: "NETWORK_ERROR" };
  }
}

export const mailer = {
  async sendMail(msg: MailMessage): Promise<MailResult> {
    const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
    if (apiKey) {
      const from = (process.env.MAIL_FROM ?? "").trim() || DEFAULT_FROM;
      return sendViaResend(apiKey, from, msg);
    }
    // Sem provedor configurado: preserva o fallback fail-closed, mas nunca
    // torna conteúdo transacional sensível disponível em logs locais.
    logMailNotSentWithoutProvider();
    return { delivered: false, transport: "console" };
  },
};
