import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("barra inferior do plantonista", () => {
  it("no celular só Agenda, Trocas, Vagas e Perfil — voz sobreposta, sem quinto slot", () => {
    const tabs = readFileSync("app/(tabs)/_layout.tsx", "utf8");
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const bar = readFileSync("components/ui/MobileTabBar.tsx", "utf8");
    const trigger = readFileSync("components/ui/VoiceTabTrigger.tsx", "utf8");
    const button = readFileSync("components/VoiceCommandButton.tsx", "utf8");
    const hook = readFileSync("hooks/use-schedule-context.ts", "utf8");

    expect(tabs).toContain("<MobileTabBar");
    expect(bar).toContain("MOBILE_TAB_NAMES");
    expect(bar).toContain("isHiddenByNavigator");
    expect(bar).toContain('position: "absolute"');
    expect(bar).toContain('variant="tab"');
    expect(bar).toContain('Platform.OS !== "web"');
    expect(bar).not.toContain("left.map");
    expect(button).toContain('variant === "tab"');
    expect(button).toContain("VoiceTabTrigger");
    expect(trigger).toContain("Comando de voz");
    expect(trigger).toContain("theme.colors.brand");
    expect(trigger).toContain("theme.shadow.lg");
    expect(trigger).not.toMatch(/>\s*Voz\s*</);
    expect(agenda).not.toContain("VoiceCommandButton");
    expect(agenda).not.toContain('title="Não foi possível carregar as escalas"');
    expect(hook).toContain("rosterQuery.isError");
    expect(hook).toContain("retry: 0");
    expect(bar).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    expect(trigger).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
  });
});
