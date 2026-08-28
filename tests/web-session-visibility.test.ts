import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transitionTenantAuthorizationActivity } from "../lib/tenant-authorization";

describe("sessão web sob troca rápida de aba", () => {
  it("esconder a aba no web não fecha o gate nem trata AppState como background", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("function TenantAuthorizationBoundary"),
      layout.indexOf("function AuthGuard"),
    );
    expect(boundary).toContain('if (Platform.OS === "web") return');
    expect(boundary).not.toContain(
      "updateActivity({ visible: document.visibilityState !== \"hidden\" })",
    );
    expect(boundary).toContain('document.visibilityState !== "visible"');
    expect(boundary).toContain("void refetch()");
  });

  it("voltar à aba refetch /me sem passar por CLOSE/REVALIDATE de visibilidade", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("function TenantAuthorizationBoundary"),
      layout.indexOf("function AuthGuard"),
    );
    const visibility = boundary.slice(
      boundary.indexOf("const handleVisibility"),
      boundary.indexOf("const handleOnline"),
    );
    expect(visibility).toContain("void refetch()");
    expect(visibility).toContain("updateActivity({ visible: true })");
    expect(visibility).not.toContain("visible: false");
    expect(boundary).toContain("patch.online === true");
  });

  it("reconnect de rede ainda exige /me fresco", () => {
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
});
