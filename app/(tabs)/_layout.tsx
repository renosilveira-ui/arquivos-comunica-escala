import { Tabs } from "expo-router";
import { type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { TabIcon } from "@/components/ui/TabIcon";
import { MobileTabBar } from "@/components/ui/MobileTabBar";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { Platform, Pressable, Text, View, useWindowDimensions, type ViewStyle } from "react-native";
import Constants from "expo-constants";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { profileRoleBadgeLabel } from "@/lib/institution-roles";

function navigationBadgeValue(count: number): string | number | undefined {
  if (count <= 0) return undefined;
  return count > 9 ? "9+" : count;
}

function WebSidebarTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { user } = useAuth();
  const { isGlobalAdmin, roleInInstitution } = usePermissions();
  const appVersion = Constants.expoConfig?.version;
  const userInitial = (user?.name?.trim()?.charAt(0) || user?.email?.trim()?.charAt(0) || "?").toUpperCase();
  const sidebarRoleLabel = profileRoleBadgeLabel({
    isGlobalAdmin,
    roleInInstitution,
    legacyGlobalRole: user?.role,
  });
  const hiddenRoutes = new Set(["index", "calendar", "weekly"]);

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 220,
        backgroundColor: theme.colors.sidebarBg,
        borderRightWidth: 1,
        borderRightColor: theme.colors.onDark.divider,
        paddingTop: theme.space[6],
        paddingHorizontal: theme.space[3],
      }}
    >
      {/* Brand. Logo PNG tem fundo claro — em sidebar dark fica
          contraste forte se usada direto. Usamos wordmark "Escala+"
          no dark; logo gráfica fica reservada pra login/splash sobre
          gradiente claro. */}
      <View
        style={{
          marginBottom: theme.space[5],
          paddingHorizontal: theme.space[2] + 2,
          flexDirection: "row",
          alignItems: "baseline",
          gap: 2,
        }}
      >
        <Text style={{ color: theme.colors.onDark.text, fontSize: 22, fontWeight: "800", letterSpacing: -0.5 }}>
          Escala
        </Text>
        <Text style={{ color: theme.colors.primary, fontSize: 24, fontWeight: "800" }}>
          +
        </Text>
      </View>
      <View style={{ gap: 6, flex: 1 }}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          if ((options as any).href === null || hiddenRoutes.has(route.name)) return null;
          const focused = state.index === index;
          const label =
            typeof options.tabBarLabel === "string"
              ? options.tabBarLabel
              : typeof options.title === "string"
                ? options.title
                : route.name;
          const badge = options.tabBarBadge;
          const badgeLabel =
            badge !== undefined && badge !== null
              ? `${label}, ${badge} pendência${Number(badge) === 1 ? "" : "s"}`
              : label;
          const color = focused ? theme.colors.onDark.text : theme.colors.onDark.textInactive;

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
              accessibilityRole="button"
              accessibilityLabel={badgeLabel}
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
                    ? theme.colors.primary
                    : hovered
                      ? theme.colors.onDark.hover
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
                    backgroundColor: theme.colors.onDark.text,
                    borderTopRightRadius: 3,
                    borderBottomRightRadius: 3,
                  }}
                />
              ) : null}
              {options.tabBarIcon?.({ focused, color, size: 18 }) ?? null}
              <Text style={{ color, fontSize: 14, fontWeight: focused ? "700" : "500", flex: 1 }}>{label}</Text>
              {badge !== undefined && badge !== null ? (
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={{
                    minWidth: theme.space[4],
                    height: theme.space[4],
                    paddingHorizontal: theme.space[1],
                    borderRadius: theme.radius.full,
                    backgroundColor: theme.colors.danger,
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
            </Pressable>
          );
        })}
      </View>

      {user ? (
        <View
          style={{
            flexShrink: 0,
            paddingTop: theme.space[3],
            paddingBottom: theme.space[1],
            paddingHorizontal: theme.space[1],
            borderTopWidth: 1,
            borderTopColor: theme.colors.onDark.divider,
            flexDirection: "row",
            alignItems: "center",
            gap: theme.space[2] + 2,
          }}
        >
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: theme.colors.onDark.surface,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: theme.colors.onDark.text, fontSize: 14, fontWeight: "700" }}>{userInitial}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              style={{ color: theme.colors.onDark.text, fontSize: 13, fontWeight: "600" }}
            >
              {user.name ?? user.email ?? "Usuário"}
            </Text>
            {sidebarRoleLabel ? (
              <Text
                numberOfLines={1}
                style={{ color: theme.colors.onDark.textMuted, fontSize: 11, marginTop: 2 }}
              >
                {sidebarRoleLabel}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {appVersion ? (
        <Text
          style={{
            color: theme.colors.onDark.textMuted,
            fontSize: 12,
            paddingHorizontal: theme.space[1],
            paddingTop: theme.space[2],
            paddingBottom: theme.space[3],
          }}
        >
          v{appVersion}
        </Text>
      ) : null}
    </View>
  );
}

export default function TabLayout() {
  const { can, isManager, canApproveAssignments } = usePermissions();
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web" && width >= 1024;
  // Barra inferior (celular) = experiência do plantonista, para todo
  // papel: Agenda · Trocas · Vagas · Perfil. Painel, Solicitações, Relatórios
  // e Admin ficam na sidebar do desktop e, no celular, em Perfil → Gestão.
  // O Expo Router remove `href` das options do tabBar customizado — a
  // allowlist em MobileTabBar é o que impede as 8 abas. Decisão do PO em
  // 2026-08-22.
  const showManagementTabs = isDesktopWeb;
  const showTrocasTab = !isDesktopWeb || !isManager;
  const { data: actionableSwapCount } = trpc.swaps.countActionable.useQuery(undefined, {
    enabled: !!user?.id,
    staleTime: 60_000,
  });
  const swapOffersPending = actionableSwapCount?.swapOffers ?? 0;
  const swapBadge = navigationBadgeValue(swapOffersPending);
  const trocasTabBadge = showTrocasTab ? swapBadge : undefined;
  // Desktop gestor: Trocas oculta; aceitar/recusar fica em Solicitações
  // (pending.tsx → AvailableSwapsList, fluxo peer A↔B — não approveByManager).
  const pendingTabBadge =
    showManagementTabs && canApproveAssignments && !showTrocasTab ? swapBadge : undefined;
  const attentionBadgeStyle = {
    backgroundColor: theme.colors.danger,
    color: theme.colors.onDark.text,
  } as const;

  return (
    <Tabs
      tabBar={(props) =>
        isDesktopWeb ? <WebSidebarTabBar {...props} /> : <MobileTabBar {...props} />
      }
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
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
          // Redireciona para /agenda (ver app/(tabs)/index.tsx).
          // Mantém a entry para o Expo Router resolver `/` mas esconde
          // a aba do tabBar — o usuário não vê "Início" na barra.
          href: null,
        }}
      />
      <Tabs.Screen
        name="agenda"
        options={{
          // Tela unificada (substitui Calendar + Weekly).
          title: "Agenda",
          tabBarIcon: ({ color, size }) => <TabIcon name="calendar" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="trocas"
        options={{
          // Médico: porta de entrada para aceitar/oferecer trocas (antes só
          // via atalho do Panorama; "Minhas ofertas" ficava no Perfil).
          // No desktop o gestor vê o mesmo conteúdo dentro de Solicitações;
          // no celular todo mundo tem a aba.
          title: "Trocas",
          href: showTrocasTab ? undefined : null,
          tabBarIcon: ({ color, size }) => <TabIcon name="swap" color={color} size={size} />,
          tabBarBadge: trocasTabBadge,
          tabBarBadgeStyle: attentionBadgeStyle,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          // Rota legada — agora apenas redireciona para /agenda. Não
          // aparece no tabBar.
          href: null,
        }}
      />
      <Tabs.Screen
        name="weekly"
        options={{
          // Rota legada — agora apenas redireciona para /agenda. Não
          // aparece no tabBar.
          href: null,
        }}
      />
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Painel",
          tabBarIcon: ({ color, size }) => <TabIcon name="dashboard" color={color} size={size} />,
          href: showManagementTabs && can("view:dashboard") ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="pending"
        options={{
          // Renomeada de "Pendentes" — cobre solicitações de troca e
          // cessão (não pendências de plantão). Decisão em
          // docs/product/escala-ux.md §3.
          title: "Solicitações",
          href: showManagementTabs && canApproveAssignments ? undefined : null,
          tabBarIcon: ({ color, size }) => <TabIcon name="pending" color={color} size={size} />,
          tabBarBadge: pendingTabBadge,
          tabBarBadgeStyle: attentionBadgeStyle,
        }}
      />
      <Tabs.Screen
        name="vacancies"
        options={{
          // Renomeada de "Vagas" — cobre plantões criados sem
          // profissional alocado. Decisão em docs/product/escala-ux.md §3.
          // Rótulo de aba de UMA palavra (18 caracteres truncavam no iPhone);
          // o título completo fica no cabeçalho da tela.
          title: "Vagas",
          tabBarIcon: ({ color, size }) => <TabIcon name="work" color={color} size={size} />,
          href: can("view:vacancies") ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: "Relatórios",
          tabBarIcon: ({ color, size }) => <TabIcon name="reports" color={color} size={size} />,
          // Escondida da barra até ter conteúdo real (hoje é placeholder);
          // a rota continua acessível por link direto.
          href: null,
        }}
      />
      <Tabs.Screen
        name="admin"
        options={{
          title: "Admin",
          tabBarIcon: ({ color, size }) => <TabIcon name="admin" color={color} size={size} />,
          href: showManagementTabs && can("view:admin") ? undefined : null,
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
