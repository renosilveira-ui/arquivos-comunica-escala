import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createSectorScaleButtonTitle,
  createSectorScaleEmptyDescription,
  createSectorScaleEmptyTitle,
  createSectorScaleNoHospitalTitle,
  createSectorScaleNoJurisdictionDescription,
  createSectorScaleNoJurisdictionTitle,
  createSectorScaleToast,
} from "@/lib/create-sector-scale";

describe("criar escala do setor — copy", () => {
  it("usa sentence case em português sem jargão de tenant", () => {
    expect(createSectorScaleButtonTitle()).toBe("Criar escala do setor");
    expect(createSectorScaleEmptyTitle()).toBe(
      "Ainda não há escala neste hospital",
    );
    expect(createSectorScaleEmptyDescription()).toMatch(/mesmo caminho/);
    expect(createSectorScaleToast("Centro Cirúrgico")).toBe(
      "Escala de Centro Cirúrgico pronta. Agora você pode abrir os turnos do mês.",
    );
    expect(createSectorScaleNoHospitalTitle()).toBe(
      "Nenhum hospital neste vínculo",
    );
    expect(createSectorScaleNoJurisdictionTitle()).toBe(
      "Sem permissão para gerir a escala deste hospital",
    );
    expect(createSectorScaleNoJurisdictionDescription()).toMatch(
      /peça o escopo ao administrador/i,
    );
  });
});

describe("criar escala do setor — wiring", () => {
  it("Agenda mostra o fluxo quando não há contexto, não só o pedido ao gestor", () => {
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const button = readFileSync(
      "components/agenda/CreateSectorScaleButton.tsx",
      "utf8",
    );
    const provision = readFileSync(
      "scripts/provision-institution-scale.ts",
      "utf8",
    );

    expect(agenda).toContain("CreateSectorScaleButton");
    expect(agenda).toContain("EmptyInstitutionScaleState");
    expect(agenda).toContain("createSectorScaleEmptyTitle");
    expect(agenda).toContain("createSectorScaleNoJurisdictionTitle");
    expect(agenda).toContain("institutionHasHospitals");
    expect(button).toContain("topology.data?.hospitals");
    expect(agenda).toContain("topology.data?.hospitals");
    expect(agenda).toContain("QueryErrorState");
    expect(agenda).toContain(
      'scope === "geral" && scheduleContext.contexts.length > 0',
    );
    expect(button).toContain("ensureDefaultSectorScale");
    expect(button).toContain("listManageableTopology");
    expect(button).toContain("useActionFeedback");
    expect(button).not.toContain("Alert.alert");
    expect(button).toContain("theme.colors");
    expect(button).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    expect(provision).toContain("--institution-id");
    expect(provision).toContain("--hospital-id");
    expect(provision).toContain("ensureDefaultSectorScale");
    expect(provision).not.toContain("HSC_PROVISION_CONFIRM");
    expect(provision).not.toContain("SAO_CARLOS");
    expect(provision).not.toContain("UNIMED_");
  });
});
