import {
  transitionTenantAuthorizationActivity,
  type TenantAuthorizationActivity,
} from "./tenant-authorization";

/**
 * Eventos de ciclo de vida da aba/página no desktop. Nenhum deles é
 * background nativo: esconder a aba, freeze do Chrome ou bfcache não
 * autorizam CLOSE do gate nem um `/me` que possa encerrar a sessão.
 */
export const WEB_TAB_LIFECYCLE_EVENTS = [
  "visibilitychange",
  "pagehide",
  "pageshow",
  "freeze",
  "resume",
] as const;

export function shouldAttachNativeSessionGateLifecycle(
  platform: string,
): boolean {
  return platform !== "web";
}

export function initialTenantAuthorizationActivityForPlatform(
  platform: string,
  native: Pick<TenantAuthorizationActivity, "visible" | "online">,
): TenantAuthorizationActivity {
  if (platform === "web") {
    return { visible: true, online: true, revision: 0 };
  }
  return {
    visible: native.visible,
    online: native.online,
    revision: 0,
  };
}

/**
 * No web o lifecycle da aba e flaps de NetInfo/online nunca movem o gate.
 * Background nativo continua CLOSE; reconnect nativo continua REVALIDATE.
 */
export function applyTenantAuthorizationActivityPatch(
  current: TenantAuthorizationActivity,
  patch: Partial<Pick<TenantAuthorizationActivity, "visible" | "online">>,
  platform: string,
): ReturnType<typeof transitionTenantAuthorizationActivity> {
  if (platform === "web") {
    return { state: current, action: "NONE" };
  }
  return transitionTenantAuthorizationActivity(current, patch);
}
