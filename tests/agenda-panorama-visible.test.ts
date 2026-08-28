import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Panorama no celular deixa a folha de mês visível", () => {
  it("rola a página e embute a folha — sem ScrollView flex:1 de altura zero", () => {
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const container = readFileSync("components/ui/ScreenContainer.tsx", "utf8");
    const filled = agenda.slice(
      agenda.indexOf("selectedMonthShiftCount > 0"),
      agenda.indexOf(") : canCreateShift ?"),
    );

    expect(agenda).toContain("scrollPage={isDesktop || isMonthSheet}");
    expect(agenda).toContain("flex={!isDesktop && !isMonthSheet}");
    expect(agenda).toContain("embedInPage");
    expect(agenda).not.toContain("embedInPage={isDesktop}");
    expect(container).toContain("if (scrollPage)");
    expect(container).not.toContain("Platform.OS === \"web\" && scrollPage");
    expect(filled).toContain("isMonthSheet && !isDesktop");
    expect(filled.indexOf("isMonthSheet && !isDesktop")).toBeLessThan(
      filled.indexOf("<ManagerMonthActions"),
    );
    expect(agenda).toContain("isMonthSheet && !isDesktop ? null");
    expect(agenda).toContain("paddingBottom: isDesktop ? undefined : theme.space[20]");
  });
});
