import { describe, expect, it } from "vitest";
import twilio from "twilio";
import {
  formParamsFromBody,
  isTwilioInboundFormKey,
} from "../server/integrations/whatsapp/inbound-form-params";
import { TwilioWhatsAppProvider } from "../server/integrations/whatsapp/twilio-provider";
import { WHATSAPP_INBOUND_PATH } from "../server/integrations/whatsapp/types";

const AUTH = "test_twilio_auth_token_not_real";
const PUBLIC =
  "https://escalas-staging.onrender.com" + WHATSAPP_INBOUND_PATH;
const provider = new TwilioWhatsAppProvider();

describe("WhatsApp inbound form params — chaves Twilio vs injection", () => {
  it("aceita chaves alfanuméricas Twilio e serializa número/boolean", () => {
    const params = formParamsFromBody({
      MessageSid: "SMform1",
      From: "whatsapp:+5585999999999",
      NumMedia: 1,
      MediaUrl0: "https://api.twilio.com/media/a",
      MediaContentType0: "audio/ogg",
      Forwarded: true,
    });
    expect(params.MessageSid).toBe("SMform1");
    expect(params.NumMedia).toBe("1");
    expect(params.Forwarded).toBe("true");
    expect(params.MediaUrl0).toBe("https://api.twilio.com/media/a");
    expect(Object.getPrototypeOf(params)).toBeNull();
  });

  it("recusa __proto__, constructor, prototype e chaves com pontuação", () => {
    expect(isTwilioInboundFormKey("__proto__")).toBe(false);
    expect(isTwilioInboundFormKey("constructor")).toBe(false);
    expect(isTwilioInboundFormKey("prototype")).toBe(false);
    expect(isTwilioInboundFormKey("nested.key")).toBe(false);
    expect(isTwilioInboundFormKey("Media-Url-0")).toBe(false);
    expect(isTwilioInboundFormKey("MessageSid")).toBe(true);
    expect(isTwilioInboundFormKey("MediaUrl0")).toBe(true);

    const polluted = formParamsFromBody({
      MessageSid: "SMsafe",
      __proto__: { polluted: true },
      constructor: "bad",
      prototype: "bad",
      "foo.bar": "x",
    });
    expect(polluted.MessageSid).toBe("SMsafe");
    expect(Object.prototype.hasOwnProperty.call(polluted, "constructor")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(polluted, "prototype")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(polluted, "__proto__")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(polluted, "foo.bar")).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    ).toBe(false);
  });

  it("assinatura Twilio usa só o conjunto filtrado", () => {
    const signedFields = {
      MessageSid: "SMsig1",
      From: "whatsapp:+5585999999999",
      Body: "oi",
    };
    const signature = twilio.getExpectedTwilioSignature(
      AUTH,
      PUBLIC,
      signedFields,
    );
    const filtered = formParamsFromBody({
      ...signedFields,
      __proto__: "x",
      constructor: "y",
    });
    expect(
      provider.validateInboundRequest({
        signature,
        authToken: AUTH,
        canonicalUrl: PUBLIC,
        params: filtered,
      }),
    ).toBe(true);
  });
});
