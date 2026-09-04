import { Router, type Request, type Response } from "express";
import {
  readTwilioAuthToken,
  resolveTwilioWhatsAppCanonicalUrl,
} from "../integrations/whatsapp/canonical-url";
import { processWhatsAppInbound } from "../integrations/whatsapp/inbound-store";
import { twilioWhatsAppProvider } from "../integrations/whatsapp/twilio-provider";
import type { WhatsAppInboundParams } from "../integrations/whatsapp/provider";
import { logger } from "../_core/logger";

export const twilioWhatsAppRouter = Router();

function formParams(body: unknown): WhatsAppInboundParams {
  if (!body || typeof body !== "object") return {};
  const params: WhatsAppInboundParams = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") {
      params[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      // qs/urlencoded pode coercer NumMedia etc.; a assinatura Twilio usa string.
      params[key] = String(value);
    }
  }
  return params;
}

function readSignature(req: Request): string | undefined {
  const raw = req.headers["x-twilio-signature"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

function empty(res: Response, status: number): void {
  res.status(status).end();
}

twilioWhatsAppRouter.post("/", async (req: Request, res: Response) => {
  const authToken = readTwilioAuthToken();
  if (!authToken) {
    empty(res, 503);
    return;
  }

  const canonical = resolveTwilioWhatsAppCanonicalUrl();
  if (!canonical.ok) {
    empty(res, 503);
    return;
  }

  const signature = readSignature(req);
  if (!signature?.trim()) {
    empty(res, 403);
    return;
  }

  const params = formParams(req.body);
  const signed = twilioWhatsAppProvider.validateInboundRequest({
    signature,
    authToken,
    canonicalUrl: canonical.url,
    params,
  });
  if (!signed) {
    empty(res, 403);
    return;
  }

  const parsed = twilioWhatsAppProvider.parseInboundEnvelope(params);
  if (!parsed.ok) {
    if (parsed.code === "TWILIO_MESSAGE_SID_MISSING") {
      empty(res, 400);
      return;
    }
    empty(res, 400);
    return;
  }

  try {
    await processWhatsAppInbound(parsed.envelope);
    empty(res, 200);
  } catch {
    logger.warn(JSON.stringify({ event: "whatsapp_inbound_handler_error" }));
    empty(res, 503);
  }
});
