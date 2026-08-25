import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEpoch } from "../lib/session-epoch";

const SESSION_INSTANCE = `v1.${"a".repeat(43)}`;

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("admissão do token no login nativo", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("devolve o token ao coordenador sem persistir antes do CAS de sessão", async () => {
    const setSessionToken = vi.fn(async () => undefined);
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      getSessionToken: vi.fn(async () => null),
      setSessionToken,
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              user: {
                id: 22,
                name: "Usuário B",
                email: "b@example.com",
                role: "doctor",
              },
              token: "token-B",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.login("b@example.com", "segredo"),
    ).resolves.toMatchObject({
      ok: true,
      token: "token-B",
      user: { id: 22 },
    });
    expect(setSessionToken).not.toHaveBeenCalled();
  });

  it("troca de senha também devolve o token sem bypass do epoch", async () => {
    const setSessionToken = vi.fn(async () => undefined);
    const transitionCredential = Object.freeze({});
    const consumeSessionTransitionCredentialForRequest = vi.fn(() => ({
      expectedUserId: 101,
      authorization: "Bearer token-antigo",
    }));
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      consumeSessionTransitionCredentialForRequest,
      getSessionToken: vi.fn(async () => {
        throw new Error("canal normal não deveria ser lido");
      }),
      setSessionToken,
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => 101),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              token: "token-novo",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.changePassword(
        "antiga",
        "nova-segura",
        transitionCredential as never,
      ),
    ).resolves.toEqual({ ok: true, token: "token-novo" });
    expect(consumeSessionTransitionCredentialForRequest).toHaveBeenCalledWith(
      transitionCredential,
      "/api/auth/change-password",
      "POST",
    );
    expect(setSessionToken).not.toHaveBeenCalled();
  });

  it("preserva mismatch e envia proof de instância em rotate, DELETE e logout", async () => {
    const transitionCredential = Object.freeze({});
    const reversibleWebRevocation = Object.freeze({});
    const consumeReversibleWebSessionRevocationForRequest = vi.fn();
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("../lib/_core/auth", () => ({
      consumeSessionTransitionCredentialForRequest: vi.fn(() => ({
        expectedUserId: 31,
        sessionInstance: SESSION_INSTANCE,
      })),
      consumeReversibleWebSessionRevocationForRequest,
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers["x-client-session-instance"]).toBe(SESSION_INSTANCE);
      return new Response(
        JSON.stringify({
          error: "A identidade autenticada não corresponde ao usuário esperado",
          code: "SESSION_INSTANCE_MISMATCH",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi, isExpectedUserMismatchError } =
      await import("../lib/_core/api");
    await expect(
      authApi.changePassword(
        "antiga",
        "nova-segura",
        transitionCredential as never,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "SESSION_INSTANCE_MISMATCH",
    });
    await expect(
      authApi.deleteAccount(
        "antiga",
        transitionCredential as never,
        undefined,
        reversibleWebRevocation as never,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "SESSION_INSTANCE_MISMATCH",
    });
    expect(consumeReversibleWebSessionRevocationForRequest).toHaveBeenCalledWith(
      reversibleWebRevocation,
    );
    const logoutError = await authApi
      .logout(undefined, 31, SESSION_INSTANCE)
      .catch((error) => error);
    expect(isExpectedUserMismatchError(logoutError)).toBe(true);
    expect(logoutError).toMatchObject({
      status: 409,
      code: "SESSION_INSTANCE_MISMATCH",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("serializa dois logins web e mantém cookie e UI no último login intencional", async () => {
    const webLoginA = Object.freeze({});
    const webLoginB = Object.freeze({});
    const consumeWebLoginInProgressForRequest = vi.fn();
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("../lib/_core/auth", () => ({
      consumeWebLoginInProgressForRequest,
      getSessionToken: vi.fn(async () => null),
      setSessionToken: vi.fn(async () => undefined),
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));

    const releaseA = deferredVoid();
    const releaseB = deferredVoid();
    const started: string[] = [];
    let browserCookie: string | null = null;
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body ?? "{}")) as {
        email: string;
      };
      started.push(body.email);
      if (body.email === "a@example.com") await releaseA.promise;
      else await releaseB.promise;
      browserCookie = `cookie-${body.email}`;
      return new Response(
        JSON.stringify({
          user: {
            id: body.email.startsWith("a") ? 1 : 2,
            name: body.email,
            email: body.email,
            role: "doctor",
          },
          token: `token-${body.email}`,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    const epoch = new SessionEpoch();
    let visibleUser: string | null = null;

    const ticketA = epoch.beginTransition();
    const loginA = authApi
      .login("a@example.com", "segredo", undefined, webLoginA as never)
      .then((result) => {
      if (epoch.isCurrent(ticketA) && result.user)
        visibleUser = result.user.email;
      return result;
      });
    const ticketB = epoch.beginTransition();
    const loginB = authApi
      .login("b@example.com", "segredo", undefined, webLoginB as never)
      .then((result) => {
      if (epoch.isCurrent(ticketB) && result.user)
        visibleUser = result.user.email;
      return result;
      });

    await vi.waitFor(() => expect(started).toEqual(["a@example.com"]));
    releaseA.resolve();
    await vi.waitFor(() =>
      expect(started).toEqual(["a@example.com", "b@example.com"]),
    );
    releaseB.resolve();
    await expect(Promise.all([loginA, loginB])).resolves.toMatchObject([
      { ok: true, user: { id: 1 } },
      { ok: true, user: { id: 2 } },
    ]);

    expect(visibleUser).toBe("b@example.com");
    expect(browserCookie).toBe("cookie-b@example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consumeWebLoginInProgressForRequest).toHaveBeenNthCalledWith(
      1,
      webLoginA,
    );
    expect(consumeWebLoginInProgressForRequest).toHaveBeenNthCalledWith(
      2,
      webLoginB,
    );
  });

  it("não confirma logout web sem 2xx e prova explícita do fence", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("../lib/_core/auth", () => ({
      getSessionToken: vi.fn(async () => null),
      setSessionToken: vi.fn(async () => undefined),
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("rede indisponível"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "indisponível" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            revocation: "ROTATED",
            revocationUserId: 202,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            sessionFenceRotated: true,
            revocation: "ROTATED",
            revocationUserId: 202,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.logout()).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(authApi.logout()).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(authApi.logout()).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(authApi.logout()).resolves.toEqual({
      status: "ROTATED",
      revocationUserId: 202,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("não confirma logout nativo sem 2xx e ok explícito do servidor", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      getSessionToken: vi.fn(async () => "token-nativo"),
      setSessionToken: vi.fn(async () => undefined),
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("rede indisponível"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "indisponível" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            revocation: "ROTATED",
            revocationUserId: 202,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.logout()).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(authApi.logout()).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(authApi.logout()).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(authApi.logout()).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(authApi.logout()).resolves.toEqual({
      status: "ROTATED",
      revocationUserId: 202,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-nativo");
    }
  });

  it("revogação de B em quarentena nunca é sobrescrita pelo Bearer A admitido", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      captureSessionTransportTicket: vi.fn(() => 7),
      getSessionTransportExpectedUserId: vi.fn(() => 101),
      getSessionToken: vi.fn(async () => "token-A"),
      isSessionTransportTicketCurrent: vi.fn((ticket: number) => ticket === 7),
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-B");
      return new Response(
        JSON.stringify({
          ok: true,
          revocation: "ALREADY_INVALID",
          revocationUserId: 202,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.revokeSessionToken("token-B")).resolves.toEqual({
      status: "ALREADY_INVALID",
      revocationUserId: 202,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("apiFetch protegido aborta se a sessão muda durante a leitura do tenant", async () => {
    const tenantRead = deferredVoid();
    let generation = 7;
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("../lib/_core/auth", () => ({
      captureSessionTransportTicket: vi.fn(() => 7),
      getSessionTransportExpectedUserId: vi.fn(() => 101),
      getSessionTransportSessionInstance: vi.fn(() => SESSION_INSTANCE),
      getWebSessionGateState: vi.fn(async () => ({ state: "CLEAR" })),
      isSessionTransportTicketCurrent: vi.fn(
        (ticket: number) => ticket === generation,
      ),
    }));
    const getActiveInstitutionId = vi.fn(async () => {
      await tenantRead.promise;
      return 101;
    });
    vi.doMock("../lib/tenant-state", () => ({ getActiveInstitutionId }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { apiFetch } = await import("../lib/_core/api");
    const request = apiFetch("/api/trpc/protected");
    await vi.waitFor(() =>
      expect(getActiveInstitutionId).toHaveBeenCalledTimes(1),
    );
    generation = 8;
    tenantRead.resolve();

    await expect(request).resolves.toMatchObject({
      ok: false,
      status: 0,
      credentialPresented: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("apiFetch web prende a proof canônica e remove override de instância do caller", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("../lib/_core/auth", () => ({
      captureSessionTransportTicket: vi.fn(() => 7),
      getSessionTransportExpectedUserId: vi.fn(() => 101),
      getSessionTransportSessionInstance: vi.fn(() => SESSION_INSTANCE),
      getWebSessionGateState: vi.fn(async () => ({ state: "CLEAR" })),
      isSessionTransportTicketCurrent: vi.fn((ticket: number) => ticket === 7),
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => 202),
    }));
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(options?.credentials).toBe("include");
      expect(headers["x-client-expected-user-id"]).toBe("101");
      expect(headers["x-client-session-instance"]).toBe(SESSION_INSTANCE);
      expect(headers["x-tenant-id"]).toBe("202");
      expect(
        Object.keys(headers).filter(
          (name) => name.toLowerCase() === "x-client-session-instance",
        ),
      ).toHaveLength(1);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { apiFetch } = await import("../lib/_core/api");
    await expect(
      apiFetch("/api/protected", {
        headers: {
          "X-Client-Session-Instance": `v1.${"z".repeat(43)}`,
          "X-Client-Expected-User-Id": "999",
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("apiFetch comum ignora qualquer Bearer injetado fora do logout de quarentena", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      captureSessionTransportTicket: vi.fn(() => 7),
      getSessionTransportExpectedUserId: vi.fn(() => 101),
      getSessionToken: vi.fn(async () => "token-A"),
      isSessionTransportTicketCurrent: vi.fn((ticket: number) => ticket === 7),
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-A");
      expect(headers["x-client-expected-user-id"]).toBe("101");
      expect(
        Object.keys(headers).filter(
          (name) => name.toLowerCase() === "authorization",
        ),
      ).toHaveLength(1);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { apiFetch } = await import("../lib/_core/api");
    await expect(
      apiFetch("/api/protected", {
        headers: {
          authorization: "Bearer token-injetado",
          "X-Client-Expected-User-Id": "999",
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("endpoint público nativo não lê nem transporta sessão ou tenant", async () => {
    const getSessionToken = vi.fn(async () => {
      throw new Error("token não deveria ser lido");
    });
    const getActiveInstitutionId = vi.fn(async () => {
      throw new Error("tenant não deveria ser lido");
    });
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({ getSessionToken }));
    vi.doMock("../lib/tenant-state", () => ({ getActiveInstitutionId }));
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers["x-client-expected-user-id"]).toBeUndefined();
      expect(headers["x-tenant-id"]).toBeUndefined();
      return new Response(JSON.stringify({ institutions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.listSignupInstitutions()).resolves.toEqual([]);
    expect(getSessionToken).not.toHaveBeenCalled();
    expect(getActiveInstitutionId).not.toHaveBeenCalled();
  });

  it("endpoint público web omite cookie e remove headers de autoridade", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("../lib/_core/auth", () => ({}));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => 101),
    }));
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(options?.credentials).toBe("omit");
      expect(headers.Authorization).toBeUndefined();
      expect(headers["x-client-expected-user-id"]).toBeUndefined();
      expect(headers["x-tenant-id"]).toBeUndefined();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.signup({
        name: "Pessoa",
        email: "pessoa@example.com",
        password: "segredo-seguro",
        institutionId: 101,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("logout de transição envia identidade esperada canônica", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("../lib/_core/auth", () => ({}));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers["x-client-expected-user-id"]).toBe("202");
      return new Response(
        JSON.stringify({
          ok: true,
          sessionFenceRotated: true,
          revocation: "ROTATED",
          revocationUserId: 202,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.logout(null, 202)).resolves.toEqual({
      status: "ROTATED",
      revocationUserId: 202,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("revogação explícita rejeita qualquer 401 e só confirma 2xx tipado", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      getSessionToken: vi.fn(async () => "token-A"),
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              revocation: "ALREADY_INVALID",
              revocationUserId: 202,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
    );

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.revokeSessionToken("token-B")).rejects.toThrow(
      "não confirmou a revogação do token",
    );
    await expect(authApi.revokeSessionToken("token-B")).resolves.toEqual({
      status: "ALREADY_INVALID",
      revocationUserId: 202,
    });
  });

  it("rejeita ROTATED sem userId inteiro positivo mesmo com identidade local esperada", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      getSessionToken: vi.fn(async () => "token-A"),
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));

    const invalidRevocationUserIds = [
      undefined,
      null,
      "202",
      0,
      202.5,
      Number.MAX_SAFE_INTEGER + 1,
    ] as const;
    const fetchMock = vi.fn(async () => {
      const revocationUserId =
        invalidRevocationUserIds[fetchMock.mock.calls.length - 1];
      return new Response(
        JSON.stringify({
          ok: true,
          revocation: "ROTATED",
          ...(revocationUserId === undefined ? {} : { revocationUserId }),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    for (
      let attempt = 0;
      attempt < invalidRevocationUserIds.length;
      attempt++
    ) {
      await expect(authApi.logout(undefined, 202)).rejects.toThrow(
        "servidor não confirmou a revogação",
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(invalidRevocationUserIds.length);
  });

  it("aceita ALREADY_INVALID sem userId, mas rejeita toda propriedade userId malformada", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({}));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));

    const bodies = [
      { ok: true, revocation: "ALREADY_INVALID" },
      { ok: true, revocation: "ALREADY_INVALID", revocationUserId: 202 },
      { ok: true, revocation: "ALREADY_INVALID", revocationUserId: null },
      { ok: true, revocation: "ALREADY_INVALID", revocationUserId: "202" },
      { ok: true, revocation: "ALREADY_INVALID", revocationUserId: 0 },
      { ok: true, revocation: "ALREADY_INVALID", revocationUserId: 202.5 },
      {
        ok: true,
        revocation: "ALREADY_INVALID",
        revocationUserId: Number.MAX_SAFE_INTEGER + 1,
      },
    ] as const;
    const fetchMock = vi.fn(async () => {
      const body = bodies[fetchMock.mock.calls.length - 1];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    const proofWithoutUserId = await authApi.revokeSessionToken("token-B");
    expect(proofWithoutUserId).toStrictEqual({
      status: "ALREADY_INVALID",
    });
    expect(proofWithoutUserId).not.toHaveProperty("revocationUserId");
    await expect(authApi.revokeSessionToken("token-B")).resolves.toEqual({
      status: "ALREADY_INVALID",
      revocationUserId: 202,
    });
    for (let attempt = 2; attempt < bodies.length; attempt++) {
      await expect(authApi.revokeSessionToken("token-B")).rejects.toThrow(
        "servidor não confirmou a revogação do token",
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(bodies.length);
  });

  it("meDetailed preserva a classificação fail-closed da validação canônica", async () => {
    const canonical = {
      user: null,
      sessionInvalid: false,
      networkOrServerError: true,
    };
    const validateCanonicalSession = vi.fn(async () => canonical);
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      validateCanonicalSession,
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.meDetailed()).resolves.toEqual(canonical);
    expect(validateCanonicalSession).toHaveBeenCalledWith(undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("meDetailed encaminha a identidade esperada ao validador canônico", async () => {
    const canonical = {
      user: null,
      sessionInvalid: true,
      networkOrServerError: false,
    };
    const validateCanonicalSession = vi.fn(async () => canonical);
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      validateCanonicalSession,
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(authApi.meDetailed(202)).resolves.toEqual(canonical);
    expect(validateCanonicalSession).toHaveBeenCalledWith(202);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovery de logout revalida exatamente o Bearer PENDING, nunca o admitido", async () => {
    const validationReceipt = Object.freeze({});
    const canonical = {
      user: {
        id: 202,
        name: "Usuário B",
        email: "b@example.com",
        role: "doctor" as const,
      },
      sessionInvalid: false,
      networkOrServerError: false,
      validationReceipt,
    };
    const validateCanonicalSession = vi.fn(async () => canonical);
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../lib/_core/auth", () => ({
      validateCanonicalSession,
    }));
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.revalidateSessionToken("token-B", 202),
    ).resolves.toEqual(canonical);
    expect(validateCanonicalSession).toHaveBeenCalledWith(202, "token-B");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
