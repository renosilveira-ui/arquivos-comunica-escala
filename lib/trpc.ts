// lib/trpc.ts — Client-side tRPC com hooks para React Native
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import superjson from "superjson";
import { Platform } from "react-native";
import * as Auth from "@/lib/_core/auth";
import { getApiBaseUrl } from "@/lib/_core/api";
import { getActiveInstitutionId } from "@/lib/tenant-state";
import type { AppRouter } from "@/server/routers";

export const trpc = createTRPCReact<AppRouter>();


export function createTRPCClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${getApiBaseUrl()}/api/trpc`,
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
