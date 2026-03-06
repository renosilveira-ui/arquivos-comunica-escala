// lib/trpc.ts — Client-side tRPC com hooks para React Native
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import superjson from "superjson";
import { Platform } from "react-native";

// Para typecheck do client, precisamos do tipo AppRouter do server.
// Quando o server/routers.ts estiver completo, substituir por:
//   import type { AppRouter } from "@/server/routers";
//   export const trpc = createTRPCReact<AppRouter>();
//
// Por enquanto, usamos createTRPCReact sem tipo específico.
// O "as any" silencia erros de tipo nas chamadas trpc.X.useQuery(...)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const trpc = createTRPCReact<any>() as any;

function getBaseUrl(): string {
  // 1) Variável de ambiente explícita (útil pra staging/prod)
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) return envUrl;

  // 2) Dev defaults por plataforma
  if (Platform.OS === "android") {
    // Emulador Android usa 10.0.2.2 para acessar localhost do host
    return "http://10.0.2.2:3000";
  }
  // iOS simulator e web usam localhost
  return "http://localhost:3000";
}

export function createTRPCClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${getBaseUrl()}/api/trpc`,
        transformer: superjson,
        headers() {
          return {
            // Cookies são enviados automaticamente na web.
            // Em native, adicionar token aqui se necessário.
          };
        },
      }),
    ],
  });
}
