import { Tabs } from "expo-router";
import { BottomTabBar, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { TabIcon } from "@/components/ui/TabIcon";
import { usePermissions } from "@/hooks/use-permissions";
import { Platform, Pressable, Text, View, useWindowDimensions, type ViewStyle } from "react-native";
import Constants from "expo-constants";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";

function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case "admin":
      return "Administrador";
    case "manager":
      return "Gestor";
    case "doctor":
      return "Médico";
    case "nurse":
      return "Enfermagem";
    case "tech":
      return "Técnico";
    default:
      return "";
  }
}

function WebSidebarTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { user } = useAuth();
  const appVersion = Constants.expoConfig?.version;
  const userInitial = (user?.name?.trim()?.charAt(0) || user?.email?.trim()?.charAt(0) || "?").toUpperCase();

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 220,
        backgroundColor: "#0B1F3A",
        borderRightWidth: 1,
        borderRightColor: "rgba(255,255,255,0.08)",
        paddingTop: 24,
        paddingHorizontal: 12,
      }}
    >
      <Text style={{ color: "#E2E8F0", fontSize: 18, fontWeight: "800", marginBottom: 16, paddingHorizontal: 10 }}>
        Escalas
      </Text>
      <View style={{ gap: 6, flex: 1 }}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          if ((options as any).href === null) return null;
          const focused = state.index === index;
          const label =
            typeof options.tabBarLabel === "string"
              ? options.tabBarLabel
              : typeof options.title === "string"
                ? options.title
                : route.name;
          const color = focused ? "#FFFFFF" : "#BFDBFE";

          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              style={(pressableState) => {
                const hovered = (pressableState as { hovered?: boolean }).hovered === true;
                const itemStyle: ViewStyle = {
                  position: "relative",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  borderRadius: 10,
                  paddingVertical: 10,
                  paddingHorizontal: 10,
                  backgroundColor: focused
                    ? theme.colors.accent
                    : hovered
                      ? "rgba(255,255,255,0.06)"
                      : "transparent",
                };
                if (Platform.OS === "web") {
                  // RN-Web supports `cursor`; RN core types don't include it.
                  (itemStyle as Record<string, unknown>).cursor = "pointer";
                }
                return itemStyle;
              }}
            >
              {focused ? (
                <View
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 3,
                    backgroundColor: "#FFFFFF",
                    borderTopRightRadius: 3,
                    borderBottomRightRadius: 3,
                  }}
                />
              ) : null}
              {options.tabBarIcon?.({ focused, color, size: 18 }) ?? null}
              <Text style={{ color, fontSize: 14, fontWeight: focused ? "700" : "500" }}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      {user ? (
        <View
          style={{
            flexShrink: 0,
            paddingTop: 12,
            paddingBottom: 4,
            paddingHorizontal: 4,
            borderTopWidth: 1,
            borderTopColor: "rgba(255,255,255,0.08)",
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}
        >
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: "rgba(255,255,255,0.12)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "700" }}>{userInitial}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "600" }}
            >
              {user.name ?? user.email ?? "Usuário"}
            </Text>
            {roleLabel(user.role) ? (
              <Text
                numberOfLines={1}
                style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, marginTop: 2 }}
              >
                {roleLabel(user.role)}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {appVersion ? (
        <Text
          style={{
            color: "rgba(255,255,255,0.4)",
            fontSize: 12,
            paddingHorizontal: 4,
            paddingTop: 8,
            paddingBottom: 12,
          }}
        >
          v{appVersion}
        </Text>
      ) : null}
    </View>
  );
}

export default function TabLayout() {
  const { can, isManager } = usePermissions();
  const { width } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web" && width >= 1024;

  return (
    <Tabs
      tabBar={(props) => (isDesktopWeb ? <WebSidebarTabBar {...props} /> : <BottomTabBar {...props} />)}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        sceneStyle: isDesktopWeb
          ? {
              backgroundColor: theme.colors.background,
              paddingLeft: 220,
            }
          : {
              backgroundColor: theme.colors.background,
            },
        tabBarStyle: {
          display: isDesktopWeb ? "none" : "flex",
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          // Redireciona para /calendar (ver app/(tabs)/index.tsx).
          // Mantém a entry para o Expo Router resolver `/` mas esconde
          // a aba do tabBar — o usuário não vê "Início" na barra.
          href: null,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: "Agenda",
          tabBarIcon: ({ color, size }) => <TabIcon name="calendar" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="weekly"
        options={{
          title: "Semanal",
          tabBarIcon: ({ color, size }) => <TabIcon name="weekly" color={color} size={size} />,
          href: can("view:weekly") ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => <TabIcon name="dashboard" color={color} size={size} />,
          href: can("view:dashboard") ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="pending"
        options={{
          // Renomeada de "Pendentes" — cobre solicitações de troca e
          // cessão (não pendências de plantão). Decisão em
          // docs/product/escala-ux.md §3.
          title: "Solicitações",
          href: isManager ? undefined : null,
          tabBarIcon: ({ color, size }) => <TabIcon name="pending" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="vacancies"
        options={{
          // Renomeada de "Vagas" — cobre plantões criados sem
          // profissional alocado. Decisão em docs/product/escala-ux.md §3.
          title: "Plantões em aberto",
          tabBarIcon: ({ color, size }) => <TabIcon name="work" color={color} size={size} />,
          href: can("view:vacancies") ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: "Relatórios",
          tabBarIcon: ({ color, size }) => <TabIcon name="dashboard" color={color} size={size} />,
          href: can("view:reports") ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="admin"
        options={{
          title: "Admin",
          tabBarIcon: ({ color, size }) => <TabIcon name="admin" color={color} size={size} />,
          href: can("view:admin") ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Perfil",
          tabBarIcon: ({ color, size }) => <TabIcon name="profile" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
