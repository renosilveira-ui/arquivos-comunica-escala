import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("cartão de plantão com múltiplos profissionais", () => {
  it("renderiza cada nome em uma linha sem concatenar a equipe", () => {
    const source = readFileSync("components/agenda/ShiftRowCard.tsx", "utf8");
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const panorama = readFileSync(
      "components/agenda/PanoramicAgenda.tsx",
      "utf8",
    );

    expect(source).toContain("names.map((name, index)");
    expect(source).toContain("{name}");
    expect(panorama).toContain("names.map((name, index)");
    expect(source).not.toContain('shift.professionalNames.join(", ")');
    expect(agenda).not.toContain('shift.professionalNames.join(", ")');
    expect(panorama).not.toContain("shift.professionalNames[0]");
  });
});
