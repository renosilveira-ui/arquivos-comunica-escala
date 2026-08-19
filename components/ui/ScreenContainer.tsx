import { ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";
import { theme } from "@/lib/theme";

type ScreenContainerProps = {
  children: ReactNode;
  /**
   * Ocupa toda a altura disponível (flex: 1). OBRIGATÓRIO quando um
   * filho é ScrollView/lista com flex: 1 (ex.: Agenda): sem isso, no
   * NATIVO o container tem altura automática e o ScrollView interno
   * colapsa para altura ZERO — a lista "some" sem erro nenhum. No web
   * o layout de página disfarça, por isso o bug só aparecia no iPhone.
   */
  flex?: boolean;
  /**
   * Web/desktop: a TELA INTEIRA vira uma página rolável (cabeçalho rola
   * junto com o conteúdo), em vez de frame fixo com rolador interno
   * apertado — "não consigo rolar a tela" no desktop. No nativo é
   * tratado como flex (o frame app-like é o correto lá).
   */
  scrollPage?: boolean;
};

/**
 * Centers web content and keeps mobile full-width.
 */
export function ScreenContainer({ children, flex = false, scrollPage = false }: ScreenContainerProps) {
  if (Platform.OS === "web" && scrollPage) {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ width: "100%", alignItems: "center" }}
        showsVerticalScrollIndicator={false}
      >
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
      </ScrollView>
    );
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
