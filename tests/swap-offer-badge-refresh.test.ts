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
    const eligibility = readFileSync(
      "server/swap-offer-eligibility.ts",
      "utf8",
    );
    const plantonista = readFileSync(
      "server/plantonista-shift-eligibility.ts",
      "utf8",
    );
    const sql = eligibility.slice(eligibility.indexOf("SELECT DISTINCT au.id"));
    const listAvailable = readFileSync("server/swap-router.ts", "utf8");
    const listSlice = listAvailable.slice(
      listAvailable.indexOf("async function queryListAvailableRows"),
      listAvailable.indexOf("async function countActionableSwapOffers"),
    );
    expect(eligibility).toContain(
      "export async function eligibleRecipientUserIdsForSwapOffer",
    );
    expect(eligibility).toContain("plantonistaAccessCoversShiftSql");
    expect(eligibility).not.toContain("plantonistaXorQualificationSql");
    expect(eligibility).not.toContain("plantonistaQualificationMatchesSql");
    expect(plantonista).not.toContain("medical_specialty_id");
    expect(plantonista).not.toContain("operational_profile_code");
    expect(plantonista).toContain(
      'actor_source_access.sector_id = ${col(si, "sector_id")}',
    );
    expect(sql).toContain(
      "sr.to_professional_id = ap.id AND sr.to_user_id = au.id",
    );
    expect(sql).not.toContain("api.role_in_institution = 'GESTOR_PLUS'");
    expect(sql).not.toContain("actor_mgr");
    expect(sql).not.toContain("actor_source_scope");
    expect(sql).not.toContain("actor_directed_scope");
    expect(listSlice).not.toContain("medical_specialty_id");
    expect(listSlice).not.toContain("operational_profile_code");
    expect(listSlice).toContain(
      "actor_source_access.sector_id = fsi.sector_id",
    );
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
    expect(signal).not.toContain('roleInInstitution, "GESTOR_MEDICO"');
    expect(SWAP_OFFER_PUSH_TITLE).toBe("Plantão disponível");
    expect(SWAP_OFFER_DEEP_LINK).toBe("/(tabs)/trocas");
  });

  it("push recebido invalida countActionable e listAvailable sem navegar", () => {
    const listener = readFileSync(
      "components/NotificationListener.tsx",
      "utf8",
    );
    const refreshMatrix = readFileSync(
      "lib/notification-query-refresh.ts",
      "utf8",
    );
    expect(listener).toContain("addNotificationReceivedListener");
    expect(listener).toContain("notificationQueryRefreshTargets");
    expect(refreshMatrix).toContain(
      "shouldInvalidateSwapQueriesOnNotification",
    );
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
    expect(tabs).not.toContain("refetchInterval");
    expect(tabs).toContain("shouldRefetchSwapOfferBadgeOnAppStateChange");
    expect(tabs).toContain("utils.swaps.countActionable.invalidate()");
    expect(tabs).toContain("utils.swaps.listAvailable.invalidate()");
    expect(tabs).not.toContain("notifications.read");
    expect(tabs).toContain('if (Platform.OS === "web") return');
    expect(root).toContain("refetchOnWindowFocus: false");
  });

  it("resume do badge não reativa handshake nem clear da #322", () => {
    const tabs = readFileSync("app/(tabs)/_layout.tsx", "utf8");
    const root = readFileSync("app/_layout.tsx", "utf8");
    const helper = readFileSync("lib/swap-offer-badge-refresh.ts", "utf8");
    const tabsEffect = tabs.slice(
      tabs.indexOf("previousAppStateRef"),
      tabs.indexOf("return (") > tabs.indexOf("previousAppStateRef")
        ? tabs.indexOf("return (", tabs.indexOf("previousAppStateRef"))
        : tabs.length,
    );
    expect(tabsEffect).toContain("utils.swaps.countActionable.invalidate()");
    expect(tabsEffect).toContain("utils.swaps.listAvailable.invalidate()");
    expect(tabsEffect).toContain("isSessionAuthorizationCurrent()");
    expect(tabsEffect).not.toContain("queryClient.clear");
    expect(tabsEffect).not.toContain("keep_verified_tree");
    expect(tabsEffect).not.toContain("runTenantAuthorizationAttempt");
    expect(tabsEffect).not.toContain(
      "shouldSoftRevalidateNativeSessionOnForeground",
    );
    expect(helper).not.toContain("queryClient.clear");
    expect(root).toContain('treeIntent === "keep_verified_tree"');
    expect(root).toContain(
      "shouldSoftRevalidateNativeSessionOnForeground(Platform.OS)",
    );
  });

  it("aceitar/ofertar no cliente já invalida o badge", () => {
    const list = readFileSync(
      "components/swaps/AvailableSwapsList.tsx",
      "utf8",
    );
    const offer = readFileSync("app/request-swap.tsx", "utf8");
    expect(list).toContain("utils.swaps.countActionable.invalidate()");
    expect(list).toContain("utils.swaps.listAvailable.invalidate()");
    expect(offer).toContain("utils.swaps.countActionable.invalidate()");
    expect(offer).toContain("utils.swaps.listAvailable.invalidate()");
  });

  it("aceite local reconcilia a escala; recusa atualiza somente Trocas", () => {
    const list = readFileSync(
      "components/swaps/AvailableSwapsList.tsx",
      "utf8",
    );
    const acceptBlock = list.slice(
      list.indexOf("const acceptSwap"),
      list.indexOf("const rejectSwap"),
    );
    const rejectBlock = list.slice(
      list.indexOf("const rejectSwap"),
      list.indexOf("const busy"),
    );

    expect(list).toContain("utils.shifts.listAgenda.invalidate()");
    expect(list).toContain("utils.shifts.getNextShift.invalidate()");
    expect(list).toContain("utils.shifts.listByPeriod.invalidate()");
    expect(list).toContain("utils.shifts.get.invalidate()");
    expect(list).toContain("utils.confirmations.getPending.invalidate()");
    expect(acceptBlock).toContain("invalidateAcceptedSwapQueries");
    expect(acceptBlock).toContain("onSuccess: async");
    expect(acceptBlock).toContain("await invalidateAcceptedSwapQueries()");
    expect(rejectBlock).toContain("invalidateSwapQueries");
    expect(rejectBlock).toContain("onSuccess: async");
    expect(rejectBlock).toContain("await invalidateSwapQueries()");
    expect(rejectBlock).not.toContain("invalidateAcceptedSwapQueries");
  });
});
