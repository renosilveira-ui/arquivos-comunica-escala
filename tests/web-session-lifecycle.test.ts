import { describe, expect, it } from "vitest";
import { transitionTenantAuthorizationActivity } from "../lib/tenant-authorization";
import {
  applyTenantAuthorizationActivityPatch,
  initialTenantAuthorizationActivityForPlatform,
  shouldAttachNativeSessionGateLifecycle,
  WEB_TAB_LIFECYCLE_EVENTS,
} from "../lib/web-session-lifecycle";

describe("ciclo de vida da aba web não move o gate de sessão", () => {
  it("web nunca anexa AppState, NetInfo nem visibilitychange ao gate", () => {
    expect(shouldAttachNativeSessionGateLifecycle("web")).toBe(false);
    expect(shouldAttachNativeSessionGateLifecycle("ios")).toBe(true);
    expect(shouldAttachNativeSessionGateLifecycle("android")).toBe(true);
  });

  it("web nasce visível e online — aba já hidden no primeiro paint não fecha o gate", () => {
    expect(
      initialTenantAuthorizationActivityForPlatform("web", {
        visible: false,
        online: false,
      }),
    ).toEqual({ visible: true, online: true, revision: 0 });
    expect(
      initialTenantAuthorizationActivityForPlatform("ios", {
        visible: false,
        online: true,
      }),
    ).toEqual({ visible: false, online: true, revision: 0 });
  });

  it("esconder a aba, freeze e flap de rede no web são no-op — o nativo ainda fecha", () => {
    const current = { visible: true, online: true, revision: 3 };

    expect(
      applyTenantAuthorizationActivityPatch(current, { visible: false }, "web"),
    ).toEqual({ state: current, action: "NONE" });
    expect(
      applyTenantAuthorizationActivityPatch(current, { online: false }, "web"),
    ).toEqual({ state: current, action: "NONE" });
    expect(
      applyTenantAuthorizationActivityPatch(
        current,
        { visible: true, online: true },
        "web",
      ),
    ).toEqual({ state: current, action: "NONE" });

    const nativeHidden = applyTenantAuthorizationActivityPatch(
      current,
      { visible: false },
      "ios",
    );
    expect(nativeHidden.action).toBe("CLOSE");
    expect(nativeHidden).toEqual(
      transitionTenantAuthorizationActivity(current, { visible: false }),
    );
  });

  it("lista os eventos de aba que jamais podem refetch /me ou CLOSE", () => {
    expect(WEB_TAB_LIFECYCLE_EVENTS).toEqual([
      "visibilitychange",
      "pagehide",
      "pageshow",
      "freeze",
      "resume",
    ]);
  });
});
