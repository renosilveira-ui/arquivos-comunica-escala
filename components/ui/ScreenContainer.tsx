import { ReactNode } from "react";
import { Platform, View } from "react-native";
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
};

/**
 * Centers web content and keeps mobile full-width.
 */
export function ScreenContainer({ children, flex = false }: ScreenContainerProps) {
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
