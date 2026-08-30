import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transitionTenantAuthorizationActivity } from "../lib/tenant-authorization";
import {
  applyTenantAuthorizationActivityPatch,
  isNativeAppSessionVisible,
  shouldSoftRevalidateNativeSessionOnForeground,
} from "../lib/web-session-lifecycle";

describe("sessão mobile no ciclo background → foreground", () => {
  it("sessão válida: segundo plano não CLOSE nem zera o navigator", () => {
    const current = { visible: true, online: true, revision: 4 };
    expect(
      applyTenantAuthorizationActivityPatch(current, { visible: false }, "ios")
        .action,
    ).toBe("NONE");
    expect(
      applyTenantAuthorizationActivityPatch(
        current,
        { visible: false },
        "android",
      ).action,
    ).toBe("NONE");

    const layout = readFileSync("app/_layout.tsx", "utf8");
    const effect = layout.slice(
      layout.indexOf("if (!shouldAttachNativeSessionGateLifecycle"),
      layout.indexOf(
        "useEffect(() => {",
        layout.indexOf("const coordinator = coordinatorRef.current"),
      ),
    );
    expect(effect).not.toContain("updateActivity({ visible:");
    expect(effect).toContain("void refetch()");
    expect(layout).toContain(
      'pathname === "/login" ||\n    pathname === "/signup"',
    );
    const guard = layout.slice(
      layout.indexOf("function AuthGuard"),
      layout.indexOf("export const unstable_settings"),
    );
    expect(guard.lastIndexOf('pathname === "/login"')).toBeGreaterThan(
      guard.indexOf("if (!attestation"),
    );
    expect(guard).toContain('Redirect href="/(tabs)"');
  });

  it("falha transitória no resume não é CLOSE — o /me soft preserva VERIFIED", () => {
    const auth = readFileSync("hooks/use-auth.ts", "utf8");
    expect(auth).toContain("preservedVerifiedSession");
    expect(auth).toContain("markTransientRevalidationUnavailable");
    expect(auth).toContain("me() falhou por rede/servidor — sessão não revalidada");
    expect(shouldSoftRevalidateNativeSessionOnForeground("android")).toBe(true);
    expect(shouldSoftRevalidateNativeSessionOnForeground("web")).toBe(false);
  });

  it("sessão realmente inválida no /me ainda revoga", () => {
    const auth = readFileSync("hooks/use-auth.ts", "utf8");
    const block = auth.slice(
      auth.indexOf("} else if (result.sessionInvalid) {"),
      auth.indexOf("me() falhou por rede/servidor"),
    );
    expect(block).toContain("revokeMismatchedTransport");
  });

  it("cold start e force-close relêem disco — resume não apaga o token", () => {
    const auth = readFileSync("lib/_core/auth.ts", "utf8");
    expect(auth).toContain("miss de Keystore não é logout");
    expect(auth).toContain("getPersistedUserId");
    const hook = readFileSync("hooks/use-auth.ts", "utf8");
    expect(hook).toContain("Cold start sempre consulta /me");
    expect(hook).toContain("preservedVerifiedSession || persistedUserId !== null");
  });

  it("logout manual continua removendo credencial — reopen não reloga", () => {
    const hook = readFileSync("hooks/use-auth.ts", "utf8");
    expect(hook).toContain("const logout = useCallback");
    expect(hook).toContain("Auth.removeSessionToken");
    expect(hook).toContain("Auth.clearUserInfo");
  });

  it("inactive não conta como background; só background dispara o resume", () => {
    expect(isNativeAppSessionVisible("inactive")).toBe(true);
    expect(isNativeAppSessionVisible("background")).toBe(false);
    expect(isNativeAppSessionVisible("active")).toBe(true);
  });

  it("o primitivo CLOSE permanece disponível, mas o patch de AppState não o usa", () => {
    expect(
      transitionTenantAuthorizationActivity(
        { visible: true, online: true, revision: 0 },
        { visible: false },
      ).action,
    ).toBe("CLOSE");
  });
});
