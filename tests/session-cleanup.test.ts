import { describe, expect, it, vi } from "vitest";
import {
  createAccountScopedNotificationCleanupSteps,
  runSessionCleanup,
  type SessionCleanupStep,
} from "../lib/session-cleanup";

describe("limpeza local de sessão", () => {
  it("executa todas as etapas e encerra o usuário em memória", async () => {
    const calls: string[] = [];
    const steps: SessionCleanupStep[] = [
      { name: "token", run: () => calls.push("token") },
      {
        name: "tenant",
        run: async () => {
          calls.push("tenant");
        },
      },
      { name: "cache", run: () => calls.push("cache") },
    ];

    await expect(
      runSessionCleanup(steps, () => {
        calls.push("user");
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["token", "tenant", "cache", "user"]);
  });

  it("falha ao remover token não impede as demais limpezas nem o encerramento da UI", async () => {
    const state = {
      persistedUser: true,
      tenant: true,
      persistedCache: true,
      queryCache: true,
      visibleUser: true,
    };
    const secureStoreError = new Error("SecureStore indisponível");
    const reportFailure = vi.fn(() => {
      throw new Error("logger indisponível");
    });

    const cleanup = runSessionCleanup(
      [
        {
          name: "token de sessão",
          run: () => {
            throw secureStoreError;
          },
        },
        {
          name: "usuário persistido",
          run: () => {
            state.persistedUser = false;
          },
        },
        {
          name: "instituição ativa",
          run: () => {
            state.tenant = false;
          },
        },
        {
          name: "cache persistido",
          run: () => {
            state.persistedCache = false;
          },
        },
        {
          name: "cache de consultas em memória",
          run: () => {
            state.queryCache = false;
          },
        },
      ],
      () => {
        state.visibleUser = false;
      },
      reportFailure,
    );

    const error = await cleanup.catch((caught) => caught);
    expect(error).toMatchObject({
      name: "AggregateError",
      errors: [secureStoreError],
    });
    expect(state).toEqual({
      persistedUser: false,
      tenant: false,
      persistedCache: false,
      queryCache: false,
      visibleUser: false,
    });
    expect(reportFailure).toHaveBeenCalledWith("token de sessão", secureStoreError);
  });

  it("agrega falha intermediária, completa o restante e finaliza a UI", async () => {
    const calls: string[] = [];
    const tenantError = new Error("tenant storage indisponível");
    const cleanup = runSessionCleanup(
      [
        { name: "token", run: () => calls.push("token") },
        {
          name: "tenant",
          run: () => {
            calls.push("tenant");
            throw tenantError;
          },
        },
        { name: "cache", run: () => calls.push("cache") },
      ],
      () => calls.push("user"),
      () => undefined,
    );

    await expect(cleanup).rejects.toMatchObject({
      name: "AggregateError",
      errors: [tenantError],
    });
    expect(calls).toEqual(["token", "tenant", "cache", "user"]);
  });

  it("tenta badge, entregues, agendadas e última resposta mesmo com falhas", async () => {
    const badgeError = new Error("badge indisponível");
    const deliveredError = new Error("central indisponível");
    const responseError = new Error("resposta indisponível");
    const calls: string[] = [];
    const api = {
      setBadgeCountAsync: vi.fn(async () => {
        calls.push("badge");
        throw badgeError;
      }),
      dismissAllNotificationsAsync: vi.fn(async () => {
        calls.push("delivered");
        throw deliveredError;
      }),
      cancelAllScheduledNotificationsAsync: vi.fn(async () => {
        calls.push("scheduled");
      }),
      clearLastNotificationResponse: vi.fn(() => {
        calls.push("response");
        throw responseError;
      }),
    };
    const loadApi = vi.fn(async () => api);

    const cleanup = runSessionCleanup(
      createAccountScopedNotificationCleanupSteps("ios", loadApi),
      () => {
        calls.push("finalize");
      },
      () => undefined,
    );

    await expect(cleanup).rejects.toMatchObject({
      name: "AggregateError",
      errors: [badgeError, deliveredError, responseError],
    });
    expect(loadApi).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "badge",
      "delivered",
      "scheduled",
      "response",
      "finalize",
    ]);
  });

  it("trata badge sem suporte como capability ausente e conclui a limpeza", async () => {
    const calls: string[] = [];
    const api = {
      setBadgeCountAsync: vi.fn(async () => {
        calls.push("badge");
        return false;
      }),
      dismissAllNotificationsAsync: vi.fn(async () => {
        calls.push("delivered");
      }),
      cancelAllScheduledNotificationsAsync: vi.fn(async () => {
        calls.push("scheduled");
      }),
      clearLastNotificationResponse: vi.fn(() => {
        calls.push("response");
      }),
    };

    await expect(
      runSessionCleanup(
        createAccountScopedNotificationCleanupSteps("ios", async () => api),
        () => {
          calls.push("finalize");
        },
      ),
    ).resolves.toBeUndefined();
    expect(api.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(calls).toEqual([
      "badge",
      "delivered",
      "scheduled",
      "response",
      "finalize",
    ]);
  });

  it("não toca notificações do navegador", () => {
    const loadApi = vi.fn();

    expect(createAccountScopedNotificationCleanupSteps("web", loadApi)).toEqual(
      [],
    );
    expect(loadApi).not.toHaveBeenCalled();
  });
});
