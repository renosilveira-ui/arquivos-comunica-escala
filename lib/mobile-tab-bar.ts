// Destinos da barra do celular. O Expo Router tira `href` das options e
// só marca `tabBarItemStyle.display = "none"` — filtrar por href deixa
// Painel, Solicitações, Relatórios e Admin vazarem.

export const MOBILE_TAB_NAMES = [
  "agenda",
  "trocas",
  "vacancies",
  "profile",
] as const;

export type MobileTabName = (typeof MOBILE_TAB_NAMES)[number];

const MOBILE_TAB_NAME_SET = new Set<string>(MOBILE_TAB_NAMES);

export type MobileTabRouteOption = Readonly<{
  href?: unknown;
  tabBarItemStyle?: Readonly<{ display?: string }> | unknown;
}>;

export function isHiddenByNavigator(options: MobileTabRouteOption): boolean {
  if (options.href === null) return true;
  const itemStyle = options.tabBarItemStyle;
  if (
    itemStyle &&
    typeof itemStyle === "object" &&
    "display" in itemStyle &&
    itemStyle.display === "none"
  ) {
    return true;
  }
  return false;
}

export function visibleMobileTabNames(
  routes: readonly Readonly<{ name: string }>[],
  optionsByName: Readonly<Record<string, MobileTabRouteOption>>,
): MobileTabName[] {
  return routes
    .filter((route) => {
      if (!MOBILE_TAB_NAME_SET.has(route.name)) return false;
      return !isHiddenByNavigator(optionsByName[route.name] ?? {});
    })
    .map((route) => route.name as MobileTabName);
}
