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

/**
 * Android dispara `inactive` no seletor de apps, overlay de notificação e
 * transição de Activity. Tratar isso como hidden fechava o gate, limpava o
 * cache e — com flap de NetInfo — disparava um `/me` que expulsava o
 * usuário para o login. Só `background` é ausência real do app.
 */
export function isNativeAppSessionVisible(appState: string): boolean {
  return appState !== "background";
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
