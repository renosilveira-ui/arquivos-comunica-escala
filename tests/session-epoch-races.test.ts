import { describe, expect, it } from "vitest";
import { SessionEpoch } from "../lib/session-epoch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type Snapshot = {
  user: string | null;
  token: string | null;
  queryOwner: string | null;
  persistedUser: string | null;
};

async function startMe(
  epoch: SessionEpoch,
  response: Promise<{ user: string | null; sessionInvalid: boolean }>,
  state: Snapshot,
) {
  const ticket = epoch.capture();
  const result = await response;
  if (!epoch.isCurrent(ticket)) return "stale" as const;

  if (result.user) {
    const applied = await epoch.runIfCurrent(ticket, () => {
      state.persistedUser = result.user;
    });
    if (applied) state.user = result.user;
    return applied ? "user" as const : "stale" as const;
  }

  if (result.sessionInvalid) {
    const cleanup = epoch.beginTransitionIfCurrent(ticket);
    if (!cleanup) return "stale" as const;
    state.user = null;
    state.token = null;
    state.queryOwner = null;
    state.persistedUser = null;
    return "invalid" as const;
  }

  return "network" as const;
}

function logoutThenLoginB(epoch: SessionEpoch, state: Snapshot) {
  epoch.beginTransition();
  state.user = null;
  state.token = null;
  state.queryOwner = null;
  state.persistedUser = null;

  epoch.beginTransition();
  state.user = "B";
  state.token = "token-B";
  state.queryOwner = "B";
  state.persistedUser = "B";
}

describe("epoch/CAS da sessão", () => {
  it("descarta /me 200 de A resolvido depois de logout + login B", async () => {
    const epoch = new SessionEpoch();
    const state: Snapshot = {
      user: "A",
      token: "token-A",
      queryOwner: "A",
      persistedUser: "A",
    };
    const meA = deferred<{ user: string | null; sessionInvalid: boolean }>();
    const request = startMe(epoch, meA.promise, state);

    logoutThenLoginB(epoch, state);
    meA.resolve({ user: "A", sessionInvalid: false });

    await expect(request).resolves.toBe("stale");
    expect(state).toEqual({
      user: "B",
      token: "token-B",
      queryOwner: "B",
      persistedUser: "B",
    });
  });

  it("descarta /me 401 de A sem remover token/cache/usuário B", async () => {
    const epoch = new SessionEpoch();
    const state: Snapshot = {
      user: "A",
      token: "token-A",
      queryOwner: "A",
      persistedUser: "A",
    };
    const meA = deferred<{ user: string | null; sessionInvalid: boolean }>();
    const request = startMe(epoch, meA.promise, state);

    logoutThenLoginB(epoch, state);
    meA.resolve({ user: null, sessionInvalid: true });

    await expect(request).resolves.toBe("stale");
    expect(state).toEqual({
      user: "B",
      token: "token-B",
      queryOwner: "B",
      persistedUser: "B",
    });
  });

  it("401 do token antigo não apaga sessão rotacionada pela troca de senha", async () => {
    const epoch = new SessionEpoch();
    const state: Snapshot = {
      user: "A",
      token: "token-antigo",
      queryOwner: "A",
      persistedUser: "A",
    };
    const meAntigo = deferred<{ user: string | null; sessionInvalid: boolean }>();
    const request = startMe(epoch, meAntigo.promise, state);

    // rotateSession avança antes do POST e só então publica o token retornado.
    epoch.beginTransition();
    state.token = "token-novo";
    meAntigo.resolve({ user: null, sessionInvalid: true });

    await expect(request).resolves.toBe("stale");
    expect(state).toEqual({
      user: "A",
      token: "token-novo",
      queryOwner: "A",
      persistedUser: "A",
    });
  });
});
