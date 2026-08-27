import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transitionTenantAuthorizationActivity } from "../lib/tenant-authorization";

describe("sessão web sob troca rápida de aba", () => {
  it("voltar à aba reabre handshake sem refetch de /me", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("function TenantAuthorizationBoundary"),
      layout.indexOf("function AuthGuard"),
    );
    expect(boundary).toContain('transition.action === "REVALIDATE"');
    const revalidate = boundary.slice(
      boundary.indexOf('} else if (transition.action === "REVALIDATE")'),
      boundary.indexOf(
        "setActivity(transition.state)",
        boundary.indexOf('} else if (transition.action === "REVALIDATE")'),
      ),
    );
    expect(revalidate).toContain("patch.online === true");
    expect(revalidate).toMatch(
      /if \(patch\.online === true\) \{[\s\S]*void refetch\(\);/,
    );
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

  it("refetch soft preserva receipt VERIFIED em falha transitória", () => {
    const auth = readFileSync("hooks/use-auth.ts", "utf8");
    const block = auth.slice(
      auth.indexOf("const performRefetchInsideWebLock"),
      auth.indexOf("const performRefetch = useCallback"),
    );
    expect(block).toContain("preservedVerifiedSession");
    expect(block).toContain("markTransientRevalidationUnavailable");
    expect(block).toContain("sessão não revalidada");
  });

  it("background fecha gate e visible online só revalida handshake institucional", () => {
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
