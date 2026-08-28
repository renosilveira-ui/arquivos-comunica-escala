// Barra inferior do celular: abas do plantonista com o comando de voz
// no centro, elevado. Desktop continua na sidebar.

import { type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { VoiceCommandButton } from "@/components/VoiceCommandButton";
import { theme } from "@/lib/theme";

const HIDDEN_ROUTES = new Set(["index", "calendar", "weekly"]);

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
    if (HIDDEN_ROUTES.has(route.name)) return false;
    return (descriptors[route.key].options as { href?: unknown }).href !== null;
  });
  const mid = Math.ceil(visible.length / 2);
  const left = visible.slice(0, mid);
  const right = visible.slice(mid);
  const showVoice = Platform.OS !== "web";

  const renderTab = (route: (typeof visible)[number]) => {
    const index = state.routes.findIndex((candidate) => candidate.key === route.key);
    const { options } = descriptors[route.key];
    const focused = state.index === index;
    const label = tabLabel(options, route.name);
    const color = focused ? theme.colors.primary : theme.colors.textMuted;
    const badge = options.tabBarBadge;

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
        accessibilityLabel={label}
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
                backgroundColor: theme.colors.primary,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  ...theme.text.caption,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.onDark.text,
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
  };

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingBottom: Math.max(insets.bottom, theme.space[2]),
        paddingTop: theme.space[5],
        overflow: "visible",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
        {left.map(renderTab)}
        {showVoice ? <VoiceCommandButton variant="tab" /> : null}
        {right.map(renderTab)}
      </View>
    </View>
  );
}
