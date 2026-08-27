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
      credentialPresented: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeDefined();
  });
});
