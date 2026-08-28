import { type ReactElement, type ReactNode } from "react";
import { Platform, ScrollView, View, type RefreshControlProps } from "react-native";
import { theme } from "@/lib/theme";

type ScreenContainerProps = {
  children: ReactNode;
  /**
   * Ocupa toda a altura disponível (flex: 1). OBRIGATÓRIO quando um
   * filho é ScrollView/lista com flex: 1 (ex.: Agenda em Lista): sem
   * isso, no NATIVO o container tem altura automática e o ScrollView
   * interno colapsa para altura ZERO — a lista "some" sem erro nenhum.
   */
  flex?: boolean;
  /**
   * A tela inteira vira página rolável (cabeçalho rola com o conteúdo).
   * No Panorama do celular isso é obrigatório: a folha de mês com
   * ScrollView flex:1 dentro de um pai sem altura some no iPhone.
   */
  scrollPage?: boolean;
  refreshControl?: ReactElement<RefreshControlProps>;
};

/**
 * Centers web content and keeps mobile full-width.
 */
export function ScreenContainer({
  children,
  flex = false,
  scrollPage = false,
  refreshControl,
}: ScreenContainerProps) {
  if (scrollPage) {
    const page = (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={
          Platform.OS === "web"
            ? { width: "100%", alignItems: "center" }
            : { flexGrow: 1 }
        }
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
      >
        {Platform.OS === "web" ? (
          <View
            style={{
              width: "100%",
              maxWidth: theme.spacing.contentMaxWidth,
              paddingHorizontal: theme.spacing.screenPadding,
              paddingVertical: 20,
            }}
          >
            {children}
          </View>
        ) : (
          children
        )}
      </ScrollView>
    );
    return page;
  }

  if (Platform.OS === "web") {
    return (
      <View style={{ width: "100%", alignItems: "center", ...(flex ? { flex: 1 } : {}) }}>
        <View
          style={{
            width: "100%",
            maxWidth: theme.spacing.contentMaxWidth,
            paddingHorizontal: theme.spacing.screenPadding,
            paddingVertical: 20,
            ...(flex ? { flex: 1 } : {}),
          }}
        >
          {children}
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: theme.spacing.gap, ...(flex ? { flex: 1 } : {}) }}>
      {children}
    </View>
  );
}
