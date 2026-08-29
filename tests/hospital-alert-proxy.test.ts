import { describe, expect, it } from "vitest";
import {
  ownedExternalUserId,
  withServerIntegrationIdentity,
} from "../server/routes/hospital-alert";

describe("hospital-alert proxy — identidade server-side", () => {
  it("ownedExternalUserId usa o id autenticado do Escala+", () => {
    expect(ownedExternalUserId(42)).toBe("shiftsapp:42");
  });

  it("withServerIntegrationIdentity sobrescreve externalUserId e organizationId do cliente", () => {
    const bound = withServerIntegrationIdentity(
      {
        externalUserId: "shiftsapp:999",
        organizationId: "org-forjada",
        name: "Dr. Teste",
        email: "teste@hospital.com",
      },
      7,
      "hsc",
    );

    expect(bound.externalUserId).toBe("shiftsapp:7");
    expect(bound.organizationId).toBe("hsc");
    expect(bound.name).toBe("Dr. Teste");
    expect(bound.email).toBe("teste@hospital.com");
  });
});
