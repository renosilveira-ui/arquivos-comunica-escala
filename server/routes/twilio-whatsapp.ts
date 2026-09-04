import { Router, type Request, type Response } from "express";
import {
  readTwilioAuthToken,
  resolveTwilioWhatsAppCanonicalUrl,
} from "../integrations/whatsapp/canonical-url";
import { formParamsFromBody } from "../integrations/whatsapp/inbound-form-params";
import { processWhatsAppInbound } from "../integrations/whatsapp/inbound-store";
import { twilioWhatsAppProvider } from "../integrations/whatsapp/twilio-provider";
import { logger } from "../_core/logger";

export const twilioWhatsAppRouter = Router();

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

  const params = formParamsFromBody(req.body);
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
    const result = await processWhatsAppInbound(parsed.envelope);
    if (result.outcome === "retryable") {
      empty(res, 503);
      return;
    }
    empty(res, 200);
  } catch {
    logger.warn(JSON.stringify({ event: "whatsapp_inbound_handler_error" }));
    empty(res, 503);
  }
});
