import { describe, expect, it } from "vitest";
import {
  isOperationalNetworkOnline,
  isCurrentOperationalQueryContext,
  shouldRefreshOperationalQueriesOnNativeFocus,
  shouldRefreshOperationalQueriesOnNativeReconnect,
} from "../lib/operational-query-refresh";

describe("recuperação operacional nativa", () => {
  it("só reconcilia ao voltar de uma desconexão explícita no nativo", () => {
    expect(
      shouldRefreshOperationalQueriesOnNativeReconnect({
        platform: "ios",
        wasExplicitlyOffline: true,
        isOnline: true,
      }),
    ).toBe(true);
    expect(
      shouldRefreshOperationalQueriesOnNativeReconnect({
        platform: "android",
        wasExplicitlyOffline: false,
        isOnline: true,
      }),
    ).toBe(false);
    expect(
      shouldRefreshOperationalQueriesOnNativeReconnect({
        platform: "web",
        wasExplicitlyOffline: true,
        isOnline: true,
      }),
    ).toBe(false);
  });

  it("mantém a reconciliação por foco fora do web", () => {
    expect(shouldRefreshOperationalQueriesOnNativeFocus("ios")).toBe(true);
    expect(shouldRefreshOperationalQueriesOnNativeFocus("android")).toBe(true);
    expect(shouldRefreshOperationalQueriesOnNativeFocus("web")).toBe(false);
  });

  it("considera Wi-Fi sem internet como offline operacional, sem punir estado desconhecido", () => {
    const wifiWithoutInternet = {
      isConnected: true,
      isInternetReachable: false,
    };
    expect(isOperationalNetworkOnline(wifiWithoutInternet)).toBe(false);
    expect(
      shouldRefreshOperationalQueriesOnNativeReconnect({
        platform: "ios",
        wasExplicitlyOffline: !isOperationalNetworkOnline(wifiWithoutInternet),
        isOnline: isOperationalNetworkOnline({
          isConnected: true,
          isInternetReachable: true,
        }),
      }),
    ).toBe(true);
    expect(
      isOperationalNetworkOnline({
        isConnected: null,
        isInternetReachable: null,
      }),
    ).toBe(true);
    expect(
      isOperationalNetworkOnline({
        isConnected: false,
        isInternetReachable: null,
      }),
    ).toBe(false);
  });

  it("fecha a lease para sessão revogada, tenant ausente ou transição A para B", () => {
    const expectedTenant = { institutionId: 41, revision: 7 };
    expect(
      isCurrentOperationalQueryContext({
        userId: 9,
        sessionAuthorized: true,
        expectedTenant,
        currentTenant: expectedTenant,
      }),
    ).toBe(true);
    expect(
      isCurrentOperationalQueryContext({
        userId: 9,
        sessionAuthorized: false,
        expectedTenant,
        currentTenant: expectedTenant,
      }),
    ).toBe(false);
    expect(
      isCurrentOperationalQueryContext({
        userId: 9,
        sessionAuthorized: true,
        expectedTenant: { institutionId: null, revision: 7 },
        currentTenant: { institutionId: null, revision: 7 },
      }),
    ).toBe(false);
    expect(
      isCurrentOperationalQueryContext({
        userId: 9,
        sessionAuthorized: true,
        expectedTenant,
        currentTenant: { institutionId: 42, revision: 8 },
      }),
    ).toBe(false);
    expect(
      isCurrentOperationalQueryContext({
        userId: 9,
        sessionAuthorized: true,
        expectedTenant,
        currentTenant: { institutionId: 41, revision: 9 },
      }),
    ).toBe(false);
  });
});
