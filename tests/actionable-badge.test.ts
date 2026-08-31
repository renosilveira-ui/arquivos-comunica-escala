import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actionableBadgeAccessibilityLabel,
  actionableBadgeUsesWarningTone,
  actionableBadgeValue,
  combineActionableBadgeStates,
  deriveActionableBadgeState,
} from "../lib/actionable-badge";

describe("badge acionável — estado confiável", () => {
  it("não converte falha inicial em zero", () => {
    const state = deriveActionableBadgeState({
      count: undefined,
      hasError: true,
    });

    expect(state).toEqual({ status: "UNAVAILABLE", count: null });
    expect(actionableBadgeValue(state)).toBe("!");
    expect(actionableBadgeAccessibilityLabel("Trocas", state)).toBe(
      "Trocas, contagem de pendências indisponível",
    );
  });

  it("preserva o último valor confirmado quando o refresh falha", () => {
    const state = deriveActionableBadgeState({ count: 4, hasError: true });

    expect(state).toEqual({ status: "STALE", count: 4 });
    expect(actionableBadgeValue(state)).toBe(4);
    expect(actionableBadgeUsesWarningTone(state)).toBe(true);
    expect(actionableBadgeAccessibilityLabel("Trocas", state)).toBe(
      "Trocas, 4 pendências, contagem desatualizada",
    );
  });

  it("sinaliza como indisponível um zero que não pôde ser revalidado", () => {
    const state = deriveActionableBadgeState({ count: 0, hasError: true });

    expect(actionableBadgeValue(state)).toBe("!");
    expect(actionableBadgeUsesWarningTone(state)).toBe(true);
  });

  it("omite zero confirmado e limita contagens grandes", () => {
    const zero = deriveActionableBadgeState({ count: 0, hasError: false });
    const large = deriveActionableBadgeState({ count: 18, hasError: false });

    expect(actionableBadgeValue(zero)).toBeUndefined();
    expect(actionableBadgeAccessibilityLabel("Trocas", zero)).toBe("Trocas");
    expect(actionableBadgeValue(large)).toBe("9+");
    expect(actionableBadgeValue(large, 99)).toBe(18);
    expect(actionableBadgeUsesWarningTone(large)).toBe(false);
  });

  it("rejeita contagens inválidas em vez de exibi-las", () => {
    expect(deriveActionableBadgeState({ count: -1, hasError: false })).toEqual({
      status: "UNAVAILABLE",
      count: null,
    });
    expect(
      deriveActionableBadgeState({ count: Number.NaN, hasError: true }),
    ).toEqual({ status: "UNAVAILABLE", count: null });
  });

  it("soma filas disjuntas somente quando todas têm dado confirmado", () => {
    expect(
      combineActionableBadgeStates([
        { status: "READY", count: 2 },
        { status: "READY", count: 3 },
      ]),
    ).toEqual({ status: "READY", count: 5 });
    expect(
      combineActionableBadgeStates([
        { status: "READY", count: 2 },
        { status: "STALE", count: 3 },
      ]),
    ).toEqual({ status: "STALE", count: 5 });
  });

  it("não publica soma parcial quando uma fila não tem valor", () => {
    expect(
      combineActionableBadgeStates([
        { status: "READY", count: 4 },
        { status: "UNAVAILABLE", count: null },
      ]),
    ).toEqual({ status: "UNAVAILABLE", count: null });
    expect(
      combineActionableBadgeStates([
        { status: "READY", count: 4 },
        { status: "LOADING", count: null },
      ]),
    ).toEqual({ status: "LOADING", count: null });
    expect(
      combineActionableBadgeStates([
        { status: "UNAVAILABLE", count: null },
        { status: "LOADING", count: null },
      ]),
    ).toEqual({ status: "UNAVAILABLE", count: null });
  });

  it("as superfícies usam o estado tipado e não restauram erro como zero", () => {
    const tabs = readFileSync("app/(tabs)/_layout.tsx", "utf8");
    const profile = readFileSync("app/(tabs)/profile.tsx", "utf8");
    const mobileTabBar = readFileSync("components/ui/MobileTabBar.tsx", "utf8");

    expect(tabs).toContain("deriveActionableBadgeState");
    expect(tabs).toContain("combineActionableBadgeStates");
    expect(profile).toContain("deriveActionableBadgeState");
    expect(profile).toContain("combineActionableBadgeStates");
    expect(tabs).not.toContain("actionableSwapCount?.swapOffers ?? 0");
    expect(profile).not.toContain("pendingAssignments?.length ?? 0");
    expect(tabs).toContain("tabBarAccessibilityLabel");
    expect(mobileTabBar).toContain("options.tabBarAccessibilityLabel");
  });
});
