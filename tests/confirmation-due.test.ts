import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_DEFAULT_LEAD_MS,
  CONFIRMATION_MAX_LEAD_MS,
  CONFIRMATION_MORNING_LEAD_MS,
  confirmationDiscoveryStartAtRange,
  confirmationDueAt,
  confirmationLeadMs,
  isDueForConfirmation,
} from "../server/cron/confirmation-due";

const TZ = "America/Sao_Paulo";

describe("confirmation due-based lead", () => {
  it("preserva 9h para Manhã 07:00±30 e 2h para Tarde/Noite e off-grid", () => {
    expect(confirmationLeadMs(new Date("2036-04-10T07:00:00-03:00"), TZ)).toBe(
      CONFIRMATION_MORNING_LEAD_MS,
    );
    expect(confirmationLeadMs(new Date("2036-04-10T07:30:00-03:00"), TZ)).toBe(
      CONFIRMATION_MORNING_LEAD_MS,
    );
    expect(confirmationLeadMs(new Date("2036-04-10T06:30:00-03:00"), TZ)).toBe(
      CONFIRMATION_MORNING_LEAD_MS,
    );
    expect(confirmationLeadMs(new Date("2036-04-10T13:00:00-03:00"), TZ)).toBe(
      CONFIRMATION_DEFAULT_LEAD_MS,
    );
    expect(confirmationLeadMs(new Date("2036-04-10T19:00:00-03:00"), TZ)).toBe(
      CONFIRMATION_DEFAULT_LEAD_MS,
    );
    expect(confirmationLeadMs(new Date("2036-04-10T08:00:00-03:00"), TZ)).toBe(
      CONFIRMATION_DEFAULT_LEAD_MS,
    );
    expect(confirmationLeadMs(new Date("2036-04-10T12:00:00-03:00"), TZ)).toBe(
      CONFIRMATION_DEFAULT_LEAD_MS,
    );
    expect(confirmationLeadMs(new Date("2036-04-10T06:29:00-03:00"), TZ)).toBe(
      CONFIRMATION_DEFAULT_LEAD_MS,
    );
    expect(confirmationLeadMs(new Date("2036-04-10T07:31:00-03:00"), TZ)).toBe(
      CONFIRMATION_DEFAULT_LEAD_MS,
    );
  });

  it("dueAt histórico: 13:00→11:00, 19:00→17:00, 07:00→22:00 anterior", () => {
    expect(
      confirmationDueAt(new Date("2036-04-10T13:00:00-03:00"), TZ).toISOString(),
    ).toBe(new Date("2036-04-10T11:00:00-03:00").toISOString());
    expect(
      confirmationDueAt(new Date("2036-04-10T19:00:00-03:00"), TZ).toISOString(),
    ).toBe(new Date("2036-04-10T17:00:00-03:00").toISOString());
    expect(
      confirmationDueAt(new Date("2036-04-10T07:00:00-03:00"), TZ).toISOString(),
    ).toBe(new Date("2036-04-09T22:00:00-03:00").toISOString());
    expect(
      confirmationDueAt(new Date("2036-04-10T08:00:00-03:00"), TZ).toISOString(),
    ).toBe(new Date("2036-04-10T06:00:00-03:00").toISOString());
  });

  it("isDue exige start futuro e due já vencido; não cria após o início", () => {
    const start = new Date("2036-04-10T13:00:00-03:00");
    expect(isDueForConfirmation(start, new Date("2036-04-10T10:59:00-03:00"), TZ)).toBe(
      false,
    );
    expect(isDueForConfirmation(start, new Date("2036-04-10T11:00:00-03:00"), TZ)).toBe(
      true,
    );
    expect(isDueForConfirmation(start, new Date("2036-04-10T12:30:00-03:00"), TZ)).toBe(
      true,
    );
    expect(isDueForConfirmation(start, start, TZ)).toBe(false);
    expect(isDueForConfirmation(start, new Date("2036-04-10T13:01:00-03:00"), TZ)).toBe(
      false,
    );
  });

  it("janela SQL é (now, now+9h] — bounded pelo maior lead", () => {
    const now = new Date("2036-04-10T12:00:00-03:00");
    const range = confirmationDiscoveryStartAtRange(now);
    expect(range.after.toISOString()).toBe(now.toISOString());
    expect(range.until.getTime() - range.after.getTime()).toBe(
      CONFIRMATION_MAX_LEAD_MS,
    );
    expect(CONFIRMATION_MAX_LEAD_MS).toBe(
      Math.max(CONFIRMATION_MORNING_LEAD_MS, CONFIRMATION_DEFAULT_LEAD_MS),
    );
  });

  it("dispatcher compõe due-based com ACL canônico; INSERT do titular não relaxa access", () => {
    const dispatcher = readFileSync(
      "server/cron/shift-confirmation-dispatcher.ts",
      "utf8",
    );
    const start = dispatcher.indexOf("export async function dispatchConfirmations");
    const end = dispatcher.indexOf("export async function processRechecks");
    const discovery = dispatcher.slice(start, end);
    expect(discovery).toContain("isDueForConfirmation");
    expect(discovery).toContain("plantonistaAccessCoversShiftSql");
    expect(discovery).not.toContain("requireOriginalAccess: false");
    expect(dispatcher).toContain("requireOriginalAccess: false");
    expect(dispatcher).not.toMatch(/notifyHour:\s*11/);
    expect(dispatcher).not.toContain("TRIGGER_WINDOW_MIN");
    expect(dispatcher).not.toContain("qualificationMatches");
  });
});
