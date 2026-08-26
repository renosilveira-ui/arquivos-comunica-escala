import { afterEach, describe, expect, it, vi } from "vitest";

const VALID_ORG = "595991e8-f690-4897-84a4-44e54c306c25";

describe("SSO organization mapping", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("aceita somente institution id inteiro positivo e organization UUID canonico", async () => {
    vi.stubEnv("SSO_ORG_MAP", JSON.stringify({
      "0": VALID_ORG,
      "-1": VALID_ORG,
      "1.5": VALID_ORG,
      "2": VALID_ORG.toUpperCase(),
      "02": "11111111-1111-4111-8111-111111111111",
      "3": "nao-e-uuid",
      "4": "javascript:alert(1)",
    }));
    const mapping = await import("../server/sso/org-mapping");

    expect(mapping.getComunicaOrgId(0)).toBeNull();
    expect(mapping.getComunicaOrgId(-1)).toBeNull();
    expect(mapping.getComunicaOrgId(1.5)).toBeNull();
    expect(mapping.getComunicaOrgId(2)).toBe(VALID_ORG);
    expect(mapping.getComunicaOrgId(3)).toBeNull();
    expect(mapping.getComunicaOrgId(4)).toBeNull();
    expect(mapping.hasMappingFor(Number.NaN)).toBe(false);
  });

  it("renova o cache quando a configuracao muda e falha fechado em JSON malformado", async () => {
    vi.stubEnv("SSO_ORG_MAP", JSON.stringify({ "7": VALID_ORG }));
    const mapping = await import("../server/sso/org-mapping");
    expect(mapping.getComunicaOrgId(7)).toBe(VALID_ORG);

    vi.stubEnv("SSO_ORG_MAP", JSON.stringify({ "8": VALID_ORG }));
    expect(mapping.getComunicaOrgId(7)).toBeNull();
    expect(mapping.getComunicaOrgId(8)).toBe(VALID_ORG);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("SSO_ORG_MAP", "{malformado");
    expect(mapping.getComunicaOrgId(8)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("falha fechado quando dois tenants apontam para a mesma organização Comunica+", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("SSO_ORG_MAP", JSON.stringify({
      "11": VALID_ORG,
      "12": VALID_ORG.toUpperCase(),
    }));
    const mapping = await import("../server/sso/org-mapping");

    expect(mapping.getComunicaOrgId(11)).toBeNull();
    expect(mapping.getComunicaOrgId(12)).toBeNull();
    expect(mapping.hasMappingFor(11)).toBe(false);
    expect(error).toHaveBeenCalledWith("[SSO] SSO_ORG_MAP_INVALID");
    expect(JSON.stringify(error.mock.calls)).not.toContain(VALID_ORG);
  });
});
