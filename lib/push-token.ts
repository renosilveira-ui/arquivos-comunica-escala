// lib/push-token.ts — token de push do aparelho na sessão atual.
//
// Guardado em memória quando o registro acontece (hooks/use-notifications)
// para o logout conseguir DESREGISTRAR o token no servidor: sem isso o
// aparelho continuava recebendo push do usuário anterior.
let lastPushToken: string | null = null;

export function setLastPushToken(token: string | null): void {
  lastPushToken = token;
}

export function getLastPushToken(): string | null {
  return lastPushToken;
}
