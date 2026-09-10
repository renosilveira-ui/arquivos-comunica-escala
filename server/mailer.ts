// server/mailer.ts — envio de e-mail transacional.
//
// Sem dependência nova: quando RESEND_API_KEY existe, usa a API HTTP da
// Resend via fetch (remetente MAIL_FROM). Sem a chave (dev/staging), o
// mailer registra somente um evento de observabilidade redigido e retorna
// REJECTED — callers fail-closed (convite, recuperação). UNKNOWN diferencia
// resultado não conclusivo e permite retry idempotente no outbox durável. O log
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

export type MailResult =
  | {
      kind: "ACCEPTED";
      transport: "resend";
      providerCorrelationId?: string;
    }
  | {
      kind: "REJECTED";
      transport: "resend" | "console" | "none";
      reason:
        "NOT_CONFIGURED" | "INVALID_IDEMPOTENCY_KEY" | "HTTP_CLIENT_REJECTION";
    }
  | {
      kind: "UNKNOWN";
      transport: "resend";
      reason: "HTTP_TRANSIENT" | "TIMEOUT" | "NETWORK_ERROR";
    };

export interface MailSendOptions {
  /** 64 hex minúsculos: estável entre retries do mesmo evento. */
  idempotencyKey?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Escala+ <no-reply@escalas.app>";
/** Teto da chamada HTTP à Resend. Sem retry nesta frente. */
export const MAIL_HTTP_TIMEOUT_MS = 15_000;

const NO_PROVIDER_OBSERVABILITY = {
  eventType: "TRANSACTIONAL_EMAIL_NOT_SENT",
  channel: "EMAIL",
  providerConfigured: false,
  accepted: false,
} as const;

function logMailNotSentWithoutProvider(): void {
  // Não inclua destinatário, assunto, corpo, HTML, links, tokens ou senhas.
  // O objeto é intencionalmente constante para que o fallback nunca faça um
  // dado da mensagem atravessar a fronteira de observabilidade.
  console.log(`[mailer] ${JSON.stringify(NO_PROVIDER_OBSERVABILITY)}`);
}

function isTimeoutOrAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

function isValidIdempotencyKey(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Identificador opaco devolvido pelo provedor de e-mail.
 *
 * O contrato é compartilhado por todos os outboxes: somente ASCII seguro e o
 * mesmo teto das colunas VARCHAR(128). O valor não é normalizado; qualquer
 * caractere fora da allowlist torna todo o identificador não confiável.
 */
export function parseProviderCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(value) ? value : undefined;
}

async function sendViaResend(
  apiKey: string,
  from: string,
  msg: MailMessage,
  options: MailSendOptions,
): Promise<MailResult> {
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(isValidIdempotencyKey(options.idempotencyKey)
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
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
      if ([408, 425, 429].includes(res.status) || res.status >= 500) {
        return {
          kind: "UNKNOWN",
          transport: "resend",
          reason: "HTTP_TRANSIENT",
        };
      }
      return {
        kind: "REJECTED",
        transport: "resend",
        reason: "HTTP_CLIENT_REJECTION",
      };
    }
    let providerCorrelationId: string | undefined;
    try {
      const decoded = (await res.json()) as { id?: unknown };
      providerCorrelationId = parseProviderCorrelationId(decoded.id);
    } catch {
      // O status 2xx é a aceitação autoritativa; o corpo é opcional.
    }
    return {
      kind: "ACCEPTED",
      transport: "resend",
      ...(providerCorrelationId ? { providerCorrelationId } : {}),
    };
  } catch (err) {
    if (isTimeoutOrAbort(err)) {
      console.error("[mailer] Timeout ao chamar Resend");
      return { kind: "UNKNOWN", transport: "resend", reason: "TIMEOUT" };
    }
    console.error("[mailer] Falha ao chamar Resend");
    return { kind: "UNKNOWN", transport: "resend", reason: "NETWORK_ERROR" };
  }
}

export const mailer = {
  async sendMail(
    msg: MailMessage,
    options: MailSendOptions = {},
  ): Promise<MailResult> {
    if (
      options.idempotencyKey !== undefined &&
      !isValidIdempotencyKey(options.idempotencyKey)
    ) {
      return {
        kind: "REJECTED",
        transport: "none",
        reason: "INVALID_IDEMPOTENCY_KEY",
      };
    }
    const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
    if (apiKey) {
      const from = (process.env.MAIL_FROM ?? "").trim() || DEFAULT_FROM;
      return sendViaResend(apiKey, from, msg, options);
    }
    // Sem provedor configurado: preserva o comportamento fail-closed, mas nunca
    // torna conteúdo transacional sensível disponível em logs locais.
    logMailNotSentWithoutProvider();
    return { kind: "REJECTED", transport: "console", reason: "NOT_CONFIGURED" };
  },
};
