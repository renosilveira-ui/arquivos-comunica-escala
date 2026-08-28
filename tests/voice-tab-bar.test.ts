import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("comando de voz na barra inferior", () => {
  it("o celular coloca o microfone no centro da tab bar, não no cabeçalho da Agenda", () => {
    const tabs = readFileSync("app/(tabs)/_layout.tsx", "utf8");
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const bar = readFileSync("components/ui/MobileTabBar.tsx", "utf8");
    const trigger = readFileSync("components/ui/VoiceTabTrigger.tsx", "utf8");
    const button = readFileSync("components/VoiceCommandButton.tsx", "utf8");

    expect(tabs).toContain("<MobileTabBar");
    expect(tabs).not.toContain("<BottomTabBar");
    expect(bar).toContain('variant="tab"');
    expect(bar).toContain("Platform.OS !== \"web\"");
    expect(button).toContain('variant === "tab"');
    expect(button).toContain("VoiceTabTrigger");
    expect(trigger).toContain("Comando de voz");
    expect(trigger).toContain("theme.colors.brand");
    expect(trigger).toContain("theme.shadow.lg");
    expect(trigger).toMatch(/>\s*Voz\s*</);
    expect(agenda).not.toContain("VoiceCommandButton");
    expect(bar).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    expect(trigger).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
  });
});
