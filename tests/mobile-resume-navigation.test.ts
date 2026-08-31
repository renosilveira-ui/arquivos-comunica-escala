import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  resolveTenantAuthorizationTreeIntent,
  tenantAuthorizationTreeShouldClearQueryCache,
  tenantAuthorizationTreeShouldShowBootScreen,
  type TenantAuthorizationTreeInput,
} from "../lib/tenant-authorization";

const SUBJECT = "7:11:3";
const OTHER_USER = "8:11:3";
const OTHER_TENANT = "7:12:4";

function input(
  overrides: Partial<TenantAuthorizationTreeInput> = {},
): TenantAuthorizationTreeInput {
  return {
    verifiedSubjectKey: SUBJECT,
    currentSubjectKey: SUBJECT,
    userId: 7,
    sessionStatus: "VERIFIED",
    sessionUserId: 7,
    sessionProofCurrent: true,
    requiresHandshake: true,
    isHydrating: false,
    activityReady: true,
    ...overrides,
  };
}

describe("resume mobile preserva navigator da mesma identidade", () => {
  it("invariante: revalidação soft da sessão verificada não vai a boot/CHECKING", () => {
    const resume = resolveTenantAuthorizationTreeIntent(
      input({ sessionProofCurrent: false, requiresHandshake: false }),
    );
    expect(resume).toBe("keep_verified_tree");
    expect(tenantAuthorizationTreeShouldShowBootScreen(resume)).toBe(false);
    expect(tenantAuthorizationTreeShouldClearQueryCache(resume)).toBe(false);
  });

  it("active → background → active com /me 200 não desmonta a árvore", () => {
    const mounted = resolveTenantAuthorizationTreeIntent(input());
    const afterSequenceBump = resolveTenantAuthorizationTreeIntent(
      input({ sessionProofCurrent: false, requiresHandshake: false }),
    );
    const afterMe200 = resolveTenantAuthorizationTreeIntent(input());
    expect([mounted, afterSequenceBump, afterMe200]).toEqual([
      "keep_verified_tree",
      "keep_verified_tree",
      "keep_verified_tree",
    ]);
  });

  it("/me 200 da mesma identidade não limpa o QueryClient", () => {
    expect(
      tenantAuthorizationTreeShouldClearQueryCache(
        resolveTenantAuthorizationTreeIntent(input()),
      ),
    ).toBe(false);
  });

  it("/me transitório (UNAVAILABLE) da mesma identidade mantém a árvore", () => {
    const intent = resolveTenantAuthorizationTreeIntent(
      input({
        sessionStatus: "UNAVAILABLE",
        sessionUserId: null,
        sessionProofCurrent: false,
        requiresHandshake: false,
      }),
    );
    expect(intent).toBe("keep_verified_tree");
    expect(tenantAuthorizationTreeShouldShowBootScreen(intent)).toBe(false);
    expect(tenantAuthorizationTreeShouldClearQueryCache(intent)).toBe(false);
  });

  it("CHECKING in-flight da mesma identidade não reseta rota", () => {
    const intent = resolveTenantAuthorizationTreeIntent(
      input({
        sessionStatus: "CHECKING",
        sessionProofCurrent: false,
        requiresHandshake: false,
      }),
    );
    expect(intent).toBe("keep_verified_tree");
  });

  it("user id mudou → handshake destrutivo", () => {
    const intent = resolveTenantAuthorizationTreeIntent(
      input({ currentSubjectKey: OTHER_USER, userId: 8, sessionUserId: 8 }),
    );
    expect(intent).toBe("destructive_handshake");
    expect(tenantAuthorizationTreeShouldClearQueryCache(intent)).toBe(true);
    expect(tenantAuthorizationTreeShouldShowBootScreen(intent)).toBe(true);
  });

  it("institution/tenant mudou → handshake destrutivo", () => {
    const intent = resolveTenantAuthorizationTreeIntent(
      input({ currentSubjectKey: OTHER_TENANT }),
    );
    expect(intent).toBe("destructive_handshake");
    expect(tenantAuthorizationTreeShouldClearQueryCache(intent)).toBe(true);
  });

  it("logout / 401 real zera a árvore protegida", () => {
    const intent = resolveTenantAuthorizationTreeIntent(
      input({
        userId: null,
        sessionStatus: "CHECKING",
        sessionUserId: null,
        sessionProofCurrent: false,
        requiresHandshake: false,
        verifiedSubjectKey: SUBJECT,
      }),
    );
    expect(intent).toBe("clear_unauthenticated");
    expect(tenantAuthorizationTreeShouldClearQueryCache(intent)).toBe(true);
  });

  it("cold start sem árvore verificada mostra BootScreen", () => {
    const waiting = resolveTenantAuthorizationTreeIntent(
      input({
        verifiedSubjectKey: null,
        sessionStatus: "CHECKING",
        sessionProofCurrent: false,
        requiresHandshake: false,
        isHydrating: true,
      }),
    );
    expect(waiting).toBe("boot_hold");
    expect(tenantAuthorizationTreeShouldShowBootScreen(waiting)).toBe(true);
    expect(tenantAuthorizationTreeShouldClearQueryCache(waiting)).toBe(false);

    const firstProof = resolveTenantAuthorizationTreeIntent(
      input({ verifiedSubjectKey: null }),
    );
    expect(firstProof).toBe("destructive_handshake");
    expect(tenantAuthorizationTreeShouldShowBootScreen(firstProof)).toBe(true);
    expect(tenantAuthorizationTreeShouldClearQueryCache(firstProof)).toBe(true);
  });

  it("cold start indisponível sem árvore verificada é UNAVAILABLE, não keep", () => {
    const intent = resolveTenantAuthorizationTreeIntent(
      input({
        verifiedSubjectKey: null,
        sessionStatus: "UNAVAILABLE",
        sessionProofCurrent: false,
        requiresHandshake: false,
      }),
    );
    expect(intent).toBe("unavailable");
  });
});

describe("fonte: boundary ignora sequence e preserva request-swap", () => {
  it("o handshake não lista sequence nem currentSessionProof nas deps", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("function TenantAuthorizationBoundary"),
      layout.indexOf("function AuthGuard"),
    );
    const handshake = boundary.slice(
      boundary.indexOf("Sequence de `/me`"),
      boundary.indexOf("useEffect(() => {\n    if (gateState.status !== \"CHECKING\")"),
    );
    expect(handshake).toContain('treeIntent === "keep_verified_tree"');
    expect(handshake).toContain("tenantAuthorizationTreeShouldClearQueryCache");
    expect(handshake).toContain("liveSessionRef.current");
    expect(handshake).not.toContain("sessionValidation.sequence");
    expect(handshake).not.toContain("currentSessionProof");
    expect(handshake).not.toContain("requiresHandshake,");
    expect(handshake).toContain("verifiedTreeSubjectKeyRef.current === liveSubjectKey");
  });

  it("keep_verified_tree renderiza children antes de qualquer BootScreen de prova", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("function TenantAuthorizationBoundary"),
      layout.indexOf("function AuthGuard"),
    );
    const keepRender = boundary.indexOf('treeIntent === "keep_verified_tree" && gateState.status === "VERIFIED"');
    const bootOnMissingProof = boundary.indexOf("if (user && !currentSessionProof)");
    expect(keepRender).toBeGreaterThan(0);
    expect(keepRender).toBeLessThan(bootOnMissingProof);
    expect(boundary).toContain("{children}");
  });

  it("attestation.isCurrent usa identidade efetiva, não sequence do receipt fechado", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("function TenantAuthorizationBoundary"),
      layout.indexOf("function AuthGuard"),
    );
    expect(boundary).toContain("Identidade efetiva, não sequence");
    expect(boundary).not.toMatch(/currentSessionProof\.isCurrent\(\)/);
  });

  it("request-swap guarda o formulário em React state — sem draft extra", () => {
    const source = readFileSync("app/request-swap.tsx", "utf8");
    expect(source).toContain('useLocalSearchParams<{ type?: string; fromShiftId?: string }>');
    expect(source).toContain('useState<OfferType>("SWAP")');
    expect(source).toContain("useState<ShiftInstance | null>(null)");
    expect(source).toContain('useState("")');
    expect(source).toContain("selectedFrom");
    expect(source).toContain("selectedTo");
    expect(source).toContain("reason");
    expect(source).not.toContain("AsyncStorage");
    expect(source).not.toContain("sessionStorage");
  });

  it("cold start continua no anchor (tabs); deep-link não foi alterado pelo resume", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    expect(layout).toContain('anchor: "(tabs)"');
    const guard = layout.slice(
      layout.indexOf("function AuthGuard"),
      layout.indexOf("export const unstable_settings"),
    );
    expect(guard).toContain('Redirect href="/login"');
    expect(guard).toContain('Redirect href="/(tabs)"');
  });

  it("logout manual continua removendo estado protegido", () => {
    const hook = readFileSync("hooks/use-auth.ts", "utf8");
    expect(hook).toContain("const logout = useCallback");
    expect(hook).toContain("Auth.removeSessionToken");
    expect(hook).toContain("Auth.clearUserInfo");
    expect(hook).toContain("Sequence só agrupa refetch concorrente");
  });
});
