// lib/theme-provider.tsx — Provider de tema (light/dark) para o app
import React, { createContext, useContext, useEffect, useState } from "react";
import { useColorScheme } from "react-native";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [theme, setTheme] = useState<Theme>("system");

  // Explicit narrowing: useColorScheme() returns ColorSchemeName which newer
  // @types/react-native widens beyond "light" | "dark" | null | undefined.
  // Comparing against "dark" produces a literal "light" | "dark" assignable
  // to resolvedTheme regardless of which version of the types is in use.
  const resolvedTheme: "light" | "dark" =
    theme === "system"
      ? systemColorScheme === "dark"
        ? "dark"
        : "light"
      : theme;

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
