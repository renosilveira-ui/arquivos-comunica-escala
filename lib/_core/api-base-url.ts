import { Platform } from "react-native";

export function getApiBaseUrl(): string {
  const envUrl = (process.env.EXPO_PUBLIC_API_URL ?? "").trim();

  if (Platform.OS === "web" && (!envUrl || envUrl === "/")) {
    return "";
  }

  if (envUrl) return envUrl.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") {
    throw new Error("EXPO_PUBLIC_API_URL não configurado em produção");
  }

  const fallbackPort = (process.env.EXPO_PUBLIC_API_PORT || "3000").trim();
  if (Platform.OS === "android") return `http://10.0.2.2:${fallbackPort}`;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${fallbackPort}`;
  }
  return `http://localhost:${fallbackPort}`;
}
