import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MOBILE_TAB_NAMES,
  visibleMobileTabNames,
} from "@/lib/mobile-tab-bar";

const ALL_TAB_ROUTES = [
  "index",
  "agenda",
  "trocas",
  "calendar",
  "weekly",
  "dashboard",
  "pending",
  "vacancies",
  "reports",
  "admin",
  "profile",
] as const;

function routesFrom(names: readonly string[]) {
  return names.map((name) => ({ name }));
}

describe("filtro da barra inferior do celular", () => {
  it("das 11 rotas do layout, só Agenda, Trocas, Vagas e Perfil ficam visíveis", () => {
    const hiddenByExpoRouter = {
      index: { tabBarItemStyle: { display: "none" as const } },
      calendar: { tabBarItemStyle: { display: "none" as const } },
      weekly: { tabBarItemStyle: { display: "none" as const } },
      dashboard: { tabBarItemStyle: { display: "none" as const } },
      pending: { tabBarItemStyle: { display: "none" as const } },
      reports: { tabBarItemStyle: { display: "none" as const } },
      admin: { tabBarItemStyle: { display: "none" as const } },
    };

    expect(
      visibleMobileTabNames(routesFrom(ALL_TAB_ROUTES), hiddenByExpoRouter),
    ).toEqual(["agenda", "trocas", "vacancies", "profile"]);
    expect(MOBILE_TAB_NAMES).toEqual([
      "agenda",
      "trocas",
      "vacancies",
      "profile",
    ]);
  });

  it("não depende de options.href — Expo Router já removeu essa chave", () => {
    expect(
      visibleMobileTabNames(routesFrom(ALL_TAB_ROUTES), {}),
    ).toEqual(["agenda", "trocas", "vacancies", "profile"]);
  });

  it("esconde Vagas quando o navigator marca display none", () => {
    expect(
      visibleMobileTabNames(routesFrom(ALL_TAB_ROUTES), {
        vacancies: { tabBarItemStyle: { display: "none" } },
      }),
    ).toEqual(["agenda", "trocas", "profile"]);
  });

  it("esconde Vagas também pelo href null legado", () => {
    expect(
      visibleMobileTabNames(routesFrom(ALL_TAB_ROUTES), {
        vacancies: { href: null },
      }),
    ).toEqual(["agenda", "trocas", "profile"]);
  });

  it("a barra e o seletor de escala usam o filtro e o fallback sem retry", () => {
    const bar = readFileSync("components/ui/MobileTabBar.tsx", "utf8");
    const hook = readFileSync("hooks/use-schedule-context.ts", "utf8");
    const layout = readFileSync("app/(tabs)/_layout.tsx", "utf8");

    expect(bar).toContain("isHiddenByNavigator");
    expect(bar).toContain("MOBILE_TAB_NAMES");
    expect(bar).toContain('position: "absolute"');
    expect(layout).toContain('name="dashboard"');
    expect(layout).toContain('name="pending"');
    expect(layout).toContain('name="reports"');
    expect(layout).toContain('name="admin"');
    expect(hook).toContain("rosterQuery.isError");
    expect(hook).toContain("retry: 0");
  });
});
