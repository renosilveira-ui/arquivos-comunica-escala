/**
 * Componente que escuta notificações push e roteia para a tela correta.
 * Também monta o registro do push token quando há usuário logado.
 */

import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import * as Notifications from "expo-notifications";
import { useAuth } from "@/hooks/use-auth";
import { useNotifications } from "@/hooks/use-notifications";
import { trpc } from "@/lib/trpc";
import {
  getActiveTenantSnapshot,
  useTenantState,
  type ActiveTenantSnapshot,
} from "@/lib/tenant-state";

type NotificationData = Readonly<Record<string, unknown>>;

const MAX_CONSUMED_NOTIFICATION_RESPONSES = 128;
const handledNotificationResponses = new Set<string>();
const inFlightNotificationResponses = new Set<string>();

function notificationResponseKey(
  response: Notifications.NotificationResponse,
): string | null {
  const requestIdentifier = response.notification?.request?.identifier;
  const actionIdentifier = response.actionIdentifier;
  if (
    typeof requestIdentifier !== "string" ||
    requestIdentifier.length === 0 ||
    typeof actionIdentifier !== "string" ||
    actionIdentifier.length === 0
  ) {
    return null;
  }
  return `${requestIdentifier.length}:${requestIdentifier}${actionIdentifier.length}:${actionIdentifier}`;
}

function claimNotificationResponse(key: string): boolean {
  if (
    handledNotificationResponses.has(key) ||
    inFlightNotificationResponses.has(key)
  ) {
    return false;
  }
  inFlightNotificationResponses.add(key);
  return true;
}

function settleNotificationResponse(key: string, handled: boolean): void {
  inFlightNotificationResponses.delete(key);
  if (!handled) return;
  handledNotificationResponses.add(key);
  if (handledNotificationResponses.size > MAX_CONSUMED_NOTIFICATION_RESPONSES) {
    const oldest = handledNotificationResponses.values().next().value;
    if (typeof oldest === "string") handledNotificationResponses.delete(oldest);
  }
}

function markTerminalNotificationResponse(key: string): void {
  settleNotificationResponse(key, true);
}

export type NotificationRoutingDependencies = Readonly<{
  isSessionAuthorizationCurrent: RoutingFence;
  getActiveTenantSnapshot: () => ActiveTenantSnapshot;
  loadAllowedInstitutionIds: () => Promise<readonly number[] | null>;
  setActiveInstitutionId: (institutionId: number) => Promise<void>;
  invalidateQueries: () => Promise<void>;
  navigateToConfirmation: (confirmationToken: string) => void;
  navigateToAgenda: () => void;
  navigateToShiftDetails?: (shiftInstanceId: number) => void;
  openComunica: (
    institutionId: number,
    canNavigate: () => boolean,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; cancelled?: true }>;
}>;

type RoutingFence = () => boolean;

// SSO tem timeout de rede de 15 s; 20 s dá margem para autenticação/JSON sem
// permitir que um tap travado bloqueie indefinidamente toda a sessão.
export const NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS = 20_000;

export type NotificationRoutingScope = Readonly<{
  enqueue: (
    data: NotificationData,
    dependencies: NotificationRoutingDependencies,
  ) => Promise<boolean>;
  invalidate: () => void;
}>;

export type NotificationRoutingCoordinator = Readonly<{
  beginScope: () => NotificationRoutingScope;
}>;

export function parseNotificationInstitutionId(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseNotificationShiftInstanceId(
  value: unknown,
): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function alignNotificationTenant(
  data: NotificationData,
  dependencies: NotificationRoutingDependencies,
  isCurrent: RoutingFence,
): Promise<ActiveTenantSnapshot | null> {
  if (!isCurrent()) return null;
  const targetInstitutionId = parseNotificationInstitutionId(
    data.institutionId,
  );
  if (targetInstitutionId === null) return null;

  const allowedInstitutionIds = await dependencies.loadAllowedInstitutionIds();
  if (!isCurrent() || !allowedInstitutionIds?.includes(targetInstitutionId))
    return null;

  // Memória tenant-bound primeiro, caches depois, rota por último. Assim a
  // tela aberta pelo push A nunca dispara sua consulta ainda sob o tenant B.
  if (
    dependencies.getActiveTenantSnapshot().institutionId !== targetInstitutionId
  ) {
    await dependencies.setActiveInstitutionId(targetInstitutionId);
    if (!isCurrent()) return null;
  }

  const alignedSnapshot = dependencies.getActiveTenantSnapshot();
  if (alignedSnapshot.institutionId !== targetInstitutionId) return null;

  await dependencies.invalidateQueries();
  if (!isCurrent()) return null;

  const currentSnapshot = dependencies.getActiveTenantSnapshot();
  return currentSnapshot.institutionId === alignedSnapshot.institutionId &&
    currentSnapshot.revision === alignedSnapshot.revision
    ? alignedSnapshot
    : null;
}

function isRouteStillCurrent(
  expected: ActiveTenantSnapshot,
  dependencies: NotificationRoutingDependencies,
  isCurrent: RoutingFence,
): boolean {
  if (!isCurrent()) return false;
  const current = dependencies.getActiveTenantSnapshot();
  return (
    current.institutionId === expected.institutionId &&
    current.revision === expected.revision
  );
}

/**
 * Cada sessão do listener recebe uma geração e uma fila serial. Erros de uma
 * resposta são absorvidos com marcador constante e não envenenam a tail.
 */
export function createNotificationRoutingCoordinator(): NotificationRoutingCoordinator {
  let generation = 0;

  return {
    beginScope() {
      const scopeGeneration = ++generation;
      const isCurrent = () => generation === scopeGeneration;
      const itemControllers = new Set<AbortController>();
      // Uma sessão nova nunca herda awaits pendentes da anterior. A geração
      // continua cercando as tasks antigas, mas cada scope tem sua própria
      // fila serial para os taps que pertencem à mesma sessão.
      let tail: Promise<void> = Promise.resolve();

      return {
        enqueue(data, dependencies) {
          let itemActive = true;
          const itemController = new AbortController();
          itemControllers.add(itemController);
          const isItemCurrent = () =>
            itemActive &&
            !itemController.signal.aborted &&
            isCurrent() &&
            dependencies.isSessionAuthorizationCurrent();
          const run = async (): Promise<boolean> => {
            if (!isItemCurrent()) return false;
            try {
              return await routeNotificationData(
                data,
                dependencies,
                isItemCurrent,
                itemController.signal,
              );
            } catch {
              if (isItemCurrent()) {
                console.warn("[NotificationListener] ROUTING_FAILED");
              }
              return false;
            }
          };

          const executeWithDeadline = () => {
            let deadline: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<boolean>((resolve) => {
              deadline = setTimeout(() => {
                // O fence cai antes de liberar a tail: qualquer continuação
                // antiga observa stale e não alcança outro efeito.
                itemActive = false;
                itemController.abort();
                console.warn("[NotificationListener] ROUTING_TIMEOUT");
                resolve(false);
              }, NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS);
            });
            return Promise.race([run(), timedOut]).finally(() => {
              if (deadline !== undefined) clearTimeout(deadline);
              itemControllers.delete(itemController);
            });
          };
          const result = tail.then(executeWithDeadline, executeWithDeadline);
          tail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
        invalidate() {
          if (isCurrent()) generation += 1;
          for (const controller of itemControllers) controller.abort();
          itemControllers.clear();
        },
      };
    },
  };
}

export async function routeNotificationData(
  data: NotificationData,
  dependencies: NotificationRoutingDependencies,
  isCurrent: RoutingFence = () => true,
  signal: AbortSignal = new AbortController().signal,
): Promise<boolean> {
  if (!isCurrent() || typeof data.type !== "string") return false;

  switch (data.type) {
    case "duty_confirmation":
    case "duty_nomination": {
      if (
        typeof data.confirmationToken !== "string" ||
        !data.confirmationToken
      ) {
        return false;
      }
      const alignedSnapshot = await alignNotificationTenant(
        data,
        dependencies,
        isCurrent,
      );
      if (
        !alignedSnapshot ||
        !isRouteStillCurrent(alignedSnapshot, dependencies, isCurrent)
      ) {
        return false;
      }
      // Sem await entre o último snapshot/fence e o efeito de navegação.
      dependencies.navigateToConfirmation(data.confirmationToken);
      return true;
    }

    case "sso_ready": {
      const alignedSnapshot = await alignNotificationTenant(
        data,
        dependencies,
        isCurrent,
      );
      if (
        !alignedSnapshot ||
        !isRouteStillCurrent(alignedSnapshot, dependencies, isCurrent)
      ) {
        return false;
      }
      const canNavigate = () =>
        isRouteStillCurrent(alignedSnapshot, dependencies, isCurrent);
      const result = await dependencies.openComunica(
        alignedSnapshot.institutionId!,
        canNavigate,
        signal,
      );
      if (!canNavigate()) return false;
      if (!result.ok && !result.cancelled) dependencies.navigateToAgenda();
      return result.ok;
    }

    case "duty_auto_confirmed":
    case "manager_confirmation_escalation":
    case "replacement_accepted":
    case "replacement_declined":
    case "shift_reminder": {
      const shiftInstanceId = parseNotificationShiftInstanceId(
        data.shiftInstanceId,
      );
      if (shiftInstanceId === null || !dependencies.navigateToShiftDetails) {
        return false;
      }
      const alignedSnapshot = await alignNotificationTenant(
        data,
        dependencies,
        isCurrent,
      );
      if (
        !alignedSnapshot ||
        !isRouteStillCurrent(alignedSnapshot, dependencies, isCurrent)
      ) {
        return false;
      }
      dependencies.navigateToShiftDetails(shiftInstanceId);
      return true;
    }

    case "sync_error":
      // HospitalAlert/integrationQueue é legado, global no AsyncStorage e não
      // possui binding de conta/tenant. Mesmo com o provider desativado, um
      // tap não pode reativar uma fila stale de outro login. O evento é
      // consumido como terminal-ignorado para que o mesmo response ID não
      // possa reaparecer via cold-start/LIVE e reabrir o roteamento.
      return true;

    default:
      return false;
  }
}

/**
 * Pede permissão de push e registra o Expo token no backend
 * (confirmations.registerPushToken). Renderizado apenas com usuário
 * logado — a mutation exige sessão. Sem este mount, NENHUM token era
 * registrado (bug descoberto no teste E2E de 2026-08-18: o hook
 * useNotifications existia mas nunca era montado).
 */
function PushTokenRegistrar({ userId }: { userId: number }) {
  useNotifications(userId);
  return null;
}

export function NotificationListener() {
  const router = useRouter();
  const {
    user,
    isAuthenticated,
    isSessionAuthorizationCurrent,
    pushRegistrationRevision,
  } = useAuth();
  const authorizedUser = isAuthenticated ? user : null;
  const authorizedUserId = authorizedUser?.id ?? null;
  const { setActiveInstitutionId } = useTenantState();
  const utils = trpc.useUtils();
  const routingCoordinatorRef = useRef<NotificationRoutingCoordinator | null>(
    null,
  );
  if (routingCoordinatorRef.current === null) {
    routingCoordinatorRef.current = createNotificationRoutingCoordinator();
  }
  const institutionsQuery = trpc.professionals.listMyInstitutions.useQuery(
    undefined,
    {
      enabled: !!authorizedUser,
    },
  );
  const refetchInstitutions = institutionsQuery.refetch;
  const loadAllowedInstitutionIds = useCallback(async () => {
    try {
      const refreshed = await refetchInstitutions();
      if (refreshed.isError || !refreshed.data) return null;
      return refreshed.data.map((institution) => institution.id);
    } catch {
      return null;
    }
  }, [refetchInstitutions]);

  const responseConsumerRef = useRef<
    (
      response: Notifications.NotificationResponse,
      source: "LIVE" | "LAST",
    ) => void
  >(() => undefined);

  // O listener device-global permanece montado durante CHECKING e durante o
  // handshake tenant A→B. Só o consumer account-scoped é trocado/fenceado;
  // assim um push que iniciou a troca de tenant não desmonta o próprio canal.
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => responseConsumerRef.current(response, "LIVE"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const routingScope = routingCoordinatorRef.current!.beginScope();
    if (authorizedUserId === null) {
      responseConsumerRef.current = () => undefined;
      return () => routingScope.invalidate();
    }

    let scopeActive = true;
    const pendingResponseKeys = new Set<string>();
    const routingDependencies: NotificationRoutingDependencies = {
      isSessionAuthorizationCurrent,
      getActiveTenantSnapshot,
      loadAllowedInstitutionIds,
      setActiveInstitutionId,
      invalidateQueries: async () => {
        await utils.invalidate();
      },
      navigateToConfirmation: (confirmationToken) => {
        router.push({
          pathname: "/confirm-duty" as any,
          params: { token: confirmationToken },
        });
      },
      navigateToAgenda: () => router.push("/(tabs)/agenda" as any),
      navigateToShiftDetails: (shiftInstanceId) =>
        router.push({
          pathname: "/shift-details" as any,
          params: { id: String(shiftInstanceId) },
        }),
      openComunica: async (institutionId, canNavigate, signal) => {
        if (!canNavigate()) return { ok: false };
        if (Platform.OS === "web") {
          const { runWebSsoHandoff } = await import("@/hooks/use-sso-handoff");
          if (!canNavigate()) return { ok: false };
          const result = await runWebSsoHandoff(institutionId, {
            signal,
            isCurrent: canNavigate,
          });
          return "cancelled" in result ? result : { ok: result.ok };
        }
        const { openComunica } = await import("@/lib/sso-launch");
        if (!canNavigate()) return { ok: false };
        return openComunica(institutionId, {
          canNavigate,
          signal,
        });
      },
    };
    const clearLastResponseIfMatching = (key: string | null) => {
      try {
        const current = Notifications.getLastNotificationResponse();
        if (!current) return;
        if (key !== null && notificationResponseKey(current) !== key) return;
        Notifications.clearLastNotificationResponse();
      } catch {
        console.warn("[NotificationListener] LAST_RESPONSE_CLEAR_FAILED");
      }
    };
    const consumeResponse = (
      response: Notifications.NotificationResponse,
      source: "LIVE" | "LAST",
    ) => {
      const key = notificationResponseKey(response);
      if (key === null) {
        // A resposta inicial foi observada, mas o envelope não é identificável
        // e portanto não pode entrar na fila nem reaparecer em outro usuário.
        if (source === "LAST") clearLastResponseIfMatching(null);
        return;
      }
      if (
        response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER
      ) {
        // Ações customizadas têm semântica própria. Tratá-las como tap padrão
        // poderia trocar tenant e abrir uma tela não solicitada.
        markTerminalNotificationResponse(key);
        clearLastResponseIfMatching(key);
        return;
      }
      if (!isSessionAuthorizationCurrent()) {
        // O BEGIN de login/logout/rotação invalida a proof antes do rerender.
        // Descarta terminalmente o tap observado sob A para ele nunca reaparecer
        // como LAST nem ganhar autoridade quando B montar o próximo consumer.
        markTerminalNotificationResponse(key);
        clearLastResponseIfMatching(key);
        return;
      }
      if (!claimNotificationResponse(key)) {
        clearLastResponseIfMatching(key);
        return;
      }

      // O slot device-global precisa ser limpo antes de qualquer await. Se o
      // processo cair ou a conta mudar durante o roteamento, a resposta fria
      // não pode reaparecer para outro usuário. Um resultado retryable libera
      // apenas o claim em memória; uma nova tentativa exige novo evento LIVE.
      clearLastResponseIfMatching(key);
      pendingResponseKeys.add(key);
      const data = response.notification.request.content.data;
      void routingScope.enqueue(data, routingDependencies).then(
        (success) => {
          // Cleanup pode ter liberado a chave para uma nova sessão. Uma
          // continuação antiga nunca toca o claim possivelmente novo.
          if (!pendingResponseKeys.delete(key)) return;
          settleNotificationResponse(key, scopeActive && success);
          clearLastResponseIfMatching(key);
        },
        () => {
          if (!pendingResponseKeys.delete(key)) return;
          settleNotificationResponse(key, false);
          clearLastResponseIfMatching(key);
        },
      );
    };
    responseConsumerRef.current = consumeResponse;
    try {
      const lastResponse = Notifications.getLastNotificationResponse();
      if (lastResponse) consumeResponse(lastResponse, "LAST");
    } catch {
      console.warn("[NotificationListener] LAST_RESPONSE_READ_FAILED");
    }

    return () => {
      scopeActive = false;
      if (responseConsumerRef.current === consumeResponse) {
        responseConsumerRef.current = () => undefined;
      }
      routingScope.invalidate();
      // Cleanup é a decisão fail-closed para itens ainda pendentes: limpa
      // somente se a resposta global ainda for exatamente a observada.
      for (const key of pendingResponseKeys) {
        settleNotificationResponse(key, false);
        clearLastResponseIfMatching(key);
      }
      pendingResponseKeys.clear();
    };
  }, [
    loadAllowedInstitutionIds,
    router,
    setActiveInstitutionId,
    utils,
    authorizedUserId,
    isSessionAuthorizationCurrent,
  ]);

  return authorizedUserId !== null ? (
    <PushTokenRegistrar
      key={`${authorizedUserId}:${pushRegistrationRevision}`}
      userId={authorizedUserId}
    />
  ) : null;
}
