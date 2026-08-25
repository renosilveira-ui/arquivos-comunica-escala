import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PlatformName = "web" | "ios";
type WebGateState = "CLEAR" | "ADMISSION" | "REVOKE_REQUIRED";
type BatchLinkOptions = {
  headers: () => Promise<Record<string, string>>;
  fetch: (url: string, options?: RequestInit) => Promise<Response>;
};
const SESSION_INSTANCE = `v1.${"a".repeat(43)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function loadHeaderBuilder(options: {
  platform: PlatformName;
  gateState?: WebGateState;
  gateError?: Error;
  institutionId?: number | null | Promise<number | null>;
  token?: string | null;
  transportTicket?: number | null;
}) {
  let batchLinkOptions: BatchLinkOptions | null = null;
  const getWebSessionGateState = vi.fn(async () => {
    if (options.gateError) throw options.gateError;
    return { state: options.gateState ?? "CLEAR" };
  });
  const getSessionToken = vi.fn(async () => options.token ?? null);
  const getActiveInstitutionId = vi.fn(async () =>
    Promise.resolve(options.institutionId ?? null),
  );
  const captureSessionTransportTicket = vi.fn<() => number | null>(() =>
    options.transportTicket === undefined ? 7 : options.transportTicket,
  );
  const isSessionTransportTicketCurrent = vi.fn<(ticket: number) => boolean>(
    () => true,
  );
  const getSessionTransportExpectedUserId = vi.fn((ticket: number) =>
    Number.isSafeInteger(ticket) ? 101 : null,
  );
  const getSessionTransportSessionInstance = vi.fn((ticket: number) =>
    options.platform === "web" && Number.isSafeInteger(ticket)
      ? SESSION_INSTANCE
      : null,
  );

  vi.doMock("react-native", () => ({
    Platform: { OS: options.platform },
  }));
  vi.doMock("@/lib/_core/auth", () => ({
    captureSessionTransportTicket,
    getSessionTransportExpectedUserId,
    getSessionTransportSessionInstance,
    getSessionToken,
    getWebSessionGateState,
    isSessionTransportTicketCurrent,
  }));
  vi.doMock("@/lib/_core/api", () => ({
    getApiBaseUrl: () => "https://escala.example",
  }));
  vi.doMock("@/lib/tenant-state", () => ({
    getActiveInstitutionId,
  }));
  vi.doMock("@trpc/react-query", () => ({
    createTRPCReact: () => ({
      createClient: vi.fn((clientOptions) => clientOptions),
    }),
    httpBatchLink: vi.fn((linkOptions: BatchLinkOptions) => {
      batchLinkOptions = linkOptions;
      return { kind: "captured-http-batch-link" };
    }),
  }));

  const { buildTRPCRequestHeaders, createTRPCClient } =
    await import("../lib/trpc");
  return {
    buildTRPCRequestHeaders,
    captureSessionTransportTicket,
    createTRPCClient,
    getActiveInstitutionId,
    getBatchLinkOptions: () => batchLinkOptions,
    getSessionToken,
    getSessionTransportExpectedUserId,
    getSessionTransportSessionInstance,
    getWebSessionGateState,
    isSessionTransportTicketCurrent,
  };
}

describe("gate de sessão web nos headers tRPC", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("libera tenant no estado CLEAR sem fabricar Authorization no navegador", async () => {
    const harness = await loadHeaderBuilder({
      platform: "web",
      gateState: "CLEAR",
      institutionId: 101,
      token: "token-que-nao-pode-ser-lido-no-web",
    });

    await expect(harness.buildTRPCRequestHeaders()).resolves.toEqual({
      "x-tenant-id": "101",
      "x-client-session-ticket": "7",
      "x-client-expected-user-id": "101",
      "x-client-session-instance": SESSION_INSTANCE,
    });
    expect(harness.captureSessionTransportTicket).toHaveBeenCalledTimes(1);
    expect(harness.getWebSessionGateState).toHaveBeenCalledTimes(1);
    expect(harness.getActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.getSessionToken).not.toHaveBeenCalled();
    expect(harness.isSessionTransportTicketCurrent).toHaveBeenCalledWith(7);
    expect(
      harness.getWebSessionGateState.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.getActiveInstitutionId.mock.invocationCallOrder[0]);
  });

  it.each(["ADMISSION", "REVOKE_REQUIRED"] as const)(
    "bloqueia %s antes de ler tenant ou token",
    async (gateState) => {
      const harness = await loadHeaderBuilder({
        platform: "web",
        gateState,
        institutionId: 101,
        token: "token-inacessivel",
      });

      await expect(harness.buildTRPCRequestHeaders()).rejects.toThrow(
        "Transporte web bloqueado por sessão em reconciliação",
      );
      expect(harness.getWebSessionGateState).toHaveBeenCalledTimes(1);
      expect(harness.getActiveInstitutionId).not.toHaveBeenCalled();
      expect(harness.getSessionToken).not.toHaveBeenCalled();
    },
  );

  it("falha fechado quando a leitura do gate web falha", async () => {
    const gateError = new Error("armazenamento de admissão indisponível");
    const harness = await loadHeaderBuilder({
      platform: "web",
      gateError,
      institutionId: 101,
      token: "token-inacessivel",
    });

    await expect(harness.buildTRPCRequestHeaders()).rejects.toBe(gateError);
    expect(harness.getWebSessionGateState).toHaveBeenCalledTimes(1);
    expect(harness.getActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.getSessionToken).not.toHaveBeenCalled();
  });

  it("no nativo ignora o gate web e envia tenant e Bearer", async () => {
    const harness = await loadHeaderBuilder({
      platform: "ios",
      gateError: new Error("gate web não deve ser consultado"),
      institutionId: 202,
      token: "token-nativo",
    });

    await expect(harness.buildTRPCRequestHeaders()).resolves.toEqual({
      "x-tenant-id": "202",
      Authorization: "Bearer token-nativo",
      "x-client-session-ticket": "7",
      "x-client-expected-user-id": "101",
    });
    expect(harness.getWebSessionGateState).not.toHaveBeenCalled();
    expect(harness.getActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.getSessionToken).toHaveBeenCalledTimes(1);
  });

  it("revalida o ticket após a leitura assíncrona do tenant", async () => {
    const institution = deferred<number | null>();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const harness = await loadHeaderBuilder({
      platform: "web",
      gateState: "CLEAR",
      institutionId: institution.promise,
      transportTicket: 7,
    });

    const headers = harness.buildTRPCRequestHeaders();
    await vi.waitFor(() => {
      expect(harness.getActiveInstitutionId).toHaveBeenCalledTimes(1);
    });
    harness.isSessionTransportTicketCurrent.mockReturnValue(false);
    institution.resolve(101);

    await expect(headers).rejects.toThrow(
      "Sessão mudou durante a construção do request",
    );
    expect(harness.isSessionTransportTicketCurrent).toHaveBeenCalledWith(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("permite o fetch web enquanto CLEAR e a geração permanecem estáveis", async () => {
    const response = new Response(null, { status: 204 });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    const harness = await loadHeaderBuilder({
      platform: "web",
      gateState: "CLEAR",
      institutionId: 101,
      transportTicket: 7,
    });
    harness.createTRPCClient();
    const linkOptions = harness.getBatchLinkOptions();
    expect(linkOptions).not.toBeNull();
    const builtHeaders = await harness.buildTRPCRequestHeaders();

    await expect(
      linkOptions!.fetch("https://escala.example/api/trpc", {
        headers: builtHeaders,
      }),
    ).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestOptions = fetchMock.mock.calls[0][1] as RequestInit;
    const networkHeaders = new Headers(requestOptions.headers);
    expect(networkHeaders.get("x-tenant-id")).toBe("101");
    expect(networkHeaders.get("x-client-expected-user-id")).toBe("101");
    expect(networkHeaders.get("x-client-session-instance")).toBe(
      SESSION_INSTANCE,
    );
    expect(networkHeaders.has("authorization")).toBe(false);
    expect(networkHeaders.has("x-client-session-ticket")).toBe(false);
    expect(requestOptions.credentials).toBe("include");
    expect(harness.isSessionTransportTicketCurrent).toHaveBeenCalledTimes(2);
  });

  it("repete o CAS antes do fetch real e consome o header interno", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const NativeHeaders = globalThis.Headers;
    let inspectedHeaders: Headers | null = null;
    class TrackingHeaders extends NativeHeaders {
      constructor(init?: HeadersInit) {
        super(init);
        inspectedHeaders = this;
      }
    }
    vi.stubGlobal("Headers", TrackingHeaders);

    const harness = await loadHeaderBuilder({
      platform: "web",
      gateState: "CLEAR",
      institutionId: 101,
      transportTicket: 7,
    });
    harness.createTRPCClient();
    const linkOptions = harness.getBatchLinkOptions();
    expect(linkOptions).not.toBeNull();
    const builtHeaders = await harness.buildTRPCRequestHeaders();
    expect(builtHeaders["x-client-session-ticket"]).toBe("7");

    // Simula BEGIN depois da construção dos headers e antes do transporte.
    harness.isSessionTransportTicketCurrent.mockReturnValue(false);
    await expect(
      linkOptions!.fetch("https://escala.example/api/trpc", {
        headers: builtHeaders,
      }),
    ).rejects.toThrow("Sessão mudou antes do envio do request");

    expect(harness.isSessionTransportTicketCurrent).toHaveBeenLastCalledWith(7);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inspectedHeaders).not.toBeNull();
    expect((inspectedHeaders as Headers).has("x-client-session-ticket")).toBe(
      false,
    );
  });

  it("só anexa Bearer nativo após uma nova admissão canônica", async () => {
    const harness = await loadHeaderBuilder({
      platform: "ios",
      institutionId: 202,
      token: "token-nativo",
      transportTicket: null,
    });
    harness.captureSessionTransportTicket.mockReturnValueOnce(null);

    await expect(harness.buildTRPCRequestHeaders()).rejects.toThrow(
      "Transporte bloqueado até a sessão ser revalidada",
    );
    expect(harness.getSessionToken).not.toHaveBeenCalled();

    harness.captureSessionTransportTicket.mockReturnValue(8);
    harness.isSessionTransportTicketCurrent.mockImplementation(
      (ticket) => ticket === 8,
    );
    await expect(harness.buildTRPCRequestHeaders()).resolves.toEqual({
      "x-tenant-id": "202",
      Authorization: "Bearer token-nativo",
      "x-client-session-ticket": "8",
      "x-client-expected-user-id": "101",
    });
    expect(harness.getSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.isSessionTransportTicketCurrent).toHaveBeenCalledWith(8);
  });

  it("operation A retida antes do batch nunca recaptura ticket B", async () => {
    let generation = 7;
    const captureSessionTransportTicket = vi.fn(() => generation);
    const getSessionTransportExpectedUserId = vi.fn((ticket: number) =>
      ticket === 7 ? 101 : 202,
    );
    const getSessionTransportSessionInstance = vi.fn(() => SESSION_INSTANCE);
    const isSessionTransportTicketCurrent = vi.fn(
      (ticket: number) => ticket === generation,
    );
    vi.doUnmock("@trpc/react-query");
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("@/lib/_core/auth", () => ({
      captureSessionTransportTicket,
      getSessionTransportExpectedUserId,
      getSessionTransportSessionInstance,
      getWebSessionGateState: vi.fn(async () => ({ state: "CLEAR" })),
      isSessionTransportTicketCurrent,
    }));
    vi.doMock("@/lib/_core/api", () => ({
      getApiBaseUrl: () => "https://escala.example",
    }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { createTRPCClient } = await import("../lib/trpc");
    const client = createTRPCClient();
    const operationA = client.professionals.listMyInstitutions.query();
    // O proof-link já capturou A; o data-loader ainda não materializou headers.
    generation = 8;

    await expect(operationA).rejects.toThrow(
      "Sessão mudou antes de montar o lote tRPC",
    );
    expect(captureSessionTransportTicket).toHaveBeenCalledTimes(1);
    expect(getSessionTransportExpectedUserId).toHaveBeenCalledWith(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lote com instâncias de sessão diferentes falha antes do fetch", async () => {
    let nextTicket = 6;
    const captureSessionTransportTicket = vi.fn(() => ++nextTicket);
    const getSessionTransportExpectedUserId = vi.fn(() => 101);
    const getSessionTransportSessionInstance = vi.fn((ticket: number) =>
      ticket === 7 ? `v1.${"a".repeat(43)}` : `v1.${"b".repeat(43)}`,
    );
    vi.doUnmock("@trpc/react-query");
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("@/lib/_core/auth", () => ({
      captureSessionTransportTicket,
      getSessionTransportExpectedUserId,
      getSessionTransportSessionInstance,
      getWebSessionGateState: vi.fn(async () => ({ state: "CLEAR" })),
      isSessionTransportTicketCurrent: vi.fn(() => true),
    }));
    vi.doMock("@/lib/_core/api", () => ({
      getApiBaseUrl: () => "https://escala.example",
    }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { createTRPCClient } = await import("../lib/trpc");
    const client = createTRPCClient();
    const first = client.professionals.listMyInstitutions.query();
    const second = client.professionals.listMyInstitutions.query();

    const results = await Promise.allSettled([first, second]);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).toContain(
          "Lote tRPC mistura sessões diferentes",
        );
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
