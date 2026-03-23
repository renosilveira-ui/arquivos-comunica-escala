import { useState } from "react";
import { Slot } from "expo-router";
import { View, TouchableOpacity, useWindowDimensions, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Menu } from "lucide-react-native";
import { Sidebar } from "@/components/ui/Sidebar";
import { theme } from "@/lib/theme";

export default function TabLayout() {
  const { width } = useWindowDimensions();
  const isWideWeb = Platform.OS === "web" && width >= 1024;
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={["top", "left", "right"]}>
      <View style={{ flex: 1, flexDirection: "row" }}>
        {isWideWeb && <Sidebar />}

        <View style={{ flex: 1 }}>
          {!isWideWeb && (
            <View
              style={{
                height: 56,
                flexDirection: "row",
                alignItems: "center",
                borderBottomWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.card,
                paddingHorizontal: 16,
              }}
            >
              <TouchableOpacity
                onPress={() => setDrawerOpen((prev) => !prev)}
                activeOpacity={0.8}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.colors.primaryNavy,
                }}
              >
                <Menu size={20} color="#0F172A" />
              </TouchableOpacity>
            </View>
          )}

          <Slot />
        </View>

        {!isWideWeb && drawerOpen && (
          <>
            <View
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(2,6,23,0.25)",
              }}
              onTouchEnd={() => setDrawerOpen(false)}
            />
            <View style={{ position: "absolute", top: 0, left: 0, bottom: 0 }}>
              <Sidebar />
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
