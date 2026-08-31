import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSectorServiceSpecialties } from "../server/sector-service-specialties";

const mocks = vi.hoisted(() => ({
  assertInstitutionHierarchy: vi.fn(),
}));

vi.mock("../server/_core/tenant", () => ({
  assertInstitutionHierarchy: mocks.assertInstitutionHierarchy,
}));

describe("escrita de especialidades assistenciais", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("valida a topologia antes de consultar catálogo ou gravar a relação", async () => {
    const topologyError = new Error("setor fora da topologia institucional");
    mocks.assertInstitutionHierarchy.mockRejectedValue(topologyError);
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
    };

    await expect(
      replaceSectorServiceSpecialties(db as any, {
        institutionId: 1,
        hospitalId: 10,
        sectorId: 20,
        medicalSpecialtyCodes: ["ANESTESIOLOGIA"],
      }),
    ).rejects.toBe(topologyError);

    expect(mocks.assertInstitutionHierarchy).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: 1,
        hospitalId: 10,
        sectorId: 20,
      }),
      { db, lockForShare: true },
    );
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });
});
