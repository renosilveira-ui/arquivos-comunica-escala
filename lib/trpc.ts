// lib/trpc.ts — Client-side tRPC com hooks para React Native
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import superjson from "superjson";
import { Platform } from "react-native";
import * as Auth from "@/lib/_core/auth";
import { getActiveInstitutionId } from "@/lib/tenant-state";
import type { AppRouter } from "@/server/routers";

export const trpc = createTRPCReact<AppRouter>();

function getBaseUrl(): string {
  const envUrl = (process.env.EXPO_PUBLIC_API_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") {
    throw new Error("EXPO_PUBLIC_API_URL não configurado em produção");
  }

  // Fallback de desenvolvimento apenas.
  const fallbackPort = (process.env.EXPO_PUBLIC_API_PORT || "3000").trim();
  if (Platform.OS === "android") return `http://10.0.2.2:${fallbackPort}`;
  return `http://localhost:${fallbackPort}`;
}

export function createTRPCClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${getBaseUrl()}/api/trpc`,
        transformer: superjson,
        async headers() {
          const headers: Record<string, string> = {};
          const activeInstitutionId = await getActiveInstitutionId();
          if (activeInstitutionId) {
            headers["x-tenant-id"] = String(activeInstitutionId);
          }
          if (Platform.OS !== "web") {
            const token = await Auth.getSessionToken();
            if (token) headers.Authorization = `Bearer ${token}`;
          }
          return headers;
        },
        fetch(url, options) {
          return fetch(url, {
            ...options,
            credentials: Platform.OS === "web" ? "include" : undefined,
          });
        },
      }),
    ],
  });
}
