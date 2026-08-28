import { useEffect, useRef, useState } from "react";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { trpc } from "@/lib/trpc";
import {
  getServerRegisteredPushToken,
  hydrateServerRegisteredPushToken,
  persistServerRegisteredPushToken,
  recordServerRegisteredPushToken,
  setLastPushToken,
} from "@/lib/push-token";
import {
  capturePushRegistrationAdmission,
  ensurePushRegistration,
  hasFreshPushRegistrationProof,
  hydrateFreshPushRegistrationProof,
  invalidatePushRegistrationProof,
  isPushRegistrationAdmissionCurrent,
} from "@/lib/push-registration";

/** Marca navy (`theme.palette.brand[500]` / plugin expo-notifications). Sem import de theme: testes SSO mockam react-native sem Platform.select. */
const ANDROID_NOTIFICATION_COLOR = "#01304A";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function pushPlatform(): "ios" | "android" | "web" {
  return Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
}

function expoProjectId(): string | null {
  return Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId ??
    null;
}

export function useNotifications(expectedUserId: number) {
  const [expoPushToken, setExpoPushToken] = useState<string | undefined>();
  const [notification, setNotification] = useState<Notifications.Notification | undefined>();
  const notificationListener = useRef<Notifications.Subscription>(undefined!);
  const registrationGeneration = useRef(0);
  const registerMutation = trpc.confirmations.registerPushToken.useMutation();
  const registerPushToken = registerMutation.mutateAsync;

  useEffect(() => {
    const scopeGeneration = ++registrationGeneration.current;
    let active = true;
    const platform = pushPlatform();
    let lastServerRegisteredToken = getServerRegisteredPushToken(expectedUserId);
    type PredecessorHydration =
      | Readonly<{ ok: true; token: string | null }>
      | Readonly<{ ok: false; error: unknown }>;
    let predecessorHydration: Promise<PredecessorHydration> | null = null;
    let latestRegistrationTicket = 0;
    const isScopeCurrent = () =>
      active && registrationGeneration.current === scopeGeneration;
    const reserveRegistrationTicket = () => ++latestRegistrationTicket;
    const isCurrent = (ticket: number) =>
      isScopeCurrent() && latestRegistrationTicket === ticket;

    const hydrateCurrentPredecessor = async (): Promise<string | null> => {
      predecessorHydration ??= hydrateServerRegisteredPushToken(
        expectedUserId,
        platform,
      ).then<PredecessorHydration, PredecessorHydration>(
        (token) => ({ ok: true, token }),
        (error: unknown) => ({ ok: false, error }),
      );
      const hydration = await predecessorHydration;
      if (!hydration.ok) throw hydration.error;
      lastServerRegisteredToken = hydration.token;
      if (hydration.token) {
        recordServerRegisteredPushToken(expectedUserId, hydration.token);
      }
      return hydration.token;
    };

    const persistConfirmedPredecessor = async (
      context: Readonly<{
        userId: number;
        token: string;
        platform: "ios" | "android" | "web";
      }>,
    ): Promise<void> => {
      try {
        await persistServerRegisteredPushToken(context);
        predecessorHydration = Promise.resolve({ ok: true, token: context.token });
        lastServerRegisteredToken = context.token;
        recordServerRegisteredPushToken(context.userId, context.token);
      } catch (error) {
        // Uma confirmação remota sem envelope local é estado ambíguo. Cerca os
        // rollovers posteriores até uma hidratação nova decidir se a falha foi
        // transitória (retry idempotente) ou deixou quarentena durável.
        predecessorHydration = null;
        lastServerRegisteredToken = null;
        throw error;
      }
    };

    const reconcileRegistrationProof = async (
      context: Readonly<{
        userId: number;
        token: string;
        platform: "ios" | "android" | "web";
      }>,
      admission: number,
    ): Promise<void> => {
      const predecessor = await hydrateCurrentPredecessor();
      const hasFreshProof = await hydrateFreshPushRegistrationProof(context);
      if (
        !hasFreshProof ||
        !isPushRegistrationAdmissionCurrent(admission) ||
        predecessor === context.token
      ) {
        return;
      }

      // A proof não contém o raw e não pode migrar o cofre sozinha. Ausência
      // ou divergência sempre remove a dedupe e força um POST confirmado.
      await invalidatePushRegistrationProof(context);
      if (predecessor === null) {
        // Durante remount do mesmo usuário, conserva em memória o raw revelado
        // pela aquisição + proof apenas para o mount atual fazer a migração.
        // Ele não é publicado nem persiste sem o novo POST.
        lastServerRegisteredToken = context.token;
        recordServerRegisteredPushToken(context.userId, context.token);
      }
    };

    const registerCurrentToken = async (
      token: string,
      admission: number,
      ticket: number,
    ): Promise<void> => {
      if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
        return;
      }
      try {
        const registrationContext = {
          userId: expectedUserId,
          token,
          platform,
        } as const;
        // Precisa ocorrer antes do ensure: a dedupe por fingerprint não tem
        // autoridade para pular POST quando o envelope está ausente/divergente.
        await reconcileRegistrationProof(registrationContext, admission);
        if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
          return;
        }
        const registeredNow = await ensurePushRegistration(
          registrationContext,
          async (snapshot) => {
            if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
              return { success: false, message: "Registro push substituído" };
            }
            // O cofre é a fonte durável do predecessor. Nunca escolhe
            // previousToken antes de concluir a hidratação user+platform.
            await hydrateCurrentPredecessor();
            if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
              return { success: false, message: "Registro push substituído" };
            }
            const previousToken =
              getServerRegisteredPushToken(expectedUserId) ?? lastServerRegisteredToken;
            // O replacement remoto apaga o predecessor. A prova local dele
            // precisa sair DURAVELMENTE antes desse commit; kill/resposta
            // perdida depois do POST jamais pode ressuscitar um token ausente.
            if (previousToken && previousToken !== snapshot.token) {
              await invalidatePushRegistrationProof({
                ...registrationContext,
                token: previousToken,
              });
              if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
                return { success: false, message: "Registro push substituído" };
              }
            }
            const result = await registerPushToken({
              token: snapshot.token,
              ...(previousToken && previousToken !== snapshot.token
                ? { previousToken }
                : {}),
              platform: snapshot.platform,
              expectedUserId: snapshot.userId,
            });
            if (result.success) {
              // O proof/estado visual só pode avançar depois do write+readback
              // exato do envelope. Uma falha lança para o retry idempotente do
              // ensure e nunca publica este token.
              await persistConfirmedPredecessor(snapshot);
            }
            // Mesmo que um rollover mais novo tenha reservado ticket durante
            // o POST, o servidor pode ter confirmado este token. Mantê-lo só
            // como predecessor físico permite ao ticket atual removê-lo; não
            // publica prova nem estado visual do ticket já substituído.
            if (result.success) {
              lastServerRegisteredToken = snapshot.token;
            }
            if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
              return { success: false, message: "Registro push substituído" };
            }
            return result;
          },
          async (delayMs) => {
            if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
              return;
            }
          },
        );
        if (!isCurrent(ticket) || !isPushRegistrationAdmissionCurrent(admission)) {
          return;
        }
        const hasRegistrationProof =
          registeredNow || hasFreshPushRegistrationProof(registrationContext);
        // `ensure` só retorna sob admissão atual após um POST bem-sucedido ou
        // uma prova fresca desse mesmo user+device+token. Nunca publica antes
        // da confirmação e nunca transforma tenant em ownership físico.
        if (
          !hasRegistrationProof ||
          !isCurrent(ticket) ||
          !isPushRegistrationAdmissionCurrent(admission)
        ) {
          return;
        }
        lastServerRegisteredToken = token;
        setExpoPushToken(token);
        setLastPushToken(token);
      } catch {
        if (isCurrent(ticket)) console.warn("[Push] TOKEN_REGISTER_FAILED");
      }
    };

    const setupTicket = reserveRegistrationTicket();
    const setupAdmission = capturePushRegistrationAdmission();
    let settleSetupDiscovery!: () => void;
    const setupDiscovery = new Promise<void>((resolve) => {
      settleSetupDiscovery = resolve;
    });
    if (setupAdmission !== null) {
      void registerForPushNotificationsAsync(
        () => (
          isScopeCurrent() &&
          isPushRegistrationAdmissionCurrent(setupAdmission)
        ),
      )
        .then(async (token) => {
          if (
            token &&
            isScopeCurrent() &&
            isPushRegistrationAdmissionCurrent(setupAdmission)
          ) {
            const setupContext = {
              userId: expectedUserId,
              token,
              platform,
            } as const;
            await reconcileRegistrationProof(setupContext, setupAdmission);
          }
          settleSetupDiscovery();
          if (
            !token ||
            !isCurrent(setupTicket) ||
            !isPushRegistrationAdmissionCurrent(setupAdmission)
          ) {
            return;
          }
          return registerCurrentToken(token, setupAdmission, setupTicket);
        })
        // Registro de push NUNCA pode derrubar o app. O Expo lança em builds
        // instalados quando projectId/permissão/provedor estão indisponíveis.
        .catch(() => {
          settleSetupDiscovery();
          if (isCurrent(setupTicket)) console.warn("[Push] TOKEN_SETUP_FAILED");
        });
    } else {
      settleSetupDiscovery();
    }

    notificationListener.current = Notifications.addNotificationReceivedListener((next) => {
      if (active && registrationGeneration.current === scopeGeneration) {
        setNotification(next);
      }
    });

    const pushTokenListener = Notifications.addPushTokenListener((devicePushToken) => {
      const rolloverTicket = reserveRegistrationTicket();
      const projectId = expoProjectId();
      const rolloverAdmission = capturePushRegistrationAdmission();
      if (!projectId || rolloverAdmission === null || !isCurrent(rolloverTicket)) return;
      void (async () => {
        if (
          !isCurrent(rolloverTicket) ||
          !isPushRegistrationAdmissionCurrent(rolloverAdmission)
        ) {
          return;
        }
        const { data } = await Notifications.getExpoPushTokenAsync({
          projectId,
          devicePushToken,
        });
        if (
          !isCurrent(rolloverTicket) ||
          !isPushRegistrationAdmissionCurrent(rolloverAdmission)
        ) {
          return;
        }
        // No cold start, o token anterior existe apenas como fingerprint. A
        // aquisição inicial revela o valor bruto; aguardar sua descoberta
        // evita registrar T2 sem previousToken e deixar T1 órfão.
        await setupDiscovery;
        if (
          !isCurrent(rolloverTicket) ||
          !isPushRegistrationAdmissionCurrent(rolloverAdmission)
        ) {
          return;
        }
        await registerCurrentToken(data, rolloverAdmission, rolloverTicket);
        if (
          !isCurrent(rolloverTicket) ||
          !isPushRegistrationAdmissionCurrent(rolloverAdmission)
        ) {
          return;
        }
      })()
        .catch(() => {
          if (isCurrent(rolloverTicket)) {
            console.warn("[Push] TOKEN_ROLLOVER_FAILED");
          }
        });
    });

    return () => {
      active = false;
      registrationGeneration.current += 1;
      notificationListener.current?.remove();
      pushTokenListener.remove();
    };
  }, [expectedUserId, registerPushToken]);

  return {
    expoPushToken,
    notification,
    scheduleNotification,
    cancelAllNotifications,
  };
}

// Agendar notificação local
export async function scheduleNotification(
  title: string,
  body: string,
  data?: any,
  trigger?: Notifications.NotificationTriggerInput,
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: true,
    },
    trigger: trigger || null,
  });
}

// Cancelar todas as notificações agendadas
export async function cancelAllNotifications() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

async function registerForPushNotificationsAsync(
  isCurrent: () => boolean,
): Promise<string | undefined> {
  if (!isCurrent()) return undefined;
  if (Platform.OS === "android") {
    if (!isCurrent()) return undefined;
    await Notifications.setNotificationChannelAsync("escalas-default", {
      name: "Plantões e ofertas",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: ANDROID_NOTIFICATION_COLOR,
    });
    if (!isCurrent()) return undefined;
  }

  if (!isCurrent()) return undefined;
  if (!Device.isDevice) {
    console.warn("Deve usar um dispositivo físico para Push Notifications");
    return undefined;
  }

  if (!isCurrent()) return undefined;
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (!isCurrent()) return undefined;
  let finalStatus: string | undefined = existingStatus;
  if (existingStatus !== "granted") {
    if (!isCurrent()) return undefined;
    const permission = await Notifications.requestPermissionsAsync();
    if (!isCurrent()) return undefined;
    finalStatus = permission.status;
  }
  if (!isCurrent()) return undefined;
  if (finalStatus !== "granted") {
    console.warn("Permissão de notificação negada");
    return undefined;
  }

  const projectId = expoProjectId();
  if (!projectId) {
    console.warn("[Push] projectId ausente — push desabilitado neste build");
    return undefined;
  }
  if (!isCurrent()) return undefined;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  if (!isCurrent()) return undefined;
  return data;
}
