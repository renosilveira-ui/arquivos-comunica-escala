import { Tabs } from "expo-router";
import { TabIcon } from "@/components/ui/TabIcon";
import { usePermissions } from "@/hooks/use-permissions";

export default function TabLayout() {
  const { can } = usePermissions();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#60A5FA",
        tabBarInactiveTintColor: "#6B7280",
        tabBarStyle: {
          backgroundColor: "#111827",
          borderTopColor: "#1F2937",
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
