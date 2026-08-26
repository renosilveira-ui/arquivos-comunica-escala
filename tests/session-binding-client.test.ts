import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebLoginInProgress } from "../lib/_core/auth";

const SESSION_INSTANCE = `v1.${"a".repeat(43)}`;
const CLIENT_ACTIVE_ENV = "EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installWebApiMocks(
  transitionAuthority: Record<string, unknown> = {
    expectedUserId: 31,
    sessionInstance: SESSION_INSTANCE,
  },
) {
  const activeWebLoginTickets = new WeakSet<object>();
  const issueWebLogin = (): WebLoginInProgress => {
    const ticket = Object.freeze({}) as WebLoginInProgress;
    activeWebLoginTickets.add(ticket);
    return ticket;
  };
  const consumeWebLoginInProgressForRequest = vi.fn(
    (ticket: WebLoginInProgress) => {
      if (!activeWebLoginTickets.delete(ticket)) {
        throw new Error("Capability de login web inválida ou reutilizada");
      }
    },
  );
  vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
  vi.doMock("../lib/_core/auth", () => ({
    consumeSessionTransitionCredentialForRequest: vi.fn(
      () => transitionAuthority,
    ),
    consumeWebLoginInProgressForRequest,
  }));
  vi.doMock("../lib/tenant-state", () => ({
    getActiveInstitutionId: vi.fn(async () => null),
  }));
  return { consumeWebLoginInProgressForRequest, issueWebLogin };
}

describe("rollout cliente do binding exact-v1", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env[CLIENT_ACTIVE_ENV];
  });

  afterEach(() => {
    delete process.env[CLIENT_ACTIVE_ENV];
    vi.unstubAllGlobals();
  });

  it("default 0 mantém o cliente antigo em login legacy sem preflight ou header", async () => {
    const webGate = installWebApiMocks();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toMatch(/\/api\/auth\/login$/);
        expect(init?.credentials).toBe("include");
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-client-session-protocol"]).toBeUndefined();
        return response({
          user: {
            id: 31,
            name: "Usuário legacy",
            email: "legacy@example.com",
            role: "doctor",
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.login("legacy@example.com", "segredo"),
    ).rejects.toThrow("Capability do gate de login web indisponível");
    expect(fetchMock).not.toHaveBeenCalled();

    const webLogin = webGate.issueWebLogin();
    await expect(
      authApi.login("legacy@example.com", "segredo", undefined, webLogin),
    ).resolves.toMatchObject({ ok: true, user: { id: 31 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(webGate.consumeWebLoginInProgressForRequest).toHaveBeenCalledTimes(
      1,
    );

    await expect(
      authApi.login("legacy@example.com", "segredo", undefined, webLogin),
    ).rejects.toThrow("Capability de login web inválida ou reutilizada");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("active 1 exige capability no-store antes de pedir e receber exact-v1", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const webGate = installWebApiMocks();
    const requests: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(url);
        const headers = init?.headers as Record<string, string>;
        if (url.endsWith("/api/auth/session-binding-capability")) {
          expect(init?.method).toBe("GET");
          expect(init?.cache).toBe("no-store");
          expect(init?.credentials).toBe("omit");
          expect(headers.Authorization).toBeUndefined();
          expect(headers["x-client-session-protocol"]).toBeUndefined();
          return response({ capability: "exact-v1", supported: true });
        }
        expect(url).toMatch(/\/api\/auth\/login$/);
        expect(headers["x-client-session-protocol"]).toBe("exact-v1");
        return response({
          user: {
            id: 31,
            name: "Usuário exact",
            email: "exact@example.com",
            role: "doctor",
          },
          sessionInstance: SESSION_INSTANCE,
          sessionBinding: {
            capability: "exact-v1",
            supported: true,
            sessionVersion: 1,
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.login(
        "exact@example.com",
        "segredo",
        undefined,
        webGate.issueWebLogin(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      user: { id: 31 },
      sessionInstance: SESSION_INSTANCE,
      sessionBinding: { sessionVersion: 1 },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatch(/session-binding-capability$/);
    expect(requests[1]).toMatch(/\/login$/);
  });

  it("receipt de capability é purpose-bound, one-shot e evita preflight tardio", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const webGate = installWebApiMocks();
    const requests: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/api/auth/session-binding-capability")) {
          return response({ capability: "exact-v1", supported: true });
        }
        expect(url).toMatch(/\/api\/auth\/login$/);
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-client-session-protocol"]).toBe("exact-v1");
        return response({
          user: {
            id: 31,
            name: "Usuário exact",
            email: "exact@example.com",
            role: "doctor",
          },
          sessionInstance: SESSION_INSTANCE,
          sessionBinding: {
            capability: "exact-v1",
            supported: true,
            sessionVersion: 1,
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    const receipt = await authApi.prepareSessionBindingMutation("login");
    await expect(
      authApi.login(
        "exact@example.com",
        "segredo",
        receipt,
        webGate.issueWebLogin(),
      ),
    ).resolves.toMatchObject({ ok: true, user: { id: 31 } });
    await expect(
      authApi.login(
        "exact@example.com",
        "segredo",
        receipt,
        webGate.issueWebLogin(),
      ),
    ).rejects.toMatchObject({
      code: "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatch(/session-binding-capability$/);
    expect(requests[1]).toMatch(/\/login$/);
    expect(webGate.consumeWebLoginInProgressForRequest).toHaveBeenCalledTimes(
      1,
    );
  });

  it("receipt de login não autoriza DELETE", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const credential = Object.freeze({});
    installWebApiMocks();
    const fetchMock = vi.fn(async () =>
      response({ capability: "exact-v1", supported: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    const receipt = await authApi.prepareSessionBindingMutation("login");
    await expect(
      authApi.deleteAccount("senha", credential as never, receipt),
    ).rejects.toMatchObject({
      code: "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /session-binding-capability$/,
    );
  });

  it.each([
    ["unsupported", response({ capability: "exact-v1", supported: false })],
    ["missing", response({ error: "not found" }, 404)],
  ])(
    "active 1 com capability %s falha antes do POST de login",
    async (_label, capabilityResponse) => {
      process.env[CLIENT_ACTIVE_ENV] = "1";
      installWebApiMocks();
      const fetchMock = vi.fn(async () => capabilityResponse);
      vi.stubGlobal("fetch", fetchMock);

      const { authApi } = await import("../lib/_core/api");
      await expect(
        authApi.login("exact@example.com", "segredo"),
      ).rejects.toMatchObject({
        code: "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toMatch(
        /session-binding-capability$/,
      );
    },
  );

  it("active 1 com capability em erro de rede não tenta a mutação", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    installWebApiMocks();
    const fetchMock = vi.fn(async () => {
      throw new Error("rede indisponível");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.login("exact@example.com", "segredo"),
    ).rejects.toMatchObject({
      code: "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
      status: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("configuração ambígua bloqueia antes de qualquer request", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "yes";
    installWebApiMocks();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.login("exact@example.com", "segredo")).rejects.toThrow(
      `${CLIENT_ACTIVE_ENV} deve ser 0 ou 1`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logout exact continua revogável quando capability fica false", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    installWebApiMocks();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toMatch(/\/api\/auth\/logout$/);
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-client-expected-user-id"]).toBe("31");
        expect(headers["x-client-session-instance"]).toBe(SESSION_INSTANCE);
        return response({
          ok: true,
          sessionFenceRotated: true,
          revocation: "ROTATED",
          revocationUserId: 31,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.logout(undefined, 31, SESSION_INSTANCE),
    ).resolves.toEqual({ status: "ROTATED", revocationUserId: 31 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(
      /session-binding-capability$/,
    );
  });

  it("change-password exact leva o protocolo; capability false bloqueia DELETE", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const credential = Object.freeze({});
    installWebApiMocks();
    let capabilitySupported = true;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/auth/session-binding-capability")) {
          return response({
            capability: "exact-v1",
            supported: capabilitySupported,
          });
        }
        const headers = init?.headers as Record<string, string>;
        expect(url).toMatch(/\/api\/auth\/change-password$/);
        expect(headers["x-client-session-protocol"]).toBe("exact-v1");
        return response({ ok: true, token: "token-B" });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.changePassword("antiga", "nova-segura", credential as never),
    ).resolves.toEqual({ ok: true, token: "token-B" });

    capabilitySupported = false;
    await expect(
      authApi.deleteAccount("antiga", credential as never),
    ).rejects.toMatchObject({
      code: "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toMatch(
      /session-binding-capability$/,
    );
  });
});
