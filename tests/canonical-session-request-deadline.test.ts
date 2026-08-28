import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("requestCanonicalSession com prazo de abertura", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.doMock("react-native", () => ({ Platform: { OS: "android" } }));
    vi.doMock("../lib/_core/api-base-url", () => ({
      getApiBaseUrl: () => "https://staging.example",
    }));
    vi.doMock("../lib/_core/web-session-workflow", () => ({
      getActiveWebSessionWorkflowSignal: () => null,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborta /me canônico após o prazo e devolve falha de rede", async () => {
    const fetchMock = vi.fn(
      (_url: string, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("Tempo esgotado ao conectar ao servidor")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { requestCanonicalSession } = await import(
      "../lib/_core/canonical-session-request"
    );
    const pending = requestCanonicalSession<{ user?: { id: number } }>({
      expectedUserId: 42,
      nativeToken: "token-admissao",
    });

    await vi.advanceTimersByTimeAsync(70_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      status: 0,
      data: null,
      credentialPresented: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeDefined();
  });

  it("401 web sem prova de cookie no body não conta como credencial apresentada", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Não autenticado" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { requestCanonicalSession } = await import(
      "../lib/_core/canonical-session-request"
    );
    await expect(requestCanonicalSession({ expectedUserId: 7 })).resolves.toEqual({
      ok: false,
      status: 401,
      data: { error: "Não autenticado" },
      credentialPresented: false,
    });
  });

  it("401 web só marca credencial quando o servidor confirma o cookie", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "Não autenticado",
          credentialPresented: true,
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { requestCanonicalSession, resolveCredentialPresented } = await import(
      "../lib/_core/canonical-session-request"
    );
    await expect(requestCanonicalSession({ expectedUserId: 7 })).resolves.toEqual({
      ok: false,
      status: 401,
      data: { error: "Não autenticado", credentialPresented: true },
      credentialPresented: true,
    });
    expect(
      resolveCredentialPresented({
        requestCompleted: false,
        nativeAuthorizationAttached: true,
        webCredentialsIncluded: true,
        responseData: { credentialPresented: true },
      }),
    ).toBe(false);
  });
});
