import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("cartão de plantão com múltiplos profissionais", () => {
  it("renderiza cada nome em uma linha sem concatenar a equipe", () => {
    const card = readFileSync("components/agenda/ShiftRowCard.tsx", "utf8");
    const panorama = readFileSync(
      "components/agenda/PanoramicAgenda.tsx",
      "utf8",
    );
    const desktopAgenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");

    for (const source of [card, panorama, desktopAgenda]) {
      expect(source).toContain("names.map((name, index)");
      expect(source).toContain("{name}");
    }
    expect(card).not.toContain('shift.professionalNames.join(", ")');
    expect(panorama).not.toContain("shift.professionalNames[0]");
    expect(desktopAgenda).not.toContain(
      'shift.professionalNames.join(", ")',
    );
    expect(desktopAgenda).toContain(
      'shiftProfessionalNameLines(shift, "VAGO")',
    );
    expect(card).toContain("minHeight: 58");
    expect(card).not.toMatch(/\n\s*height:\s*58/);
  });
});
