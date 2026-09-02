import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("revisão visual da prontidão corporativa", () => {
  it("consulta e confirma a fotografia de todos os setores do hospital", () => {
    const ui = readFileSync(
      "components/agenda/ManagerActionsMenu.tsx",
      "utf8",
    );

    expect(ui).toContain("trpc.corporateReadiness.get.useQuery(");
    expect(ui).toContain(
      "{ hospitalId: resolvedHospitalId ?? 0, yearMonth: monthKey }",
    );
    expect(ui).toContain(
      "A publicação considera todos os setores deste hospital",
    );
    expect(ui).toContain(
      "Canal de e-mail confiável ainda não habilitado",
    );
    expect(ui).toContain(
      "snapshotHash: corporateReadiness.data.snapshotHash",
    );
    expect(ui).toContain(
      "issueCodes: [...corporateReadiness.data.acknowledgement.issueCodes]",
    );
    expect(ui).toContain("readinessAcknowledgement:");
  });
});
