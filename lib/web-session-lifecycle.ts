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
 * Só o nativo revalida `/me` ao voltar do segundo plano. A aba web já é
 * tratada em #287: foco/visibility jamais disparam esse pedido.
 */
export function shouldSoftRevalidateNativeSessionOnForeground(
  platform: string,
): boolean {
  return platform !== "web";
}

/**
 * Android dispara `inactive` no seletor de apps, overlay de notificação e
 * transição de Activity. Só `background` é ausência real do app — e mesmo
 * assim não fecha o gate: limpar cache/desmontar o Stack no segundo plano
 * mandava o médico ao login, enquanto o force-close relogava do disco.
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
    visible: true,
    online: native.online,
    revision: 0,
  };
}

/**
 * Nem a aba web nem o segundo plano nativo movem o gate. CLOSE/clear no
 * background desmontava o navigator e o médico via login; a revogação real
 * continua no `/me` soft do resume e no 401 do tRPC.
 */
export function applyTenantAuthorizationActivityPatch(
  current: TenantAuthorizationActivity,
  _patch: Partial<Pick<TenantAuthorizationActivity, "visible" | "online">>,
  _platform: string,
): ReturnType<typeof transitionTenantAuthorizationActivity> {
  return { state: current, action: "NONE" };
}
