import { Tabs } from "expo-router";
import { BottomTabBar, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { TabIcon } from "@/components/ui/TabIcon";
import { usePermissions } from "@/hooks/use-permissions";
import { Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { theme } from "@/lib/theme";

function WebSidebarTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
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
      <View style={{ gap: 6 }}>
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
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                borderRadius: 10,
                paddingVertical: 10,
                paddingHorizontal: 10,
                backgroundColor: focused ? theme.colors.accent : "transparent",
              }}
            >
              {options.tabBarIcon?.({ focused, color, size: 18 }) ?? null}
              <Text style={{ color, fontSize: 14, fontWeight: focused ? "700" : "500" }}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
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
          title: "Início",
          tabBarIcon: ({ color, size }) => <TabIcon name="home" color={color} size={size} />,
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
          title: "Pendentes",
          href: isManager ? undefined : null,
          tabBarIcon: ({ color, size }) => <TabIcon name="pending" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="vacancies"
        options={{
          title: "Vagas",
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
