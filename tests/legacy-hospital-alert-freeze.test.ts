import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endShift,
  getIntegrationStatus,
  startShift,
  syncUser,
} from "../lib/hospitalAlertClient";
import {
  LEGACY_HOSPITAL_ALERT_BLOCKED_CODE,
  LEGACY_HOSPITAL_ALERT_BLOCKED_HTTP_STATUS,
} from "../lib/hospitalAlertConfig";

const apiFetchMock = vi.fn();

vi.mock("../lib/_core/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const basePayload = {
  externalUserId: "shiftsapp:42",
  organizationId: "hsc",
};

describe("legacy Hospital Alert freeze (ADR-001)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["syncUser", () => syncUser({ ...basePayload, name: "Test", email: "a@b.com" })],
    [
      "startShift",
      () =>
        startShift({
          ...basePayload,
          serviceId: 1,
          coverageType: "GLOBAL",
          sourceApp: "SHIFTS_APP",
        }),
    ],
    ["endShift", () => endShift({ ...basePayload, sourceApp: "SHIFTS_APP" })],
    ["getIntegrationStatus", () => getIntegrationStatus(basePayload.externalUserId)],
  ])("bloqueia %s sem rede", async (_label, call) => {
    const result = await call();

    expect(result).toEqual({
      ok: false,
      error: LEGACY_HOSPITAL_ALERT_BLOCKED_CODE,
      httpStatus: LEGACY_HOSPITAL_ALERT_BLOCKED_HTTP_STATUS,
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
