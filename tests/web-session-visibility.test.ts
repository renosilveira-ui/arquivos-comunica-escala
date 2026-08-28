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

  it("voltar à aba não refetch /me — #287 ainda disparava o request que deslogava", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const effect = layout.slice(
      layout.indexOf("if (!shouldAttachNativeSessionGateLifecycle"),
      layout.indexOf("useEffect(() => {", layout.indexOf("const coordinator = coordinatorRef.current")),
    );
    expect(effect).not.toContain("void refetch()");
    expect(effect).not.toContain("updateActivity({ visible: true })");
    expect(effect).not.toContain("visible: false");
  });

  it("QueryClient não refetch no foco nem no reconnect", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    expect(layout).toContain("refetchOnWindowFocus: false");
    expect(layout).toContain("refetchOnReconnect: false");
  });

  it("reconnect de rede nativo ainda exige /me fresco", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("const updateActivity = useCallback"),
      layout.indexOf("useEffect(() => {", layout.indexOf("const updateActivity")),
    );
    expect(boundary).toContain("patch.online === true");
    expect(boundary).toContain("void refetch()");
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
  });

  it("AuthProvider web restaura VERIFIED no remount e não refetch /me automaticamente", () => {
    const auth = readFileSync("hooks/use-auth.ts", "utf8");
    expect(auth).toContain("readPreservedWebVerifiedSession");
    expect(auth).toContain("rememberPreservedWebVerifiedSession");
    expect(auth).toContain("clearPreservedWebVerifiedSession");
    expect(auth).toContain("if (restoredWebSessionRef.current) return");
    expect(auth).toContain("readRestoredWebVerifiedSession");
  });

  it("background nativo fecha gate e visible online só revalida handshake institucional", () => {
    let activity = { visible: true, online: true, revision: 0 };
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

  it("os mesmos patches no web não fecham o gate — regressão do #287", () => {
    const activity = { visible: true, online: true, revision: 2 };
    expect(
      applyTenantAuthorizationActivityPatch(activity, { visible: false }, "web")
        .action,
    ).toBe("NONE");
    expect(
      applyTenantAuthorizationActivityPatch(activity, { online: false }, "web")
        .action,
    ).toBe("NONE");
  });
});
