import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transitionTenantAuthorizationActivity } from "../lib/tenant-authorization";
import { applyTenantAuthorizationActivityPatch } from "../lib/web-session-lifecycle";

describe("sessão web sob troca rápida de aba", () => {
  it("web não anexa visibilitychange, NetInfo, online/offline nem refetch de foco", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("function TenantAuthorizationBoundary"),
      layout.indexOf("function AuthGuard"),
    );
    expect(boundary).toContain("shouldAttachNativeSessionGateLifecycle");
    expect(boundary).toContain("applyTenantAuthorizationActivityPatch");
    expect(boundary).toContain("initialTenantAuthorizationActivityForPlatform");
    expect(boundary).not.toContain("handleVisibility");
    expect(boundary).not.toContain("document.visibilityState");
    expect(boundary).not.toContain('addEventListener("visibilitychange"');
    expect(boundary).not.toContain('addEventListener("pagehide"');
    expect(boundary).not.toContain('addEventListener("pageshow"');
    expect(boundary).not.toContain('addEventListener("freeze"');
    expect(boundary).not.toMatch(/addEventListener\?\.\(\"online\"/);
    expect(boundary).not.toMatch(/addEventListener\?\.\(\"offline\"/);
  });

  it("voltar à aba web não refetch /me — #287 ainda disparava o request que deslogava", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    expect(layout).toContain("shouldAttachNativeSessionGateLifecycle");
    expect(layout).toContain("shouldSoftRevalidateNativeSessionOnForeground");
    const webGuard = layout.slice(
      layout.indexOf("if (!shouldAttachNativeSessionGateLifecycle"),
      layout.indexOf("let nativeWasBackground"),
    );
    expect(webGuard).toContain("return undefined");
    expect(webGuard).not.toContain("void refetch()");
  });

  it("QueryClient não refetch no foco nem no reconnect", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    expect(layout).toContain("refetchOnWindowFocus: false");
    expect(layout).toContain("refetchOnReconnect: false");
  });

  it("reconnect de rede nativo não dispara /me — flap do Android deslogava", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("const updateActivity = useCallback"),
      layout.indexOf("useEffect(() => {", layout.indexOf("const updateActivity")),
    );
    expect(boundary).not.toContain("void refetch()");
    expect(boundary).toContain("equivalente nativo do #287");
  });

  it("Android só trata background como hidden — inactive do seletor não revalida", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const effect = layout.slice(
      layout.indexOf("if (!shouldAttachNativeSessionGateLifecycle"),
      layout.indexOf("useEffect(() => {", layout.indexOf("const coordinator = coordinatorRef.current")),
    );
    expect(effect).toContain("isNativeAppSessionVisible(nextState)");
    expect(effect).toContain("void refetch()");
    expect(effect).not.toContain("updateActivity({ visible:");
    expect(layout).toContain("isNativeAppSessionVisible(AppState.currentState)");
  });

  it("refetch nativo com identidade persistida e disco vazio não chama endSession", () => {
    const auth = readFileSync("hooks/use-auth.ts", "utf8");
    const start = auth.indexOf(
      "const persistedUserId = await Auth.getPersistedUserId()",
    );
    const block = auth.slice(
      start,
      auth.indexOf(
        "O commit esperado não produziu um binding ADMITTED",
        start,
      ),
    );
    expect(block).toContain("preservedVerifiedSession || persistedUserId !== null");
    expect(block).toContain("markTransientRevalidationUnavailable");
    expect(block).toContain('return "UNAVAILABLE"');
    expect(block).not.toContain('Platform.OS === "web" && persistedUserId');
  });

  it("refetch soft preserva receipt VERIFIED em falha transitória e não cai em CHECKING", () => {
    const auth = readFileSync("hooks/use-auth.ts", "utf8");
    const block = auth.slice(
      auth.indexOf("const performRefetchInsideWebLock"),
      auth.indexOf("const performRefetch = useCallback"),
    );
    expect(block).toContain("preservedVerifiedSession");
    expect(block).toContain("markTransientRevalidationUnavailable");
    expect(block).toContain("sessão não revalidada");
    expect(block).toContain("isLatestRequest() && !preservedVerifiedSession");
    expect(block).toContain("verifiedSessionValidation(");
    expect(block).toContain("requestSequence");
  });

  it("AuthProvider web restaura VERIFIED no remount e refetch /me em modo soft", () => {
    const auth = readFileSync("hooks/use-auth.ts", "utf8");
    expect(auth).toContain("readPreservedWebVerifiedSession");
    expect(auth).toContain("rememberPreservedWebVerifiedSession");
    expect(auth).toContain("clearPreservedWebVerifiedSession");
    expect(auth).toContain("alignPreservedWebVerifiedSessionSequence");
    expect(auth).toContain("readRestoredWebVerifiedSession");
    expect(auth).not.toContain("if (restoredWebSessionRef.current) return");
    const mountEffect = auth.slice(
      auth.indexOf("Cold start sempre consulta /me"),
      auth.indexOf("Auth.subscribeExternalWebSessionInvalidation"),
    );
    expect(mountEffect).toContain("void refetch()");
    expect(mountEffect).not.toContain("return;");
  });

  it("background nativo não fecha o gate — resume só revalida /me em modo soft", () => {
    let activity = { visible: true, online: true, revision: 0 };
    expect(
      applyTenantAuthorizationActivityPatch(activity, { visible: false }, "ios")
        .action,
    ).toBe("NONE");
    const hidden = transitionTenantAuthorizationActivity(activity, {
      visible: false,
    });
    expect(hidden.action).toBe("CLOSE");
    activity = hidden.state;

    const visibleAgain = transitionTenantAuthorizationActivity(activity, {
      visible: true,
    });
    expect(visibleAgain.action).toBe("REVALIDATE");
    expect(visibleAgain.state.visible).toBe(true);
    expect(visibleAgain.state.online).toBe(true);
  });

  it("os mesmos patches no web e no nativo não fecham o gate — regressão do #287", () => {
    const activity = { visible: true, online: true, revision: 2 };
    expect(
      applyTenantAuthorizationActivityPatch(activity, { visible: false }, "web")
        .action,
    ).toBe("NONE");
    expect(
      applyTenantAuthorizationActivityPatch(activity, { online: false }, "web")
        .action,
    ).toBe("NONE");
    expect(
      applyTenantAuthorizationActivityPatch(activity, { visible: false }, "ios")
        .action,
    ).toBe("NONE");
    expect(
      applyTenantAuthorizationActivityPatch(activity, { online: false }, "android")
        .action,
    ).toBe("NONE");
  });
});
