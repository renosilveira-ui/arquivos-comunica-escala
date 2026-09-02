import { describe, expect, it } from "vitest";
import { parseAccountWideNotificationBadgeCount } from "../server/account-wide-notification-badge";

describe("parser de contagem do badge account-wide", () => {
  it("aceita somente inteiros seguros e strings decimais canônicas do MySQL", () => {
    expect(parseAccountWideNotificationBadgeCount(0)).toBe(0);
    expect(parseAccountWideNotificationBadgeCount(7)).toBe(7);
    expect(parseAccountWideNotificationBadgeCount("0")).toBe(0);
    expect(parseAccountWideNotificationBadgeCount("7")).toBe(7);
  });

  it("falha fechado em coerções que poderiam virar zero", () => {
    for (const value of [
      null,
      false,
      "",
      " ",
      "07",
      "7e0",
      -1,
      1.2,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => parseAccountWideNotificationBadgeCount(value)).toThrow(
        "Contagem de notificações inválida",
      );
    }
  });
});
