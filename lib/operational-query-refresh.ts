export type OperationalTenantSnapshot = Readonly<{
  institutionId: number | null;
  revision: number;
}>;

/**
 * O reconnect automático é propositalmente exclusivo do aplicativo nativo.
 * No web, foco/reconnect global já causaram revalidação de sessão indevida.
 */
export function shouldRefreshOperationalQueriesOnNativeReconnect(input: {
  platform: string;
  wasExplicitlyOffline: boolean;
  isOnline: boolean;
}): boolean {
  return (
    input.platform !== "web" && input.wasExplicitlyOffline && input.isOnline
  );
}

/** Foco de aba é uma reconciliação local; web permanece fora deste fluxo. */
export function shouldRefreshOperationalQueriesOnNativeFocus(input: {
  platform: string;
  hasFocusedBefore: boolean;
}): boolean {
  return input.platform !== "web" && input.hasFocusedBefore;
}

/**
 * A abertura do aplicativo é tolerante a reachability desconhecida, mas a
 * recuperação de uma tela operacional precisa reconhecer Wi-Fi associado sem
 * internet. `null` continua inconclusivo — nunca é tratado como offline.
 */
export function isOperationalNetworkOnline(state: {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

/**
 * A invalidação de cache não é autoridade. Ela só pode começar quando a
 * sessão continua provada e o snapshot que montou a tela ainda é o tenant
 * publicado pelo módulo. A troca A→B fecha esta guarda antes do rerender.
 */
export function isCurrentOperationalQueryContext(input: {
  userId: number | null | undefined;
  sessionAuthorized: boolean;
  expectedTenant: OperationalTenantSnapshot;
  currentTenant: OperationalTenantSnapshot;
}): boolean {
  return (
    typeof input.userId === "number" &&
    input.userId > 0 &&
    input.sessionAuthorized &&
    input.expectedTenant.institutionId !== null &&
    input.expectedTenant.institutionId === input.currentTenant.institutionId &&
    input.expectedTenant.revision === input.currentTenant.revision
  );
}
