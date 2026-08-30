import { expect } from "vitest";
import type { MailMessage } from "../../server/mailer";

const TEMP_PASSWORD_LINE = /^[A-HJ-NP-Za-km-z2-9]{12}$/;

export function extractTemporaryPasswordFromMail(
  calls: [MailMessage, ...unknown[]][],
  to: string,
): string {
  const message = calls.find(([msg]) => msg.to === to)?.[0];
  expect(message?.text).toBeTruthy();
  const line = message!.text!
    .split("\n")
    .map((part) => part.trim())
    .find((part) => TEMP_PASSWORD_LINE.test(part));
  expect(line).toMatch(TEMP_PASSWORD_LINE);
  return line!;
}
