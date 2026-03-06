import { View, ScrollView, type ViewProps } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { cn } from "@/lib/utils";

export interface ScreenProps extends ViewProps {
  /**
   * SafeArea edges to apply. Defaults to ["top", "left", "right"].
   */
  edges?: Edge[];
  /**
   * Tailwind className for the content area.
   */
  className?: string;
  /**
   * Enable ScrollView wrapper
   */
  scrollable?: boolean;
  /**
   * Children elements
   */
  children?: React.ReactNode;
}

/**
 * Screen component - Wrapper padrão para telas
 * Background bg-bg, padding px-5 pt-4
 */
export function Screen({
  children,
  edges = ["top", "left", "right"],
  className,
  scrollable = false,
  style,
  ...props
}: ScreenProps) {
  const content = (
    <View
      className={cn("flex-1 bg-bg", className)}
      style={style}
      {...props}
    >
      {children}
    </View>
  );

  if (scrollable) {
    return (
      <SafeAreaView edges={edges} className="flex-1 bg-bg">
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={edges} className="flex-1 bg-bg">
      {content}
    </SafeAreaView>
  );
}
