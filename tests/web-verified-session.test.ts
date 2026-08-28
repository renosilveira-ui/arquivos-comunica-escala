import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModule(platform: "web" | "ios") {
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  return import("../lib/web-verified-session");
}

describe("receipt VERIFIED web sobrevive a remount do AuthProvider", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("react-native");
  });

  it("nativo preserva VERIFIED — remount Android não cai no login", async () => {
    const mod = await loadModule("ios");
    const ticket = { generation: 4 };
    const user = { id: 7, name: "Ana" };
    mod.rememberPreservedWebVerifiedSession({
      user,
      ticket,
      sequence: 11,
    });
    expect(
      mod.readPreservedWebVerifiedSession({
        isTransportCurrent: () => true,
        isEpochCurrent: () => true,
      }),
    ).toEqual({ user, ticket, sequence: 11 });
  });

  it("web devolve a snapshot só enquanto transporte e epoch são atuais", async () => {
    const mod = await loadModule("web");
    const ticket = { generation: 4 };
    const user = { id: 7, name: "Ana" };
    mod.rememberPreservedWebVerifiedSession({
      user,
      ticket,
      sequence: 11,
    });

    expect(
      mod.readPreservedWebVerifiedSession({
        isTransportCurrent: (userId) => userId === 7,
        isEpochCurrent: (current) => current.generation === 4,
      }),
    ).toEqual({ user, ticket, sequence: 11 });

    expect(
      mod.readPreservedWebVerifiedSession({
        isTransportCurrent: () => false,
        isEpochCurrent: () => true,
      }),
    ).toBeNull();
    expect(
      mod.readPreservedWebVerifiedSession({
        isTransportCurrent: () => true,
        isEpochCurrent: () => false,
      }),
    ).toBeNull();
  });

  it("alinha sequence stale ou à frente do módulo sem descartar a snapshot", async () => {
    const mod = await loadModule("web");
    const ticket = { generation: 4 };
    const user = { id: 7, name: "Ana" };
    mod.rememberPreservedWebVerifiedSession({
      user,
      ticket,
      sequence: 11,
    });

    expect(mod.alignPreservedWebVerifiedSessionSequence(0)).toBe(11);
    expect(
      mod.readPreservedWebVerifiedSession({
        isTransportCurrent: () => true,
        isEpochCurrent: () => true,
      }),
    ).toEqual({ user, ticket, sequence: 11 });

    expect(mod.alignPreservedWebVerifiedSessionSequence(14)).toBe(14);
    expect(
      mod.readPreservedWebVerifiedSession({
        isTransportCurrent: () => true,
        isEpochCurrent: () => true,
      }),
    ).toEqual({ user, ticket, sequence: 14 });
  });

  it("nativo alinha sequence no remount — o gate não fica stale", async () => {
    const mod = await loadModule("ios");
    mod.rememberPreservedWebVerifiedSession({
      user: { id: 7 },
      ticket: { generation: 4 },
      sequence: 11,
    });
    expect(mod.alignPreservedWebVerifiedSessionSequence(3)).toBe(11);
  });

  it("logout/revogação apaga a snapshot — remount não ressuscita a conta", async () => {
    const mod = await loadModule("web");
    mod.rememberPreservedWebVerifiedSession({
      user: { id: 7 },
      ticket: { generation: 1 },
      sequence: 2,
    });
    mod.clearPreservedWebVerifiedSession();
    expect(
      mod.readPreservedWebVerifiedSession({
        isTransportCurrent: () => true,
        isEpochCurrent: () => true,
      }),
    ).toBeNull();
  });
});
