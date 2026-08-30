// Barra inferior do celular: só as 4 abas do plantonista
// (Agenda · Trocas · Vagas · Perfil). O Expo Router converte `href: null`
// em `tabBarButton` e tira o `href` das options — filtrar por href deixa
// Painel, Solicitações, Relatórios e Admin vazarem (8 ícones). A allowlist
// é a guarda. Voz fica sobreposta no centro, sem quinto slot.

import { type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { VoiceCommandButton } from "@/components/VoiceCommandButton";
import { isHiddenByNavigator, MOBILE_TAB_NAMES } from "@/lib/mobile-tab-bar";
import { theme } from "@/lib/theme";

const MOBILE_TAB_NAME_SET = new Set<string>(MOBILE_TAB_NAMES);

function tabLabel(
  options: BottomTabBarProps["descriptors"][string]["options"],
  fallback: string,
): string {
  if (typeof options.tabBarLabel === "string") return options.tabBarLabel;
  if (typeof options.title === "string") return options.title;
  return fallback;
}

export function MobileTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const visible = state.routes.filter((route) => {
    if (!MOBILE_TAB_NAME_SET.has(route.name)) return false;
    return !isHiddenByNavigator(descriptors[route.key].options);
  });
  const showVoice = Platform.OS !== "web";

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingBottom: Math.max(insets.bottom, theme.space[2]),
        overflow: "visible",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        {visible.map((route) => {
          const index = state.routes.findIndex(
            (candidate) => candidate.key === route.key,
          );
          const { options } = descriptors[route.key];
          const focused = state.index === index;
          const label = tabLabel(options, route.name);
          const color = focused ? theme.colors.primary : theme.colors.textMuted;
          const badge = options.tabBarBadge;
          const badgeStyle = options.tabBarBadgeStyle;
          const badgeBackground =
            badgeStyle && typeof badgeStyle === "object" && "backgroundColor" in badgeStyle
              ? String(badgeStyle.backgroundColor)
              : theme.colors.danger;
          const badgeTextColor =
            badgeStyle && typeof badgeStyle === "object" && "color" in badgeStyle
              ? String(badgeStyle.color)
              : theme.colors.onDark.text;
          const accessibilityLabel =
            badge !== undefined && badge !== null
              ? `${label}, ${badge} pendência${Number(badge) === 1 ? "" : "s"}`
              : label;

          return (
            <Pressable
              key={route.key}
              onPress={() => {
                const event = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!focused && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={accessibilityLabel}
              style={{
                flex: 1,
                minHeight: theme.space[10] + theme.space[1],
                alignItems: "center",
                justifyContent: "center",
                gap: theme.space[1],
                paddingTop: theme.space[1],
              }}
            >
              <View>
                {options.tabBarIcon?.({ focused, color, size: 22 }) ?? null}
                {badge !== undefined && badge !== null ? (
                  <View
                    style={{
                      position: "absolute",
                      top: -theme.space[1],
                      right: -theme.space[2],
                      minWidth: theme.space[4],
                      height: theme.space[4],
                      paddingHorizontal: theme.space[1],
                      borderRadius: theme.radius.full,
                      backgroundColor: badgeBackground,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        ...theme.text.caption,
                        fontWeight: theme.weight.bold,
                        color: badgeTextColor,
                      }}
                    >
                      {String(badge)}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text
                numberOfLines={1}
                style={{
                  ...theme.text.caption,
                  fontWeight: focused ? theme.weight.bold : theme.weight.medium,
                  color,
                }}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {showVoice ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "flex-start",
            paddingTop: theme.space[1],
          }}
        >
          <VoiceCommandButton variant="tab" />
        </View>
      ) : null}
    </View>
  );
}
