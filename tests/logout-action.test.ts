import { describe, expect, it, vi } from "vitest";

import {
  logoutFailureFeedback,
  runGuardedLogoutAction,
} from "../lib/logout-action";
import {
  SessionCleanupIncompleteError,
  SessionTerminationLocalCleanupError,
  SessionTerminationNotDurableError,
} from "../lib/session-cleanup";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ação compartilhada de logout", () => {
  it("distingue ausência de 2xx de revogação confirmada com limpeza incompleta", () => {
    expect(
      logoutFailureFeedback(
        new SessionTerminationNotDurableError(new Error("HTTP 500")),
      ),
    ).toEqual({
      title: "Saída não confirmada",
      message: expect.stringContaining("não confirmou o encerramento"),
    });
    expect(
      logoutFailureFeedback(
        new SessionTerminationLocalCleanupError(
          new Error("SecureStore indisponível"),
        ),
      ),
    ).toEqual({
      title: "Sessão encerrada; limpeza incompleta",
      message: expect.stringContaining("servidor confirmou a saída"),
    });
    expect(logoutFailureFeedback(new Error("erro desconhecido"))).toEqual({
      title: "Não foi possível concluir a saída",
      message: expect.stringContaining("confirmar o resultado completo"),
    });
  });

  it("bloqueia toque duplo e só executa o efeito de sucesso após o logout", async () => {
    const pendingLogout = deferred();
    const calls: string[] = [];
    const lock = { current: false };
    const logout = vi.fn(async () => {
      calls.push("logout:start");
      await pendingLogout.promise;
      calls.push("logout:end");
    });
    const onSuccess = vi.fn(() => {
      calls.push("success");
    });
    const options = {
      lock,
      logout,
      onBusyChange: (busy: boolean) => calls.push(`busy:${busy}`),
      onSuccess,
      onFailure: vi.fn(),
    };

    const first = runGuardedLogoutAction(options);
    await expect(runGuardedLogoutAction(options)).resolves.toBe("IGNORED");
    expect(logout).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();

    pendingLogout.resolve();
    await expect(first).resolves.toBe("SUCCESS");
    expect(calls).toEqual([
      "busy:true",
      "logout:start",
      "logout:end",
      "success",
      "busy:false",
    ]);
    expect(lock.current).toBe(false);
  });

  it("não produz sucesso na falha e libera uma nova tentativa", async () => {
    const failure = new SessionTerminationNotDurableError(
      new Error("rede indisponível"),
    );
    const lock = { current: false };
    const logout = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    const options = {
      lock,
      logout,
      onBusyChange: vi.fn(),
      onSuccess,
      onFailure,
    };

    await expect(runGuardedLogoutAction(options)).resolves.toBe("FAILED");
    expect(onFailure).toHaveBeenCalledWith(failure);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(lock.current).toBe(false);

    await expect(runGuardedLogoutAction(options)).resolves.toBe("SUCCESS");
    expect(logout).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("logoutFailureFeedback — nomear o que ficou para trás", () => {
  it("a mensagem diz quais etapas não concluíram", () => {
    // Em build de loja (TestFlight) não há console: se a tela não disser,
    // ninguém descobre qual etapa falhou — nem quem usa, nem o suporte.
    const aggregate = new SessionCleanupIncompleteError(
      [new Error("keychain"), new Error("cofre")],
      ["token de sessão", "registro push"],
    );
    const feedback = logoutFailureFeedback(
      new SessionTerminationLocalCleanupError(aggregate),
    );
    expect(feedback.title).toBe("Sessão encerrada; limpeza incompleta");
    expect(feedback.message).toContain("token de sessão");
    expect(feedback.message).toContain("registro push");
    // O aviso original não se perde: ele é o que diz o que FAZER.
    expect(feedback.message).toContain("Feche e reabra o app");
  });

  it("sem nomes conhecidos, a mensagem não ganha linha vazia", () => {
    const feedback = logoutFailureFeedback(
      new SessionTerminationLocalCleanupError(new Error("causa opaca")),
    );
    expect(feedback.message).not.toContain("Não concluído");
  });

  it("erro desconhecido também aproveita os nomes, se houver", () => {
    // O ramo genérico é o que aparece quando a falha não foi classificada —
    // justamente quando saber a etapa importa mais.
    const feedback = logoutFailureFeedback(
      new SessionCleanupIncompleteError([new Error("x")], ["cache persistido"]),
    );
    expect(feedback.title).toBe("Não foi possível concluir a saída");
    expect(feedback.message).toContain("cache persistido");
  });

  it("o agregado preserva os erros originais para quem já os inspeciona", () => {
    const original = new Error("keychain");
    const aggregate = new SessionCleanupIncompleteError([original], ["token de sessão"]);
    expect(aggregate.name).toBe("AggregateError");
    expect(aggregate.errors).toEqual([original]);
    expect(aggregate.stepNames).toEqual(["token de sessão"]);
  });
});
