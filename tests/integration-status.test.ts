/**
 * Testes para integration.getStatus e integration.syncNow
 */

import { describe, it, expect } from "vitest";
import { getIntegrationStatus, forceSyncWithHospitalAlert } from "../server/hospital-alert-integration";

describe("integration.getStatus", () => {
  it("deve retornar estrutura válida com usuário conectado", async () => {
    const result = await getIntegrationStatus("shiftsapp:123", "hsc");

    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("organizationId");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("connection");
    expect(result).toHaveProperty("shift");
    expect(result).toHaveProperty("serverTime");
    expect(result).toHaveProperty("version");

    expect(result.ok).toBe(true);
    expect(result.organizationId).toBe("hsc");
  });

  it("deve retornar user.exists = true quando usuário existe", async () => {
    const result = await getIntegrationStatus("shiftsapp:123", "hsc");

    expect(result.user.exists).toBe(true);
    expect(result.user).toHaveProperty("userId");
    expect(result.user).toHaveProperty("externalUserId");
    expect(result.user).toHaveProperty("name");
    expect(result.user).toHaveProperty("email");
    expect(result.user).toHaveProperty("role");
  });

  it("deve retornar connection.connected = true quando integração está saudável", async () => {
    const result = await getIntegrationStatus("shiftsapp:123", "hsc");

    expect(result.connection.connected).toBe(true);
    expect(result.connection.lastSyncStatus).toBe("success");
    expect(result.connection.lastSyncAt).toBeTruthy();
    expect(result.connection.lastError).toBeNull();
  });

  it("deve retornar shift.active = true quando plantão está ativo", async () => {
    const result = await getIntegrationStatus("shiftsapp:123", "hsc");

    expect(result.shift.active).toBe(true);
    expect(result.shift).toHaveProperty("shiftId");
    expect(result.shift).toHaveProperty("startedAt");
    expect(result.shift).toHaveProperty("service");
    expect(result.shift).toHaveProperty("sector");
    expect(result.shift).toHaveProperty("coverageType");
    expect(result.shift).toHaveProperty("staffingStatus");
    expect(result.shift).toHaveProperty("sourceApp");
  });

  it("deve incluir service e sector no shift ativo", async () => {
    const result = await getIntegrationStatus("shiftsapp:123", "hsc");

    if (result.shift.active && result.shift.service && result.shift.sector) {
      expect(result.shift.service).toHaveProperty("id");
      expect(result.shift.service).toHaveProperty("name");
      expect(result.shift.sector).toHaveProperty("id");
      expect(result.shift.sector).toHaveProperty("name");
    }
  });

  it("deve retornar serverTime em formato ISO 8601", async () => {
    const result = await getIntegrationStatus("shiftsapp:123", "hsc");

    expect(result.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    
    // Validar que é uma data válida
    const date = new Date(result.serverTime);
    expect(date.toString()).not.toBe("Invalid Date");
  });
});

describe("integration.syncNow", () => {
  it("deve retornar success = true ao forçar sincronização", async () => {
    const result = await forceSyncWithHospitalAlert(123, "shiftsapp:123");

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("lastSyncAt");

    expect(result.success).toBe(true);
    expect(result.message).toBeTruthy();
  });

  it("deve retornar lastSyncAt em formato ISO 8601", async () => {
    const result = await forceSyncWithHospitalAlert(123, "shiftsapp:123");

    expect(result.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    
    // Validar que é uma data válida
    const date = new Date(result.lastSyncAt);
    expect(date.toString()).not.toBe("Invalid Date");
  });
});
