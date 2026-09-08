import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isUnlinkedAccountRoute,
  managementDirection,
  operationalEntryDirection,
} from "../lib/onboarding-direction";
import { parseSignupProfessionalIdentity } from "../server/signup-professional-identity";

describe("direcionamento sem inferir autoridade", () => {
  const valid = {
    institutionId: 4,
    fetching: false,
    error: false,
    capabilities: { institutionId: 4, canCreateShift: true },
  };
  it("gestor canônico pode abrir criação", () =>
    expect(managementDirection(valid)).toBe("CREATE"));
  it.each([
    [{ ...valid, institutionId: null }, "ADMIN_REQUIRED"],
    [{ ...valid, fetching: true }, "LOADING"],
    [{ ...valid, error: true }, "UNAVAILABLE"],
    [{ ...valid, capabilities: undefined }, "UNAVAILABLE"],
    [
      { ...valid, capabilities: { institutionId: 5, canCreateShift: true } },
      "UNAVAILABLE",
    ],
    [
      { ...valid, capabilities: { institutionId: 4, canCreateShift: false } },
      "ADMIN_REQUIRED",
    ],
  ] as const)(
    "não concede criação em estado incompleto ou outro tenant",
    (input, expected) => expect(managementDirection(input)).toBe(expected),
  );

  it("conta vinculada segue para agenda; sem contexto segue para escolha; erro não é vazio", () => {
    expect(
      operationalEntryDirection({
        fetching: false,
        error: false,
        contextCount: 1,
      }),
    ).toBe("AGENDA");
    expect(
      operationalEntryDirection({
        fetching: false,
        error: false,
        contextCount: 0,
      }),
    ).toBe("ONBOARDING");
    expect(
      operationalEntryDirection({
        fetching: false,
        error: true,
        contextCount: 0,
      }),
    ).toBe("UNAVAILABLE");
    expect(operationalEntryDirection({ fetching: false, error: false })).toBe(
      "UNAVAILABLE",
    );
    expect(
      operationalEntryDirection({
        fetching: true,
        error: false,
        contextCount: 0,
      }),
    ).toBe("LOADING");
  });
  it("conta sem vínculo só acessa telas de conta ou convite após a atestação", () => {
    for (const path of [
      "/onboarding",
      "/account-profile",
      "/join-schedule",
      "/change-password",
    ])
      expect(isUnlinkedAccountRoute(path)).toBe(true);
    for (const path of [
      "/create-shift",
      "/admin",
      "/agenda",
      "/profile",
      "/onboarding/../create-shift",
    ])
      expect(isUnlinkedAccountRoute(path)).toBe(false);
    const layout = readFileSync("app/_layout.tsx", "utf8");
    expect(
      layout.indexOf("if (!attestation || !attestation.isCurrent())"),
    ).toBeLessThan(layout.indexOf("if (isUnlinkedAccountRoute(pathname))"));
    expect(layout).toContain(
      "<CreateShiftAccessBoundary>{children}</CreateShiftAccessBoundary>",
    );
  });
  it("mantém o contrato de signup da versão mobile anterior", () => {
    expect(
      parseSignupProfessionalIdentity({ specialty: "Anestesiologia" }),
    ).toMatchObject({ ok: true, identity: { professionCode: "MEDIC" } });
    expect(parseSignupProfessionalIdentity({ institutionId: 4 })).toMatchObject(
      { ok: true, identity: { professionCode: "MEDIC" } },
    );
    expect(parseSignupProfessionalIdentity({})).toMatchObject({ ok: false });
    expect(
      parseSignupProfessionalIdentity({
        professionCode: "MEDIC",
        institutionId: 4,
      }),
    ).toMatchObject({ ok: false });
  });
});
