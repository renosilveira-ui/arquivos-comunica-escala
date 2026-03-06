import { describe, it, expect } from "vitest";
import {
  startShiftInHospitalAlert,
  endShiftInHospitalAlert,
  checkHospitalAlertStatus,
  syncUserWithHospitalAlert,
} from "../server/hospital-alert-integration";

describe("HospitalAlert Integration", () => {
  it("should start shift in HospitalAlert", async () => {
    const result = await startShiftInHospitalAlert({
      userId: 1,
      sectorId: 1,
      shiftId: 1,
      startTime: new Date(),
      endTime: new Date(Date.now() + 8 * 60 * 60 * 1000), // 8 horas
    });

    expect(result.success).toBe(true);
    expect(result.message).toBeDefined();
    expect(result.sessionToken).toBeDefined();
  });

  it("should end shift in HospitalAlert", async () => {
    const result = await endShiftInHospitalAlert(1, 1);

    expect(result.success).toBe(true);
    expect(result.message).toBeDefined();
  });

  it("should check HospitalAlert status", async () => {
    const result = await checkHospitalAlertStatus();

    expect(result.online).toBeDefined();
    expect(typeof result.online).toBe("boolean");
  });

  it("should sync user with HospitalAlert", async () => {
    const result = await syncUserWithHospitalAlert({
      id: 1,
      openId: "test-user",
      name: "Test User",
      email: "test@hospital.com",
      role: "nurse",
    });

    expect(result.success).toBe(true);
    expect(result.message).toBeDefined();
  });
});
