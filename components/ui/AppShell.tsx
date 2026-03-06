import { View, Platform, useWindowDimensions } from "react-native";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useState, useEffect, ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface AppShellProps {
  children: ReactNode;
  title?: string;
}

const SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";

export function AppShell({ children, title }: AppShellProps) {
  const { width } = useWindowDimensions();
  const [collapsed, setCollapsed] = useState(false); // Default: expandida
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Determinar breakpoint
  // No web, sempre usar layout desktop (sidebar fixa)
  // No mobile nativo, usar drawer
  const isMobile = Platform.OS !== "web";

  // Buscar contadores para badges
  const { data: counts } = trpc.filters.summaryCounts.useQuery(
    {
      date: new Date().toISOString().split("T")[0], // Hoje
    },
    {
      staleTime: 60 * 1000, // Cache de 60 segundos
    }
  );

  // Carregar estado do localStorage ao montar
  useEffect(() => {
    const loadCollapsedState = async () => {
      try {
        const stored = await AsyncStorage.getItem(SIDEBAR_COLLAPSED_KEY);
        if (stored !== null) {
          setCollapsed(stored === "true");
        }
      } catch (error) {
        console.error("Failed to load sidebar state:", error);
      }
    };
    loadCollapsedState();
  }, []);

  // Salvar estado no localStorage ao mudar
  const handleToggle = async () => {
    const newCollapsed = !collapsed;
    setCollapsed(newCollapsed);
    try {
      await AsyncStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(newCollapsed));
    } catch (error) {
      console.error("Failed to save sidebar state:", error);
    }
  };

  const handleMobileMenuToggle = () => {
    setMobileMenuOpen(!mobileMenuOpen);
  };

  // Mobile: drawer overlay
  if (isMobile) {
    return (
      <View className="flex-1 bg-[#0A1220]">
        <TopBar onMenuToggle={handleMobileMenuToggle} title={title} />
        <View className="flex-1">{children}</View>

        {/* Drawer overlay */}
        {mobileMenuOpen && (
          <>
            {/* Backdrop */}
            <View
              className="absolute inset-0 bg-black/50"
              onTouchEnd={handleMobileMenuToggle}
            />
            {/* Sidebar */}
            <View className="absolute left-0 top-0 bottom-0 w-64">
              <Sidebar
                collapsed={false}
                onToggle={handleMobileMenuToggle}
                counts={counts}
              />
            </View>
          </>
        )}
      </View>
    );
  }

  // Desktop/Tablet: sidebar lateral fixa
  return (
    <View className="flex-1 flex-row bg-[#0A1220]">
      {/* Sidebar */}
      <Sidebar collapsed={collapsed} onToggle={handleToggle} counts={counts} />

      {/* Main content */}
      <View className="flex-1">
        <TopBar onMenuToggle={handleToggle} title={title} />
        <View className="flex-1">{children}</View>
      </View>
    </View>
  );
}
