import "@/global.css";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Redirect, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { ActivityIndicator, Platform, View } from "react-native";
import "@/lib/_core/nativewind-pressable";
import { ThemeProvider } from "@/lib/theme-provider";
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
  initialWindowMetrics,
} from "react-native-safe-area-context";
import type { EdgeInsets, Metrics, Rect } from "react-native-safe-area-context";

import { trpc, createTRPCClient } from "@/lib/trpc";
import { initManusRuntime, subscribeSafeAreaInsets } from "@/lib/_core/manus-runtime";
import { TenantStateProvider, useTenantState } from "@/lib/tenant-state";
import { IntegrationManagerProvider } from "@/components/IntegrationManagerProvider";
import { NotificationListener } from "@/components/NotificationListener";
import { useAuth } from "@/hooks/use-auth";

const DEFAULT_WEB_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const DEFAULT_WEB_FRAME: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** Handles auth-gated navigation. Must be rendered inside providers. */
function AuthGuard() {
  const { user, isLoading } = useAuth();
  const pathname = usePathname();
  const {
    activeInstitutionId,
    isHydrating: isHydratingTenant,
    setActiveInstitutionId,
  } = useTenantState();
  const { data: institutions, isLoading: institutionsLoading } =
    trpc.professionals.listMyInstitutions.useQuery(undefined, { enabled: !!user });

  useEffect(() => {
    if (!user || institutionsLoading || !institutions || activeInstitutionId) return;
    if (institutions.length === 1) {
      void setActiveInstitutionId(institutions[0].id);
    }
  }, [activeInstitutionId, institutions, institutionsLoading, setActiveInstitutionId, user]);

  if (
    isLoading ||
    isHydratingTenant ||
    (!!user && institutionsLoading)
  ) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0a1929" }}>
        <ActivityIndicator size="large" color="#4DA3FF" />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/login" />;
  }

  const hasInstitutions = (institutions?.length ?? 0) > 0;
  if (!hasInstitutions) {
    return <Redirect href="/login" />;
  }

  if (!activeInstitutionId && pathname !== "/select-institution") {
    return <Redirect href={"/select-institution" as any} />;
  }

  if (activeInstitutionId && pathname === "/select-institution") {
    return <Redirect href="/(tabs)" />;
  }

  return null;
}

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  const initialInsets = initialWindowMetrics?.insets ?? DEFAULT_WEB_INSETS;
  const initialFrame = initialWindowMetrics?.frame ?? DEFAULT_WEB_FRAME;

  const [insets, setInsets] = useState<EdgeInsets>(initialInsets);
  const [frame, setFrame] = useState<Rect>(initialFrame);

  // Initialize Manus runtime for cookie injection from parent container
  useEffect(() => {
    initManusRuntime();
  }, []);

  const handleSafeAreaUpdate = useCallback((metrics: Metrics) => {
    setInsets(metrics.insets);
    setFrame(metrics.frame);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const unsubscribe = subscribeSafeAreaInsets(handleSafeAreaUpdate);
    return () => unsubscribe();
  }, [handleSafeAreaUpdate]);

  // Create clients once and reuse them
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Disable automatic refetching on window focus for mobile
            refetchOnWindowFocus: false,
            // Retry failed requests once
            retry: 1,
          },
        },
      }),
  );
  const [trpcClient] = useState(() => createTRPCClient());

  // Ensure minimum 8px padding for top and bottom on mobile
  const providerInitialMetrics = useMemo(() => {
    const metrics = initialWindowMetrics ?? { insets: initialInsets, frame: initialFrame };
    return {
      ...metrics,
      insets: {
        ...metrics.insets,
        top: Math.max(metrics.insets.top, 16),
        bottom: Math.max(metrics.insets.bottom, 12),
      },
    };
  }, [initialInsets, initialFrame]);

  const content = (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <TenantStateProvider>
            <IntegrationManagerProvider>
          {/* Default to hiding native headers so raw route segments don't appear (e.g. "(tabs)", "products/[id]"). */}
          {/* If a screen needs the native header, explicitly enable it and set a human title via Stack.Screen options. */}
          {/* in order for ios apps tab switching to work properly, use presentation: "fullScreenModal" for login page, whenever you decide to use presentation: "modal*/}
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="login" options={{ presentation: "fullScreenModal", animation: "fade" }} />
            <Stack.Screen name="select-institution" options={{ presentation: "fullScreenModal", animation: "fade" }} />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="oauth/callback" />
          </Stack>
          <AuthGuard />
          <StatusBar style="auto" />
          <NotificationListener />
            </IntegrationManagerProvider>
          </TenantStateProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </GestureHandlerRootView>
  );

  const shouldOverrideSafeArea = Platform.OS === "web";

  if (shouldOverrideSafeArea) {
    return (
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={providerInitialMetrics}>
          <SafeAreaFrameContext.Provider value={frame}>
            <SafeAreaInsetsContext.Provider value={insets}>
              {content}
            </SafeAreaInsetsContext.Provider>
          </SafeAreaFrameContext.Provider>
        </SafeAreaProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={providerInitialMetrics}>{content}</SafeAreaProvider>
    </ThemeProvider>
  );
}
