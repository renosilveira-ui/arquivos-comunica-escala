import { ReactNode } from "react";
import { Platform, View } from "react-native";
import { theme } from "@/lib/theme";

type ScreenContainerProps = {
  children: ReactNode;
};

/**
 * Centers web content and keeps mobile full-width.
 */
export function ScreenContainer({ children }: ScreenContainerProps) {
  if (Platform.OS === "web") {
    return (
      <View style={{ width: "100%", alignItems: "center" }}>
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
      </View>
    );
  }

  return <View style={{ gap: theme.spacing.gap }}>{children}</View>;
}
