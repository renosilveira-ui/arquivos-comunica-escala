import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SWAP_OFFER_DEEP_LINK,
  SWAP_OFFER_PUSH_TITLE,
  shouldInvalidateSwapQueriesOnNotification,
  shouldRefetchSwapOfferBadgeOnAppStateChange,
} from "../lib/swap-offer-badge-refresh";

describe("badge e destinatários de oferta — contratos de fonte", () => {
  it("invalida Trocas só em swap_offer e swap_taken", () => {
    expect(shouldInvalidateSwapQueriesOnNotification("swap_offer")).toBe(true);
    expect(shouldInvalidateSwapQueriesOnNotification("swap_taken")).toBe(true);
    expect(shouldInvalidateSwapQueriesOnNotification("duty_confirmation")).toBe(
      false,
    );
    expect(shouldInvalidateSwapQueriesOnNotification("invite_accepted")).toBe(
      false,
    );
  });

  it("refetch de badge só no resume nativo background → visível", () => {
    expect(
      shouldRefetchSwapOfferBadgeOnAppStateChange({
        platform: "ios",
        previousState: "background",
        nextState: "active",
      }),
    ).toBe(true);
    expect(
      shouldRefetchSwapOfferBadgeOnAppStateChange({
        platform: "android",
        previousState: "background",
        nextState: "inactive",
      }),
    ).toBe(true);
    expect(
      shouldRefetchSwapOfferBadgeOnAppStateChange({
        platform: "ios",
        previousState: "inactive",
        nextState: "active",
      }),
    ).toBe(false);
    expect(
      shouldRefetchSwapOfferBadgeOnAppStateChange({
        platform: "web",
        previousState: "background",
        nextState: "active",
      }),
    ).toBe(false);
  });

  it("elegibilidade de push reusa o ramo plantonista e não o atalho gerencial", () => {
    const eligibility = readFileSync("server/swap-offer-eligibility.ts", "utf8");
    const sql = eligibility.slice(eligibility.indexOf("SELECT DISTINCT au.id"));
    const listAvailable = readFileSync("server/swap-router.ts", "utf8");
    const listSlice = listAvailable.slice(
      listAvailable.indexOf("async function queryListAvailableRows"),
      listAvailable.indexOf("async function countActionableSwapOffers"),
    );
    expect(eligibility).toContain("export async function eligibleRecipientUserIdsForSwapOffer");
    expect(sql).toContain("ap.medical_specialty_id = aq.medical_specialty_id");
    expect(listSlice).toContain("ap.medical_specialty_id = aq.medical_specialty_id");
    expect(sql).toContain("actor_source_access.sector_id = fsi.sector_id");
    expect(listSlice).toContain("actor_source_access.sector_id = fsi.sector_id");
    expect(sql).toContain("sr.to_professional_id = ap.id AND sr.to_user_id = au.id");
    expect(sql).not.toContain("api.role_in_institution = 'GESTOR_PLUS'");
    expect(sql).not.toContain("actor_mgr");
    expect(sql).not.toContain("actor_source_scope");
    expect(sql).not.toContain("actor_directed_scope");
    expect(listSlice).toContain("GESTOR_PLUS");
    expect(listSlice).toContain("manager_scope");
    expect(listSlice).toContain("GESTOR_PLUS");
    expect(listSlice).toContain("manager_scope");
  });

  it("sinal de oferta usa a consulta batch e copy sem PII do ofertante", () => {
    const signal = readFileSync("server/swap-offer-signal.ts", "utf8");
    expect(signal).toContain("eligibleRecipientUserIdsForSwapOffer");
    expect(signal).toContain("swap-offer:${swap.id}:${userId}");
    expect(signal).toContain("SWAP_OFFER_PUSH_TITLE");
    expect(signal).toContain("SWAP_OFFER_DEEP_LINK");
    expect(signal).not.toContain("listScaleManagerUserIds");
    expect(signal).not.toContain("offererName");
    expect(signal).not.toContain("roleInInstitution, \"GESTOR_MEDICO\"");
    expect(SWAP_OFFER_PUSH_TITLE).toBe("Plantão disponível");
    expect(SWAP_OFFER_DEEP_LINK).toBe("/(tabs)/trocas");
  });

  it("push recebido invalida countActionable e listAvailable sem navegar", () => {
    const listener = readFileSync("components/NotificationListener.tsx", "utf8");
    expect(listener).toContain("addNotificationReceivedListener");
    expect(listener).toContain("shouldInvalidateSwapQueriesOnNotification");
    expect(listener).toContain("utils.swaps.countActionable.invalidate()");
    expect(listener).toContain("utils.swaps.listAvailable.invalidate()");
    const received = listener.slice(
      listener.indexOf("addNotificationReceivedListener"),
      listener.indexOf("responseConsumerRef.current = consumeResponse"),
    );
    expect(received).not.toContain("navigateToTrocas");
    expect(received).not.toContain("router.push");
  });

  it("aba Trocas usa countActionable e refetch no AppState nativo", () => {
    const tabs = readFileSync("app/(tabs)/_layout.tsx", "utf8");
    const root = readFileSync("app/_layout.tsx", "utf8");
    expect(tabs).toContain("trpc.swaps.countActionable.useQuery");
    expect(tabs).toContain("staleTime: 15_000");
    expect(tabs).toContain("shouldRefetchSwapOfferBadgeOnAppStateChange");
    expect(tabs).toContain("utils.swaps.countActionable.invalidate()");
    expect(tabs).toContain("utils.swaps.listAvailable.invalidate()");
    expect(tabs).not.toContain("notifications.read");
    expect(tabs).toContain('if (Platform.OS === "web") return');
    expect(root).toContain("refetchOnWindowFocus: false");
  });

  it("aceitar/ofertar no cliente já invalida o badge", () => {
    const list = readFileSync("components/swaps/AvailableSwapsList.tsx", "utf8");
    const offer = readFileSync("app/request-swap.tsx", "utf8");
    expect(list).toContain("utils.swaps.countActionable.invalidate()");
    expect(list).toContain("utils.swaps.listAvailable.invalidate()");
    expect(offer).toContain("utils.swaps.countActionable.invalidate()");
    expect(offer).toContain("utils.swaps.listAvailable.invalidate()");
  });
});
