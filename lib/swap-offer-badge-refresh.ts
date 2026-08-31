import { isNativeAppSessionVisible } from "./web-session-lifecycle";

export const SWAP_OFFER_PUSH_TITLE = "Plantão disponível";
export const SWAP_OFFER_DEEP_LINK = "/(tabs)/trocas";

export function shouldInvalidateSwapQueriesOnNotification(
  type: unknown,
): boolean {
  return type === "swap_offer" || type === "swap_taken";
}

/**
 * Badge/listAvailable: refetch só no resume nativo (background → visível).
 * Web não usa visibilitychange — #287 / refetchOnWindowFocus global false.
 */
export function shouldRefetchSwapOfferBadgeOnAppStateChange(input: {
  platform: string;
  previousState: string;
  nextState: string;
}): boolean {
  if (input.platform === "web") return false;
  return (
    !isNativeAppSessionVisible(input.previousState) &&
    isNativeAppSessionVisible(input.nextState)
  );
}
