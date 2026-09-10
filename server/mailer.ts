// server/mailer.ts — envio de e-mail transacional.
//
// Sem dependência nova: quando RESEND_API_KEY existe, usa a API HTTP da
// Resend via fetch (remetente MAIL_FROM). Sem a chave (dev/staging), o
// mailer registra somente um evento de observabilidade redigido e retorna
// resultado tipado — callers distinguem rejeição definitiva de incerteza. O log
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
      /** Identificador opaco do provedor; nunca contém destinatário/payload. */
      providerCorrelationId?: string;
    }
  | {
      kind: "REJECTED";
      transport: "resend" | "console";
      reason: "NOT_CONFIGURED" | "HTTP_CLIENT_REJECTION";
    }
  | {
      kind: "UNKNOWN";
      transport: "resend";
      reason: "HTTP_TRANSIENT" | "TIMEOUT" | "NETWORK_ERROR";
    };

export type MailSendOptions = {
  /** Chave opaca e durável; permite ao provedor deduplicar retries. */
  idempotencyKey?: string;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Escala+ <no-reply@escalas.app>";
/** Teto da chamada HTTP à Resend. Sem retry nesta frente. */
export const MAIL_HTTP_TIMEOUT_MS = 15_000;

const NO_PROVIDER_OBSERVABILITY = {
  eventType: "TRANSACTIONAL_EMAIL_NOT_SENT",
  channel: "EMAIL",
  providerConfigured: false,
  outcome: "REJECTED",
  reason: "NOT_CONFIGURED",
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

function readOpaqueProviderCorrelationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("id" in payload)) {
    return undefined;
  }
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)
    ? id
    : undefined;
}

async function sendViaResend(
  apiKey: string,
  from: string,
  msg: MailMessage,
  options: MailSendOptions,
): Promise<MailResult> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (options.idempotencyKey) {
      if (!/^[a-f0-9]{64}$/.test(options.idempotencyKey)) {
        throw new Error("INVALID_MAIL_IDEMPOTENCY_KEY");
      }
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers,
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
      if (
        res.status === 408 ||
        res.status === 425 ||
        res.status === 429 ||
        res.status >= 500
      ) {
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
    // HTTP 2xx da Resend é aceite/enfileiramento, não entrega final.
    const providerCorrelationId = readOpaqueProviderCorrelationId(
      await res.json().catch(() => null),
    );
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
    return {
      kind: "UNKNOWN",
      transport: "resend",
      reason: "NETWORK_ERROR",
    };
  }
}

export const mailer = {
  async sendMail(
    msg: MailMessage,
    options: MailSendOptions = {},
  ): Promise<MailResult> {
    const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
    if (apiKey) {
      const from = (process.env.MAIL_FROM ?? "").trim() || DEFAULT_FROM;
      return sendViaResend(apiKey, from, msg, options);
    }
    // Sem provedor configurado: preserva o fallback fail-closed, mas nunca
    // torna conteúdo transacional sensível disponível em logs locais.
    logMailNotSentWithoutProvider();
    return {
      kind: "REJECTED",
      transport: "console",
      reason: "NOT_CONFIGURED",
    };
  },
};
