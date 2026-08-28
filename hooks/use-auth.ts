// hooks/use-auth.ts — estado de autenticação COMPARTILHADO via Context.
//
// A versão anterior era um hook com useState local: CADA componente que
// chamava useAuth() tinha sua PRÓPRIA cópia de `user`. Ao logar, a tela
// de login atualizava a cópia dela, mas o AuthGuard (montado no root
// layout) continuava com user=null e redirecionava de volta pro /login
// — bounce reproduzido no web em 2026-08-19. O mesmo defeito deixava
// telas com estados de sessão divergentes entre si.
//
// Agora o estado vive UMA vez no AuthProvider (root layout); useAuth()
// consome o contexto. A API pública do hook é idêntica à anterior.

import { getLastPushToken, setLastPushToken } from "@/lib/push-token";
import {
  authApi,
  isSessionMutationMismatchCode,
  type AuthMutationErrorCode,
  type SessionBindingCapabilityReceipt,
  type AuthUser,
} from "@/lib/_core/api";
import * as Auth from "@/lib/_core/auth";
import { exactSessionBindingClientActive } from "@/lib/_core/session-binding-protocol";
import { clearActiveInstitutionId } from "@/lib/tenant-state";
import {
  clearPersistedQueryCache,
  fenceQueryCachePersistence,
  suspendQueryCachePersistence,
} from "@/lib/query-persist";
import {
  runSessionCleanup,
  SessionTerminationNotDurableError,
} from "@/lib/session-cleanup";
import {
  closePushRegistrationAdmission,
  clearPushRegistrationState,
  openPushRegistrationAdmission,
  waitForPushRegistrationIdle,
} from "@/lib/push-registration";
import { appSessionEpoch, type SessionEpochTicket } from "@/lib/session-epoch";
import { onSessionUnauthorized } from "@/lib/session-events";
import {
  alignPreservedWebVerifiedSessionSequence,
  clearPreservedWebVerifiedSession,
  readPreservedWebVerifiedSession,
  rememberPreservedWebVerifiedSession,
} from "@/lib/web-verified-session";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";

export type { AuthUser as User };

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isSessionAuthorizationCurrent: () => boolean;
  pushRegistrationRevision: number;
  sessionValidation: SessionValidationState;
  login: (
    email: string,
    password: string,
  ) => Promise<{ ok: boolean; error?: string; admissionPending?: true }>;
  rotateSession: (
    operation: (
      credential: Auth.SessionTransitionCredential,
      capabilityReceipt?: SessionBindingCapabilityReceipt,
    ) => Promise<{
      ok: boolean;
      token?: string;
      error?: string;
      status?: number;
      code?: AuthMutationErrorCode;
    }>,
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteAccount: (password: string) => Promise<{
    ok: boolean;
    status: number;
    error?: string;
    code?: AuthMutationErrorCode;
  }>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
};

export type SessionValidationState =
  | Readonly<{
      status: "CHECKING" | "UNAVAILABLE";
      sequence: number;
      durableSession?: true;
    }>
  | Readonly<{
      status: "VERIFIED";
      sequence: number;
      userId: number;
      ticket: SessionEpochTicket;
      isCurrent: () => boolean;
    }>;

function unprovenSessionValidation(
  status: "CHECKING" | "UNAVAILABLE",
  sequence: number,
  durableSession: boolean,
): SessionValidationState {
  return durableSession
    ? { status, sequence, durableSession: true }
    : { status, sequence };
}

type RefetchOutcome = "VERIFIED" | "INVALID" | "UNAVAILABLE" | "STALE";

type SessionRevocationResult = Readonly<{
  confirmed: boolean;
  pushStateCleared: boolean;
  requiresCanonicalReadmission?: true;
  error?: unknown;
}>;

type SessionRevocationFlight = Readonly<{
  promise: Promise<SessionRevocationResult>;
}>;

type SessionMutationCompletion<T> = Readonly<{
  value: T;
  afterSettled?: (
    settledEpoch: SessionEpochTicket,
    intentGeneration: number,
  ) => void | Promise<void>;
}>;

type SessionMutationWebBoundary<T> = Readonly<{
  expectedUserId?: number;
  requireClearGate?: boolean;
  invalidatedValue: () => T;
}>;

const AuthContext = createContext<AuthContextValue | null>(null);
let latestAuthRefetchSequence = 0;
// A lease protege o transporte do processo, não a vida de um provider.
// Um remount precisa herdar pending/tail para nunca validar /me no meio da
// mutação que ainda está terminando no provider anterior.
const sessionMutationState: {
  tail: Promise<void>;
  pending: number;
  active: symbol | null;
  intentGeneration: number;
  reconciliationRequired: boolean;
} = {
  tail: Promise.resolve(),
  pending: 0,
  active: null,
  intentGeneration: 0,
  reconciliationRequired: false,
};
let nativeSessionRevocationFlight: SessionRevocationFlight | null = null;
let webSessionRevocationFlight: SessionRevocationFlight | null = null;
// `true` somente enquanto runSessionMutation detém o Web Lock cross-tab. As
// chamadas internas de /me pós-END reutilizam o mesmo workflow sem tentar
// adquirir recursivamente um lock não reentrante.
let webSessionWorkflowLockHeld = false;
let webSessionWorkflowSignal: AbortSignal | null = null;

function runSessionRevocationSingleFlight(
  kind: "native" | "web",
  operation: () => Promise<SessionRevocationResult>,
): Promise<SessionRevocationResult> {
  const current =
    kind === "native"
      ? nativeSessionRevocationFlight
      : webSessionRevocationFlight;
  if (current) return current.promise;

  const promise = operation();
  const flight = { promise };
  // A revogação pertence ao transporte, não ao provider/epoch que a iniciou.
  // Enquanto o ACK remoto não assenta, nenhuma rotação pode consumir o
  // Bearer PENDING nem um remount pode reabrir push/UI.
  sessionMutationState.reconciliationRequired = true;
  if (kind === "native") nativeSessionRevocationFlight = flight;
  else webSessionRevocationFlight = flight;

  const clear = () => {
    if (kind === "native" && nativeSessionRevocationFlight === flight) {
      nativeSessionRevocationFlight = null;
    }
    if (kind === "web" && webSessionRevocationFlight === flight) {
      webSessionRevocationFlight = null;
    }
  };
  void promise.then(clear, clear);
  return promise;
}

function isAmbiguousSessionTokenCommit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "SESSION_TOKEN_COMMIT_AMBIGUOUS"
  );
}

function verifiedSessionValidation(
  userId: number,
  ticket: SessionEpochTicket,
  sequence: number,
): SessionValidationState {
  return {
    status: "VERIFIED",
    sequence,
    userId,
    ticket,
    isCurrent: () =>
      sequence === latestAuthRefetchSequence &&
      appSessionEpoch.isCurrent(ticket) &&
      Auth.isSessionTransportUserCurrent(userId),
  };
}

function readRestoredWebVerifiedSession(): {
  user: AuthUser;
  sessionValidation: SessionValidationState;
} | null {
  const preserved = readPreservedWebVerifiedSession<AuthUser>({
    isTransportCurrent: Auth.isSessionTransportUserCurrent,
    isEpochCurrent: (ticket) => appSessionEpoch.isCurrent(ticket),
  });
  if (!preserved) return null;
  latestAuthRefetchSequence = alignPreservedWebVerifiedSessionSequence(
    latestAuthRefetchSequence,
  );
  return {
    user: preserved.user,
    sessionValidation: verifiedSessionValidation(
      preserved.user.id,
      preserved.ticket,
      latestAuthRefetchSequence,
    ),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const restoredWebSessionRef = useRef<ReturnType<typeof readRestoredWebVerifiedSession>>(
    undefined,
  );
  if (restoredWebSessionRef.current === undefined) {
    restoredWebSessionRef.current = readRestoredWebVerifiedSession();
  }
  const restoredWebSession = restoredWebSessionRef.current;
  const [user, setUser] = useState<AuthUser | null>(
    restoredWebSession?.user ?? null,
  );
  const [isLoading, setIsLoading] = useState(restoredWebSession === null);
  const [pushRegistrationRevision, setPushRegistrationRevision] = useState(0);
  const [sessionValidation, setSessionValidation] =
    useState<SessionValidationState>(
      restoredWebSession?.sessionValidation ?? {
        status: "CHECKING",
        sequence: 0,
      },
    );
  // Cache de consultas em memória: zerado no login e no logout, aqui, e
  // não no AuthGuard — o guard é REMONTADO a cada troca de usuário
  // (TenantScope) e nunca via a transição.
  const queryClient = useQueryClient();
  const sessionUserRef = useRef<AuthUser | null>(restoredWebSession?.user ?? null);
  const verifiedSessionSnapshotRef = useRef<{
    userId: number;
    ticket: SessionEpochTicket;
    sequence: number;
  } | null>(
    restoredWebSession && restoredWebSession.sessionValidation.status === "VERIFIED"
      ? {
          userId: restoredWebSession.user.id,
          ticket: restoredWebSession.sessionValidation.ticket,
          sequence: restoredWebSession.sessionValidation.sequence,
        }
      : null,
  );

  useEffect(() => {
    sessionUserRef.current = user;
    if (user === null) {
      clearPreservedWebVerifiedSession();
    }
  }, [user]);

  useEffect(() => {
    if (
      sessionValidation.status === "VERIFIED" &&
      sessionValidation.isCurrent() &&
      user !== null &&
      user.id === sessionValidation.userId
    ) {
      verifiedSessionSnapshotRef.current = {
        userId: sessionValidation.userId,
        ticket: sessionValidation.ticket,
        sequence: sessionValidation.sequence,
      };
      rememberPreservedWebVerifiedSession({
        user,
        ticket: sessionValidation.ticket,
        sequence: sessionValidation.sequence,
      });
      return;
    }
    if (sessionValidation.status === "UNAVAILABLE") {
      verifiedSessionSnapshotRef.current = null;
      clearPreservedWebVerifiedSession();
    }
  }, [sessionValidation, user]);

  const closeAsyncSessionAdmission = useCallback(() => {
    Auth.closeSessionTokenTransportAdmission();
    closePushRegistrationAdmission();
    fenceQueryCachePersistence();
  }, []);

  // Encerra a sessão LOCAL por completo: instituição ativa, cache
  // persistido em disco, cache em memória, usuário em cache e estado.
  // Usado pelo logout e por sessão revogada — o cache de um usuário que
  // já não tem sessão não pode sobrar no aparelho.
  const endSession = useCallback(
    async (
      expectedEpoch?: SessionEpochTicket,
      pushStateAlreadyCleared = false,
      advanceEpoch = true,
      preserveQuarantinedToken = false,
    ): Promise<boolean> => {
      const cleanupEpoch = advanceEpoch
        ? expectedEpoch
          ? appSessionEpoch.beginTransitionIfCurrent(expectedEpoch)
          : appSessionEpoch.beginTransition()
        : expectedEpoch && appSessionEpoch.isCurrent(expectedEpoch)
          ? expectedEpoch
          : null;
      if (!cleanupEpoch) return false;

      // A barreira precisa existir antes de qualquer await: token Expo, restore
      // e /me antigos perdem autoridade imediatamente.
      closeAsyncSessionAdmission();
      // O predecessor push é account-scoped. Uma saída por 401/mismatch/rollback
      // precisa apagá-lo tanto quanto o botão de logout; caso contrário B pode
      // herdar o token bruto de A e manter o aparelho inscrito nas duas contas.
      setLastPushToken(null);
      await waitForPushRegistrationIdle();
      if (!appSessionEpoch.isCurrent(cleanupEpoch)) return false;

      const onlyWhileCurrent =
        (run: () => void | Promise<void>) => async () => {
          if (appSessionEpoch.isCurrent(cleanupEpoch)) await run();
        };

      await runSessionCleanup(
        [
          ...(preserveQuarantinedToken
            ? []
            : [
                {
                  name: "token de sessão",
                  run: onlyWhileCurrent(Auth.removeSessionToken),
                },
              ]),
          ...(pushStateAlreadyCleared
            ? []
            : [
                {
                  name: "registro push",
                  run: onlyWhileCurrent(clearPushRegistrationState),
                },
              ]),
          {
            name: "usuário persistido",
            run: onlyWhileCurrent(Auth.clearUserInfo),
          },
          {
            name: "cache persistido",
            run: onlyWhileCurrent(clearPersistedQueryCache),
          },
          {
            name: "cache de consultas em memória",
            run: onlyWhileCurrent(() => queryClient.clear()),
          },
          // O tenant null só é publicado depois de apagar/fencear todo dado A.
          {
            name: "instituição ativa",
            run: onlyWhileCurrent(clearActiveInstitutionId),
          },
        ],
        onlyWhileCurrent(() => {
          setSessionValidation({
            status: "UNAVAILABLE",
            sequence: latestAuthRefetchSequence,
          });
          setUser(null);
          sessionMutationState.reconciliationRequired = false;
        }),
      );
      return appSessionEpoch.isCurrent(cleanupEpoch);
    },
    [closeAsyncSessionAdmission, queryClient],
  );

  const revokeQuarantinedNativeSession = useCallback(
    (
      _expectedEpoch: SessionEpochTicket,
      explicitToken?: string,
      pushStateAlreadyCleared = false,
      expectedUserId?: number,
    ): Promise<SessionRevocationResult> => {
      if (Platform.OS === "web") {
        return Promise.resolve({ confirmed: true, pushStateCleared: false });
      }

      return runSessionRevocationSingleFlight("native", async () => {
        closeAsyncSessionAdmission();
        let token: string;
        let preparedRevocation: Awaited<
          ReturnType<typeof Auth.prepareSessionTokenRevocation>
        > | null = null;
        let preparationError: unknown;
        try {
          // Invalida a admissão do Bearer na mesma pilha antes do primeiro await
          // externo. Um 500 remoto deixa B em PENDING, nunca COMMITTED utilizável
          // por tRPC/outros consumidores enquanto o recovery repete a revogação.
          preparedRevocation = await Auth.prepareSessionTokenRevocation(
            explicitToken,
            expectedUserId,
          );
          token = preparedRevocation.token;
        } catch (error) {
          // Um B explícito recém-emitido pode ter falhado antes de qualquer
          // persistência local. Ainda tenta revogá-lo com o valor da resposta;
          // sem esse escape, uma sessão remota válida ficaria abandonada. O
          // rollback local continua fail-closed e nunca preserva A como se fosse B.
          if (!explicitToken?.trim()) {
            return {
              confirmed: false,
              pushStateCleared: false,
              error,
            };
          }
          token = explicitToken;
          preparationError = error;
        }
        await waitForPushRegistrationIdle();

        let pushStateCleared = pushStateAlreadyCleared;
        try {
          if (!pushStateCleared) {
            await clearPushRegistrationState();
            pushStateCleared = true;
          }
          if (!preparedRevocation) {
            await authApi.revokeSessionToken(token);
            throw new Error(
              "Logout remoto confirmou o token, mas o binding físico local não foi preparado",
            );
          }
          await Auth.revokePreparedSessionToken(preparedRevocation);
          return { confirmed: true, pushStateCleared };
        } catch (error) {
          return {
            confirmed: false,
            pushStateCleared,
            error:
              preparationError === undefined
                ? error
                : new AggregateError(
                    [preparationError, error],
                    "Revogação explícita falhou sem binding local confirmado",
                  ),
          };
        }
      });
    },
    [closeAsyncSessionAdmission],
  );

  const revokeQuarantinedWebSession = useCallback(
    (
      _expectedEpoch: SessionEpochTicket,
      explicitExpectedUserId?: number,
      explicitSessionInstance?: string,
    ): Promise<SessionRevocationResult> => {
      if (Platform.OS !== "web") {
        return Promise.resolve({ confirmed: true, pushStateCleared: false });
      }

      return runSessionRevocationSingleFlight("web", async () => {
        // Logout revoga rows push no mesmo commit. A quarentena do cookie não
        // substitui essa revogação e a prova push precisa cair antes da chamada.
        closeAsyncSessionAdmission();
        let expectedUserId = explicitExpectedUserId;
        let expectedSessionInstance = explicitSessionInstance;
        try {
          // Recovery/remount pode chegar aqui sem runSessionMutation. A revisão
          // precisa avançar antes do marker e do Set-Cookie de logout; dentro de
          // uma mutação normal a operação é idempotente para o mesmo Web Lock.
          Auth.advanceWebSessionWorkflowRevision();
          const gate = await Auth.getWebSessionGateState();
          const gateExpectedUserId =
            gate.state === "ADMISSION" ||
            (gate.state === "REVOKE_REQUIRED" &&
              gate.expectedUserId !== undefined)
              ? gate.expectedUserId
              : undefined;
          const gateSessionInstance =
            gate.state === "REVOKE_REQUIRED" ? gate.sessionInstance : undefined;
          if (
            expectedUserId !== undefined &&
            gateExpectedUserId !== undefined &&
            expectedUserId !== gateExpectedUserId
          ) {
            throw new Error(
              "Identidade da revogação web divergiu do marker durável",
            );
          }
          if (
            expectedSessionInstance !== undefined &&
            gateSessionInstance !== undefined &&
            expectedSessionInstance !== gateSessionInstance
          ) {
            throw new Error(
              "Instância da revogação web divergiu do marker durável",
            );
          }
          expectedUserId ??= gateExpectedUserId;
          expectedSessionInstance ??= gateSessionInstance;
          if (
            expectedSessionInstance === undefined &&
            exactSessionBindingClientActive()
          ) {
            const bootstrap =
              await Auth.bootstrapExactWebSessionRevocation(expectedUserId);
            if (bootstrap.state === "BOUND") {
              expectedUserId = bootstrap.expectedUserId;
              expectedSessionInstance = bootstrap.sessionInstance;
            }
            // INVALID mantém a barreira e ainda exige o logout idempotente: a
            // confirmação do fence impede que um Set-Cookie tardio reapareça.
          }
          // ADMISSION/CLEAR anômalo vira REVOKE_REQUIRED antes de o cookie ser
          // usado no logout. Falha de persistência impede o efeito remoto.
          await Auth.beginWebSessionQuarantine(
            expectedUserId,
            expectedSessionInstance,
          );
        } catch (error) {
          return { confirmed: false, pushStateCleared: false, error };
        }
        await waitForPushRegistrationIdle();

        let pushStateCleared = false;
        try {
          await clearPushRegistrationState();
          pushStateCleared = true;
          const outcome = await Auth.revokeWebSessionQuarantine(
            expectedUserId,
            expectedSessionInstance,
          );
          return {
            confirmed: true,
            pushStateCleared,
            ...(outcome.status === "STALE_QUARANTINE_CLEARED"
              ? { requiresCanonicalReadmission: true as const }
              : {}),
          };
        } catch (error) {
          // Marker durável permanece ativo. ACK remoto nunca é inferido por
          // /me/401: o próximo fluxo repete o próprio logout tipado.
          return { confirmed: false, pushStateCleared, error };
        }
      });
    },
    [closeAsyncSessionAdmission],
  );

  const rollbackFailedLogin = useCallback(
    async (
      loginEpoch: SessionEpochTicket,
      localError: string,
      explicitNativeToken?: string,
      pushStateAlreadyCleared = false,
      remoteRevocationAlreadyConfirmed = false,
      expectedUserId?: number,
      expectedWebSessionInstance?: string,
    ): Promise<{ ok: false; error: string }> => {
      const revocation = remoteRevocationAlreadyConfirmed
        ? { confirmed: true, pushStateCleared: pushStateAlreadyCleared }
        : Platform.OS === "web"
          ? await revokeQuarantinedWebSession(
              loginEpoch,
              expectedUserId,
              expectedWebSessionInstance,
            )
          : await revokeQuarantinedNativeSession(
              loginEpoch,
              explicitNativeToken,
              pushStateAlreadyCleared,
              expectedUserId,
            );

      if (!appSessionEpoch.isCurrent(loginEpoch)) {
        return {
          ok: false,
          error: "Este login foi substituído por uma sessão mais recente.",
        };
      }

      let preserveQuarantinedToken = false;
      if (Platform.OS !== "web" && !revocation.confirmed) {
        try {
          const quarantinedToken =
            await Auth.getQuarantinedSessionTokenForRevocation();
          preserveQuarantinedToken =
            quarantinedToken !== null &&
            (explicitNativeToken === undefined ||
              quarantinedToken === explicitNativeToken);
        } catch {
          // Sem binding canônico de B, preservar o slot poderia ressuscitar o
          // Bearer A anterior quando stage falhou antes de instalar o marker.
        }
      }

      let cleanupFailed = false;
      try {
        // A lease exclusiva fará o bump de END. Antecipá-lo aqui permitiria que
        // um refetch enfileirado enxergasse a transição como já assentada.
        await endSession(
          loginEpoch,
          revocation.pushStateCleared,
          false,
          preserveQuarantinedToken,
        );
      } catch (cleanupError) {
        cleanupFailed = true;
        console.error(
          "[Auth] Rollback local do login incompleto",
          cleanupError,
        );
      }
      if (revocation.requiresCanonicalReadmission) {
        sessionMutationState.reconciliationRequired = true;
      }

      if (!revocation.confirmed) {
        return {
          ok: false,
          error:
            "Login bloqueado: o servidor ainda não confirmou a revogação desta sessão.",
        };
      }
      if (cleanupFailed) {
        return {
          ok: false,
          error:
            "A sessão foi revogada, mas a limpeza local permanece bloqueada neste aparelho.",
        };
      }
      return { ok: false, error: localError };
    },
    [endSession, revokeQuarantinedNativeSession, revokeQuarantinedWebSession],
  );

  const performRefetchInsideWebLock = useCallback(
    async (
      requestEpoch: SessionEpochTicket,
      expectedUserId?: number,
      requestIntentGeneration = sessionMutationState.intentGeneration,
      workflowSignal: AbortSignal | null = webSessionWorkflowSignal,
    ): Promise<RefetchOutcome> => {
      // Um refetch pode ter sido enfileirado no Web Lock antes de uma intenção
      // de login/logout/rotação. Ao finalmente adquirir o lock, ele não pode
      // criar uma sequência nova nem reabrir o transporte que a intenção mais
      // recente já fechou.
      if (requestIntentGeneration !== sessionMutationState.intentGeneration) {
        return "STALE";
      }
      const preservedVerifiedSession =
        sessionUserRef.current !== null &&
        verifiedSessionSnapshotRef.current !== null &&
        verifiedSessionSnapshotRef.current.userId === sessionUserRef.current.id;
      const requestSequence = ++latestAuthRefetchSequence;
      let durableSession = expectedUserId !== undefined;
      if (!preservedVerifiedSession) {
        // CHECKING é uma barreira de transporte, não apenas visual. O `/me`
        // abaixo usa o escape restrito ao binding físico; tRPC/API normais
        // ficam fechados até a mesma identidade ser novamente provada.
        Auth.closeSessionTokenTransportAdmission();
        setSessionValidation(
          unprovenSessionValidation("CHECKING", requestSequence, durableSession),
        );
      } else {
        durableSession = true;
        const snapshot = verifiedSessionSnapshotRef.current;
        const currentUser = sessionUserRef.current;
        if (snapshot && currentUser) {
          verifiedSessionSnapshotRef.current = {
            userId: currentUser.id,
            ticket: snapshot.ticket,
            sequence: requestSequence,
          };
          setSessionValidation(
            verifiedSessionValidation(
              currentUser.id,
              snapshot.ticket,
              requestSequence,
            ),
          );
        }
      }
      const isLatestRequest = () =>
        workflowSignal?.aborted !== true &&
        requestSequence === latestAuthRefetchSequence &&
        requestIntentGeneration === sessionMutationState.intentGeneration &&
        appSessionEpoch.isCurrent(requestEpoch);
      const markTransientRevalidationUnavailable = () => {
        if (preservedVerifiedSession) return;
        if (isLatestRequest()) {
          setSessionValidation(
            unprovenSessionValidation(
              "UNAVAILABLE",
              requestSequence,
              durableSession,
            ),
          );
        }
      };
      let completionEpoch = requestEpoch;
      const revokeMismatchedTransport = async (
        mismatchExpectedUserId = expectedUserId,
      ): Promise<RefetchOutcome> => {
        if (!isLatestRequest()) return "STALE";
        let revocation: SessionRevocationResult;
        if (Platform.OS === "web") {
          revocation = await revokeQuarantinedWebSession(
            requestEpoch,
            mismatchExpectedUserId,
          );
        } else {
          revocation = await revokeQuarantinedNativeSession(requestEpoch);
        }
        if (!revocation.confirmed) {
          if (isLatestRequest()) {
            setSessionValidation(
              unprovenSessionValidation(
                "UNAVAILABLE",
                requestSequence,
                durableSession || mismatchExpectedUserId !== undefined,
              ),
            );
          }
          console.error(
            "[Auth] Transporte divergente mantido em quarentena; revogação não confirmada",
            revocation.error,
          );
          return "UNAVAILABLE";
        }
        try {
          const advanceEpoch = expectedUserId === undefined;
          const ending = endSession(
            requestEpoch,
            revocation.pushStateCleared,
            advanceEpoch,
          );
          if (advanceEpoch) completionEpoch = appSessionEpoch.capture();
          await ending;
          if (revocation.requiresCanonicalReadmission) {
            // O 409 apenas encerrou a autoridade stale de A. B continua sem
            // UI/push até um `/me` posterior emitir uma receipt canônica.
            sessionMutationState.reconciliationRequired = true;
          }
        } catch (error) {
          console.error(
            "[Auth] Transporte divergente; limpeza local incompleta",
            error,
          );
        }
        return "INVALID";
      };
      try {
        const webGate =
          Platform.OS === "web"
            ? await Auth.getWebSessionGateState()
            : ({ state: "CLEAR" } as const);
        if (Platform.OS === "web" && webGate.state === "REVOKE_REQUIRED") {
          if (!isLatestRequest()) return "STALE";
          const revocation = await revokeQuarantinedWebSession(requestEpoch);
          try {
            const ending = endSession(
              requestEpoch,
              revocation.pushStateCleared,
            );
            // endSession avança síncrono antes do primeiro await.
            completionEpoch = appSessionEpoch.capture();
            await ending;
            if (revocation.requiresCanonicalReadmission) {
              sessionMutationState.reconciliationRequired = true;
            }
          } catch (error) {
            console.error(
              "[Auth] Quarentena web; limpeza local incompleta",
              error,
            );
          }
          if (!revocation.confirmed) {
            console.error(
              "[Auth] Quarentena web mantida; revogação remota não confirmada",
              revocation.error,
            );
          }
          return revocation.confirmed ? "INVALID" : "UNAVAILABLE";
        }

        if (Platform.OS !== "web" && (await Auth.isSessionTokenQuarantined())) {
          if (!isLatestRequest()) return "STALE";
          const revocation = await revokeQuarantinedNativeSession(requestEpoch);
          if (!revocation.confirmed) {
            if (isLatestRequest()) {
              setSessionValidation(
                unprovenSessionValidation(
                  "UNAVAILABLE",
                  requestSequence,
                  true,
                ),
              );
            }
            console.error(
              "[Auth] Quarentena nativa mantida; revogação remota não confirmada",
              revocation.error,
            );
            return "UNAVAILABLE";
          }
          try {
            const ending = endSession(
              requestEpoch,
              revocation.pushStateCleared,
            );
            completionEpoch = appSessionEpoch.capture();
            await ending;
          } catch (error) {
            console.error(
              "[Auth] Quarentena nativa; limpeza local incompleta",
              error,
            );
          }
          return "INVALID";
        }

        const durableExpectedUserId =
          Platform.OS === "web"
            ? webGate.state === "ADMISSION"
              ? webGate.expectedUserId
              : null
            : await Auth.getAdmittedSessionUserId();
        const persistedUserId = await Auth.getPersistedUserId();
        if (durableExpectedUserId !== null || persistedUserId !== null) {
          durableSession = true;
          // Refetch soft (foco/aba/resume Android) não pode derrubar VERIFIED
          // para CHECKING: o gate institucional trata isso como perda de prova
          // e o 401 seguinte encerrava a sessão.
          if (isLatestRequest() && !preservedVerifiedSession) {
            setSessionValidation(
              unprovenSessionValidation("CHECKING", requestSequence, true),
            );
          }
        }
        if (
          Platform.OS !== "web" &&
          durableExpectedUserId === null &&
          expectedUserId === undefined
        ) {
          // Disco nativo vazio só é logout quando também não há identidade
          // persistida nem receipt VERIFIED em memória. No Android o
          // SecureStore/Keystore devolve null no resume — isso não apaga a
          // conta nem manda para o formulário de login.
          if (preservedVerifiedSession || persistedUserId !== null) {
            markTransientRevalidationUnavailable();
            return "UNAVAILABLE";
          }
          try {
            await endSession(requestEpoch, false, false, true);
          } catch (error) {
            console.error(
              "[Auth] Sessão nativa ausente; limpeza incompleta",
              error,
            );
          }
          return "INVALID";
        }
        if (
          Platform.OS !== "web" &&
          expectedUserId !== undefined &&
          durableExpectedUserId === null
        ) {
          // O commit esperado não produziu um binding ADMITTED. Não há Bearer
          // normal revogável; limpa apenas o estado local ainda incompleto.
          try {
            await endSession(requestEpoch, false, false);
          } catch (error) {
            console.error(
              "[Auth] Binding nativo divergente; limpeza incompleta",
              error,
            );
          }
          return "INVALID";
        }
        if (
          Platform.OS !== "web" &&
          expectedUserId !== undefined &&
          durableExpectedUserId !== expectedUserId
        ) {
          return await revokeMismatchedTransport(expectedUserId);
        }
        if (
          Platform.OS === "web" &&
          expectedUserId !== undefined &&
          durableExpectedUserId !== null &&
          durableExpectedUserId !== expectedUserId
        ) {
          return await revokeMismatchedTransport(expectedUserId);
        }

        // Outra revalidação/mutação pode ter encerrado esta epoch enquanto a
        // leitura do gate/storage aguardava. Não envia um `/me` sem autoridade
        // só porque a barreira anterior já foi limpa por quem venceu a corrida.
        if (!isLatestRequest()) return "STALE";

        const result = await authApi.meDetailed(
          expectedUserId ?? durableExpectedUserId ?? undefined,
        );
        if (!isLatestRequest()) return "STALE";
        if (result.code === "SESSION_BINDING_REAUTH_REQUIRED") {
          const revocationUserId =
            result.revocationUserId ??
            expectedUserId ??
            durableExpectedUserId ??
            undefined;
          if (
            revocationUserId === undefined ||
            !Number.isSafeInteger(revocationUserId) ||
            revocationUserId <= 0
          ) {
            if (isLatestRequest()) {
              setSessionValidation(
                unprovenSessionValidation(
                  "UNAVAILABLE",
                  requestSequence,
                  durableSession,
                ),
              );
            }
            return "UNAVAILABLE";
          }
          const revocation =
            Platform.OS === "web"
              ? await revokeQuarantinedWebSession(
                  requestEpoch,
                  revocationUserId,
                  result.sessionInstance,
                )
              : await revokeQuarantinedNativeSession(
                  requestEpoch,
                  undefined,
                  false,
                  revocationUserId,
                );
          if (!revocation.confirmed) {
            if (isLatestRequest()) {
              setSessionValidation(
                unprovenSessionValidation(
                  "UNAVAILABLE",
                  requestSequence,
                  true,
                ),
              );
            }
            console.error(
              "[Auth] Sessão legacy mantida em revoke-only; revogação não confirmada",
              revocation.error,
            );
            return "UNAVAILABLE";
          }
          try {
            const ending = endSession(
              requestEpoch,
              revocation.pushStateCleared,
            );
            completionEpoch = appSessionEpoch.capture();
            await ending;
            if (revocation.requiresCanonicalReadmission) {
              sessionMutationState.reconciliationRequired = true;
            }
          } catch (error) {
            console.error(
              "[Auth] Sessão legacy revogada; limpeza local incompleta",
              error,
            );
          }
          return "INVALID";
        }
        if (Platform.OS !== "web" && result.code === "EXPECTED_USER_MISMATCH") {
          return await revokeMismatchedTransport(
            expectedUserId ?? durableExpectedUserId ?? undefined,
          );
        }
        if (Platform.OS === "web" && result.code === "EXPECTED_USER_MISMATCH") {
          // `/me` apenas detecta que A ficou stale. A ADMISSION física vira
          // REVOKE_REQUIRED e só o `/logout` expected-bound pode produzir o
          // outcome canônico que remove exatamente o nonce de A sem tocar B.
          return await revokeMismatchedTransport(
            expectedUserId ?? durableExpectedUserId ?? undefined,
          );
        }
        if (result.user) {
          const refreshedUser = result.user;
          const validationReceipt = result.validationReceipt;
          if (!validationReceipt) {
            if (isLatestRequest()) {
              setSessionValidation(
                unprovenSessionValidation(
                  "UNAVAILABLE",
                  requestSequence,
                  true,
                ),
              );
            }
            return "UNAVAILABLE";
          }
          const requiredUserId = expectedUserId ?? durableExpectedUserId;
          if (requiredUserId !== null && refreshedUser.id !== requiredUserId) {
            // Um token ligado a B jamais pode publicar A num retry/remount. A
            // divergência revoga B remotamente antes de qualquer limpeza local.
            return await revokeMismatchedTransport(requiredUserId ?? undefined);
          }
          const persisted = await appSessionEpoch.runIfCurrent(
            requestEpoch,
            () => Auth.setUserInfo(refreshedUser),
          );
          if (persisted && isLatestRequest()) {
            if (Platform.OS === "web") {
              const admitted = await appSessionEpoch.runIfCurrent(
                requestEpoch,
                () => Auth.admitWebSessionTransport(validationReceipt),
              );
              if (!admitted || !isLatestRequest()) return "STALE";
            } else {
              await Auth.admitSessionTokenTransport(validationReceipt);
            }
            if (!isLatestRequest()) {
              Auth.closeSessionTokenTransportAdmission();
              return "STALE";
            }
            setUser(refreshedUser);
            setSessionValidation(
              verifiedSessionValidation(
                refreshedUser.id,
                requestEpoch,
                requestSequence,
              ),
            );
            if (sessionMutationState.reconciliationRequired) {
              openPushRegistrationAdmission();
              setPushRegistrationRevision((revision) => revision + 1);
              sessionMutationState.reconciliationRequired = false;
            }
            return "VERIFIED";
          }
        } else if (result.sessionInvalid) {
          // Um 401 de /me não é prova de revogação: indisponibilidade de banco
          // e falhas de consulta já foram projetadas assim no passado. Fecha o
          // transporte e exige o /logout 2xx tipado antes da limpeza local.
          return await revokeMismatchedTransport(
            expectedUserId ?? durableExpectedUserId ?? undefined,
          );
        } else {
          // Falha de rede/servidor (ex.: cold start do Render): não encerra uma
          // sessão já admitida em memória. No cold start nativo, porém, nenhum
          // usuário persistido é publicado antes desta validação servidor.
          console.warn(
            "[Auth] me() falhou por rede/servidor — sessão não revalidada",
          );
          markTransientRevalidationUnavailable();
          return "UNAVAILABLE";
        }
        return "STALE";
      } catch {
        // Erro inesperado: também não encerra uma sessão já admitida; no cold
        // start, continua sem autenticar até uma validação servidor bem-sucedida.
        console.warn("[Auth] me() lançou erro — sessão não revalidada");
        markTransientRevalidationUnavailable();
        return "UNAVAILABLE";
      } finally {
        if (
          requestSequence === latestAuthRefetchSequence &&
          appSessionEpoch.isCurrent(completionEpoch)
        ) {
          setIsLoading(false);
        }
      }
    },
    [endSession, revokeQuarantinedNativeSession, revokeQuarantinedWebSession],
  );

  const performRefetch = useCallback(
    (
      requestEpoch: SessionEpochTicket,
      expectedUserId?: number,
      requiredIntentGeneration = sessionMutationState.intentGeneration,
    ): Promise<RefetchOutcome> => {
      const requestIntentGeneration = requiredIntentGeneration;
      if (requestIntentGeneration !== sessionMutationState.intentGeneration) {
        return Promise.resolve("STALE");
      }
      if (webSessionWorkflowLockHeld || Platform.OS !== "web") {
        return performRefetchInsideWebLock(
          requestEpoch,
          expectedUserId,
          requestIntentGeneration,
          webSessionWorkflowSignal,
        );
      }
      const preservedVerifiedSession =
        sessionUserRef.current !== null &&
        verifiedSessionSnapshotRef.current !== null &&
        verifiedSessionSnapshotRef.current.userId === sessionUserRef.current.id;
      // Fecha a prova síncrona já na intenção, inclusive enquanto outra aba
      // ainda detém o workflow lock. Nenhum listener/request A atravessa a
      // espera e reaparece sob o cookie B.
      if (!preservedVerifiedSession) {
        closeAsyncSessionAdmission();
        // Fecha a prova síncrona já na intenção. Soft refetch (receipt
        // VERIFIED ainda válida) não incrementa aqui: o bump pré-lock
        // deixava `isCurrent()` falso enquanto outra aba detinha o lock
        // e, se /me falhasse, o gate ficava preso para sempre.
        ++latestAuthRefetchSequence;
      }
      return Auth.runExclusiveWebSessionMutation((workflowSignal) =>
        performRefetchInsideWebLock(
          requestEpoch,
          expectedUserId,
          requestIntentGeneration,
          workflowSignal,
        ),
      );
    },
    [closeAsyncSessionAdmission, performRefetchInsideWebLock],
  );

  const completeCanonicalSessionAdmission = useCallback(
    (
      expectedUserId: number,
      blockedError: string,
    ): SessionMutationCompletion<{
      ok: boolean;
      error?: string;
      admissionPending?: true;
    }> => {
      const value: {
        ok: boolean;
        error?: string;
        admissionPending?: true;
      } = {
        ok: false,
        error: blockedError,
      };
      return {
        value,
        afterSettled: async (settledEpoch, intentGeneration) => {
          const outcome = await performRefetch(
            settledEpoch,
            expectedUserId,
            intentGeneration,
          );
          if (outcome === "VERIFIED") {
            value.ok = true;
            delete value.error;
            delete value.admissionPending;
            return;
          }
          if (outcome === "INVALID") {
            value.error = "A sessão ambígua foi encerrada com segurança.";
            delete value.admissionPending;
            return;
          }
          if (outcome === "UNAVAILABLE") {
            value.admissionPending = true;
            return;
          }
          if (outcome === "STALE") {
            value.admissionPending = true;
            setSessionValidation(
              unprovenSessionValidation(
                "UNAVAILABLE",
                latestAuthRefetchSequence,
                true,
              ),
            );
          }
        },
      };
    },
    [performRefetch],
  );

  const reconcileAmbiguousSessionCommit = useCallback(
    (
      expectedUserId: number,
      blockedError: string,
    ): SessionMutationCompletion<{ ok: boolean; error?: string }> => {
      // A resposta do armazenamento é indeterminada: fecha todas as admissões e
      // remove qualquer identidade React até B ser provado por /me após o END.
      closeAsyncSessionAdmission();
      setUser(null);
      return completeCanonicalSessionAdmission(expectedUserId, blockedError);
    },
    [closeAsyncSessionAdmission, completeCanonicalSessionAdmission],
  );

  const runSessionMutation = useCallback(
    <T>(
      operation: (
        lease: Readonly<{
          epoch: SessionEpochTicket;
          sequence: number;
          reconciliationWasRequired: boolean;
          isCurrent: () => boolean;
        }>,
      ) => Promise<SessionMutationCompletion<T>>,
      webBoundary: SessionMutationWebBoundary<T>,
    ): Promise<T> => {
      const state = sessionMutationState;
      const webIntent =
        Platform.OS === "web"
          ? Auth.captureWebSessionMutationIntent(
              webBoundary.expectedUserId,
              webBoundary.requireClearGate ?? false,
            )
          : null;
      state.pending += 1;
      const intentGeneration = ++state.intentGeneration;
      // A aquisição do Web Lock pode aguardar outra aba. O transporte local
      // e todo refetch anterior precisam cair na intenção, antes dessa espera.
      Auth.closeSessionTokenTransportAdmission();
      const intentSequence = ++latestAuthRefetchSequence;
      setSessionValidation({ status: "CHECKING", sequence: intentSequence });

      const executeInsideLock = async (
        workflowSignal?: AbortSignal,
      ): Promise<T> => {
        if (Platform.OS === "web") {
          try {
            if (!webIntent) {
              throw new Error("A intenção web não possui revisão física atual");
            }
            Auth.beginWebSessionMutationIntent(webIntent);
          } catch (error) {
            // A revisão física vence qualquer closure React. A mutação é
            // cancelada antes de epoch, marker, push ou HTTP, e a UI permanece
            // fechada até o refetch/StorageEvent convergir para a sessão atual.
            closeAsyncSessionAdmission();
            state.reconciliationRequired = true;
            setUser(null);
            setSessionValidation({
              status: "UNAVAILABLE",
              sequence: ++latestAuthRefetchSequence,
            });
            console.warn(
              "[Auth] Mutação web cancelada por revisão cross-tab stale",
              error,
            );
            return webBoundary.invalidatedValue();
          }
        }
        const owner = Symbol("session-mutation");
        const epoch = appSessionEpoch.beginTransition();
        const sequence = ++latestAuthRefetchSequence;
        const reconciliationWasRequired = state.reconciliationRequired;
        state.reconciliationRequired = true;
        state.active = owner;
        setSessionValidation({ status: "CHECKING", sequence });
        const lease = {
          epoch,
          sequence,
          reconciliationWasRequired,
          isCurrent: () =>
            workflowSignal?.aborted !== true &&
            state.active === owner &&
            appSessionEpoch.isCurrent(epoch),
        } as const;

        let completion: SessionMutationCompletion<T>;
        try {
          completion = await operation(lease);
        } catch (error) {
          // END invalida todo /me/401 que tenha capturado a fase mutante, mesmo
          // quando a mutação local falha antes de produzir um resultado.
          appSessionEpoch.beginTransition();
          if (state.active === owner) state.active = null;
          throw error;
        }

        const stillOwner =
          state.active === owner && state.intentGeneration === intentGeneration;
        const settledEpoch = appSessionEpoch.beginTransition();
        if (!stillOwner) return completion.value;
        try {
          await completion.afterSettled?.(settledEpoch, intentGeneration);
        } finally {
          if (state.active === owner) state.active = null;
        }
        return completion.value;
      };

      const execute = async (): Promise<T> =>
        Auth.runExclusiveWebSessionMutation(async (workflowSignal) => {
          const previousLockState = webSessionWorkflowLockHeld;
          const previousWorkflowSignal = webSessionWorkflowSignal;
          webSessionWorkflowLockHeld = Platform.OS === "web";
          webSessionWorkflowSignal = workflowSignal ?? null;
          try {
            return await executeInsideLock(workflowSignal);
          } finally {
            webSessionWorkflowLockHeld = previousLockState;
            webSessionWorkflowSignal = previousWorkflowSignal;
          }
        });

      // A primeira lease começa sincronicamente (bump antes de qualquer await).
      // As seguintes são enfileiradas e mantêm `pending > 0`, bloqueando refetch
      // externo durante toda a cadeia, inclusive a revalidação pós-END.
      const operationPromise =
        state.pending === 1 && state.active === null
          ? execute()
          : state.tail.then(execute, execute);
      const tracked = operationPromise.finally(() => {
        if (webIntent) Auth.discardWebSessionMutationIntent(webIntent);
        state.pending -= 1;
      });
      state.tail = tracked.then(
        () => undefined,
        () => undefined,
      );
      return tracked;
    },
    [closeAsyncSessionAdmission],
  );

  const refetch = useCallback(async () => {
    const state = sessionMutationState;
    while (state.pending > 0) {
      const observedTail = state.tail;
      await observedTail;
      if (observedTail === state.tail && state.pending === 0) break;
    }
    await performRefetch(appSessionEpoch.capture());
  }, [performRefetch]);

  // Qualquer UNAUTHORIZED do tRPC (ver lib/session-events.ts) revalida a
  // sessão — no máximo uma vez a cada 10 s, para um lote de consultas
  // falhando junto não virar dez chamadas a /me.
  useEffect(() => {
    let lastCheck = 0;
    return onSessionUnauthorized(() => {
      const now = Date.now();
      if (now - lastCheck < 10_000) return;
      lastCheck = now;
      void refetch();
    });
  }, [refetch]);

  // Cold start sempre consulta /me. Remount com receipt VERIFIED herdada
  // (web e nativo) também consulta, mas em modo soft: performRefetch
  // preserva VERIFIED e não vai para CHECKING/logout (regressão #287/#288
  // e o resume Android). Pular o /me para sempre deixava
  // `latestAuthRefetchSequence` stale — o gate institucional nunca
  // completava e toques de push eram descartados.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(
    () =>
      Auth.subscribeExternalWebSessionInvalidation(() => {
        // Outra aba pode substituir o cookie sem provocar rerender aqui. A
        // notificação local fecha push/cache e invalida qualquer lease/receipt
        // na mesma task; a revalidação aguarda o workflow lock remoto.
        clearPreservedWebVerifiedSession();
        restoredWebSessionRef.current = null;
        closeAsyncSessionAdmission();
        sessionMutationState.active = null;
        sessionMutationState.intentGeneration += 1;
        sessionMutationState.reconciliationRequired = true;
        appSessionEpoch.beginTransition();
        setSessionValidation({
          status: "UNAVAILABLE",
          sequence: ++latestAuthRefetchSequence,
        });
        void refetch();
      }),
    [closeAsyncSessionAdmission, refetch],
  );

  const login = useCallback(
    (
      email: string,
      password: string,
    ): Promise<{ ok: boolean; error?: string; admissionPending?: true }> => {
      const previousTransportTicket =
        Platform.OS === "web" ? Auth.captureSessionTransportTicket() : null;
      const previousExpectedUserId =
        previousTransportTicket === null
          ? undefined
          : (Auth.getSessionTransportExpectedUserId(previousTransportTicket) ??
            undefined);
      const previousSessionInstance =
        previousTransportTicket === null
          ? undefined
          : (Auth.getSessionTransportSessionInstance(previousTransportTicket) ??
            undefined);
      return runSessionMutation<{
        ok: boolean;
        error?: string;
        admissionPending?: true;
      }>(
        async (lease) => {
          let capabilityReceipt: SessionBindingCapabilityReceipt | undefined;
          let webLoginTicket: Auth.WebLoginInProgress | undefined;
          try {
            if (exactSessionBindingClientActive()) {
              capabilityReceipt =
                await authApi.prepareSessionBindingMutation("login");
            }
          } catch {
            return {
              value: {
                ok: false,
                error:
                  "Login bloqueado: o servidor ainda não confirmou o protocolo seguro de sessão.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  previousExpectedUserId ?? user?.id,
                  intentGeneration,
                );
              },
            };
          }
          closeAsyncSessionAdmission();
          // Login pode trocar de conta. Enquanto B não for provado por /me, nem a
          // UI nem o listener account-scoped podem continuar operando como A.
          setUser(null);

          // Nunca sobrescreve a única prova local de uma sessão B ainda não
          // revogada. Isso também serializa uma troca explícita de conta: a sessão
          // anterior precisa ser revogada e limpa antes do POST que pode emitir C.
          let previousRevocation: SessionRevocationResult | null = null;
          const revocationAlreadyInFlight =
            Platform.OS === "web"
              ? webSessionRevocationFlight !== null
              : nativeSessionRevocationFlight !== null;
          if (revocationAlreadyInFlight) {
            previousRevocation =
              Platform.OS === "web"
                ? await revokeQuarantinedWebSession(lease.epoch)
                : await revokeQuarantinedNativeSession(lease.epoch);
          } else if (Platform.OS === "web") {
            // CLEAR só prova ausência do marker local; não prova ausência do
            // cookie HttpOnly. Todo novo login web revoga canonicamente o cookie
            // corrente antes do POST, inclusive troca A→B e cold boot com estado
            // local vazio. Assim cópias de A não sobrevivem ao Set-Cookie de B.
            previousRevocation = await revokeQuarantinedWebSession(
              lease.epoch,
              previousExpectedUserId,
              previousSessionInstance,
            );
          } else {
            let hasPreviousSession = false;
            try {
              hasPreviousSession =
                (await Auth.isSessionTokenQuarantined()) ||
                (await Auth.getAdmittedSessionUserId()) !== null;
            } catch (error) {
              previousRevocation = {
                confirmed: false,
                pushStateCleared: false,
                error,
              };
            }
            if (hasPreviousSession) {
              previousRevocation = await revokeQuarantinedNativeSession(
                lease.epoch,
              );
            }
          }
          if (!lease.isCurrent()) {
            return {
              value: {
                ok: false,
                error:
                  "Este login foi substituído por uma sessão mais recente.",
              },
            };
          }
          if (previousRevocation && !previousRevocation.confirmed) {
            setSessionValidation({
              status: "UNAVAILABLE",
              sequence: lease.sequence,
            });
            console.error(
              "[Auth] Login bloqueado por sessão anterior não revogada",
              previousRevocation.error,
            );
            return {
              value: {
                ok: false,
                error:
                  "Login bloqueado: a sessão anterior ainda exige revogação.",
              },
            };
          }
          if (previousRevocation?.confirmed) {
            try {
              await endSession(
                lease.epoch,
                previousRevocation.pushStateCleared,
                false,
              );
              if (previousRevocation.requiresCanonicalReadmission) {
                sessionMutationState.reconciliationRequired = true;
              }
            } catch (error) {
              setSessionValidation({
                status: "UNAVAILABLE",
                sequence: lease.sequence,
              });
              console.error(
                "[Auth] Limpeza da sessão anterior incompleta",
                error,
              );
              return {
                value: {
                  ok: false,
                  error:
                    "Login bloqueado: a sessão anterior não foi limpa neste aparelho.",
                },
              };
            }
          }
          sessionMutationState.reconciliationRequired = true;
          if (Platform.OS === "web") {
            try {
              // A barreira antecede o request: se o processo morrer depois de o
              // navegador aceitar Set-Cookie, o próximo boot revoga antes de /me.
              webLoginTicket = await Auth.beginWebLoginInProgress();
            } catch {
              setSessionValidation({
                status: "UNAVAILABLE",
                sequence: lease.sequence,
              });
              return {
                value: {
                  ok: false,
                  error: "Não foi possível preparar o login web com segurança.",
                },
                afterSettled: async (settledEpoch, intentGeneration) => {
                  await performRefetch(
                    settledEpoch,
                    undefined,
                    intentGeneration,
                  );
                },
              };
            }
          }

          let result: Awaited<ReturnType<typeof authApi.login>>;
          try {
            result = capabilityReceipt
              ? await authApi.login(
                  email,
                  password,
                  capabilityReceipt,
                  webLoginTicket,
                )
              : await authApi.login(email, password, undefined, webLoginTicket);
          } catch {
            if (webLoginTicket) {
              try {
                await Auth.cancelWebLoginInProgress(webLoginTicket);
                return {
                  value: {
                    ok: false,
                    error: "O login não chegou a ser enviado ao servidor.",
                  },
                  afterSettled: async (settledEpoch, intentGeneration) => {
                    await performRefetch(
                      settledEpoch,
                      undefined,
                      intentGeneration,
                    );
                  },
                };
              } catch {
                // Capability já consumida: o request pode ter sido despachado.
                // O rollback abaixo exige logout remoto tipado.
              }
            }
            return {
              value: await rollbackFailedLogin(
                lease.epoch,
                "Não foi possível concluir o login com segurança.",
              ),
            };
          }
          if (!lease.isCurrent()) {
            return {
              value: {
                ok: false,
                error:
                  "Este login foi substituído por uma sessão mais recente.",
              },
            };
          }
          if (!result.ok) {
            if (Platform.OS === "web") {
              return {
                value: await rollbackFailedLogin(
                  lease.epoch,
                  result.error ?? "Credenciais inválidas",
                ),
              };
            }
            setSessionValidation({
              status: "UNAVAILABLE",
              sequence: lease.sequence,
            });
            return {
              value: { ok: false, error: result.error },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(settledEpoch, undefined, intentGeneration);
              },
            };
          }
          if (!result.user) {
            return {
              value: await rollbackFailedLogin(
                lease.epoch,
                "O servidor não devolveu uma identidade válida.",
                result.token,
              ),
            };
          }

          const authenticatedUser = result.user;
          const nativeToken = Platform.OS === "web" ? undefined : result.token;
          if (Platform.OS !== "web" && !nativeToken) {
            return {
              value: await rollbackFailedLogin(
                lease.epoch,
                "O servidor não devolveu uma sessão válida.",
              ),
            };
          }

          let commitAttempted = false;
          try {
            let stagedToken: Auth.StagedSessionToken | undefined;
            if (nativeToken) {
              stagedToken = await Auth.stageSessionToken(
                nativeToken,
                authenticatedUser.id,
              );
            }
            if (!lease.isCurrent())
              throw new Error("Lease de login substituída");

            // Limpa ANTES de publicar o usuário. B continua inacessível pelo marker
            // enquanto tenant/cache/identidade são persistidos.
            queryClient.clear();
            await clearActiveInstitutionId();
            if (!lease.isCurrent())
              throw new Error("Lease de login substituída");
            await Auth.setUserInfo(authenticatedUser);
            if (!lease.isCurrent())
              throw new Error("Lease de login substituída");

            if (stagedToken) {
              // Última etapa falível: só este commit libera o Bearer B.
              commitAttempted = true;
              await Auth.commitStagedSessionToken(stagedToken);
            } else {
              await Auth.prepareWebSessionAdmission(authenticatedUser.id);
            }
          } catch (error) {
            if (
              nativeToken &&
              commitAttempted &&
              isAmbiguousSessionTokenCommit(error)
            ) {
              return reconcileAmbiguousSessionCommit(
                authenticatedUser.id,
                "Não foi possível confirmar a sessão local; a revalidação permanece bloqueada.",
              );
            }
            return {
              value: await rollbackFailedLogin(
                lease.epoch,
                "Não foi possível concluir o login com segurança neste aparelho.",
                nativeToken,
                false,
                false,
                authenticatedUser.id,
                result.sessionInstance,
              ),
            };
          }

          // Cookie/token já estão no aparelho. Se o /me falhar por cold start,
          // a UI deve pedir nova prova — não devolver o formulário vazio.
          setSessionValidation(
            unprovenSessionValidation("CHECKING", lease.sequence, true),
          );
          return completeCanonicalSessionAdmission(
            authenticatedUser.id,
            "O login foi recebido, mas a sessão ainda não pôde ser revalidada.",
          );
        },
        {
          invalidatedValue: () => ({
            ok: false,
            error:
              "Este login foi cancelado porque a sessão mudou em outra aba.",
          }),
        },
      );
    },
    [
      closeAsyncSessionAdmission,
      completeCanonicalSessionAdmission,
      endSession,
      performRefetch,
      queryClient,
      reconcileAmbiguousSessionCommit,
      revokeQuarantinedNativeSession,
      revokeQuarantinedWebSession,
      rollbackFailedLogin,
      runSessionMutation,
      user,
    ],
  );

  const rotateSession = useCallback(
    (
      operation: (
        credential: Auth.SessionTransitionCredential,
        capabilityReceipt?: SessionBindingCapabilityReceipt,
      ) => Promise<{
        ok: boolean;
        token?: string;
        error?: string;
        status?: number;
        code?: AuthMutationErrorCode;
      }>,
    ): Promise<{ ok: boolean; error?: string }> => {
      const expectedRotationUser = user;
      const transitionCredential = expectedRotationUser
        ? Auth.captureSessionTransitionCredential(
            "rotate-session",
            expectedRotationUser.id,
          )
        : null;
      const mutation = runSessionMutation<{
        ok: boolean;
        error?: string;
      }>(
        async (lease) => {
          if (!transitionCredential || !expectedRotationUser) {
            return {
              value: {
                ok: false,
                error: "A sessão precisa ser revalidada antes desta operação.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedRotationUser?.id,
                  intentGeneration,
                );
              },
            };
          }
          if (lease.reconciliationWasRequired) {
            // Uma mutação anterior ainda não assentou transporte/identidade. A
            // próxima troca de senha jamais pode consumir B usando a closure A; ela
            // apenas repete a revalidação canônica depois do END desta lease.
            return {
              value: {
                ok: false,
                error: "A sessão anterior ainda está sendo reconciliada.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedRotationUser.id,
                  intentGeneration,
                );
              },
            };
          }
          let capabilityReceipt: SessionBindingCapabilityReceipt | undefined;
          try {
            if (exactSessionBindingClientActive()) {
              capabilityReceipt =
                await authApi.prepareSessionBindingMutation("rotate-session");
            }
          } catch {
            return {
              value: {
                ok: false,
                error:
                  "A troca foi bloqueada: o servidor ainda não confirmou o protocolo seguro de sessão.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedRotationUser.id,
                  intentGeneration,
                );
              },
            };
          }
          // O servidor remove os registros push no mesmo commit da rotação. A prova
          // local precisa ser invalidada DURAVELMENTE antes da chamada remota: se o
          // processo morrer depois do commit, o próximo cold start obrigatoriamente
          // faz POST em vez de confiar numa row que já foi revogada.
          closePushRegistrationAdmission();
          sessionMutationState.reconciliationRequired = true;
          await waitForPushRegistrationIdle();
          if (!lease.isCurrent()) {
            return {
              value: {
                ok: false,
                error: "A sessão mudou durante esta operação.",
              },
            };
          }
          try {
            await clearPushRegistrationState();
          } catch {
            if (!lease.isCurrent()) {
              return {
                value: {
                  ok: false,
                  error: "A sessão mudou durante esta operação.",
                },
              };
            }
            return {
              value: {
                ok: false,
                error:
                  "Não foi possível preparar com segurança a troca de senha.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedRotationUser.id,
                  intentGeneration,
                );
              },
            };
          }
          if (!lease.isCurrent()) {
            return {
              value: {
                ok: false,
                error: "A sessão mudou durante esta operação.",
              },
            };
          }

          if (Platform.OS === "web") {
            if (!user) {
              return {
                value: {
                  ok: false,
                  error:
                    "A identidade atual não está disponível para esta operação.",
                },
              };
            }
            try {
              // O cookie pode girar dentro da operação. A expectativa durável deve
              // existir antes do request para sobreviver a resposta perdida/reload.
              await Auth.beginWebSessionAdmission(user.id);
            } catch {
              setSessionValidation({
                status: "UNAVAILABLE",
                sequence: lease.sequence,
              });
              return {
                value: {
                  ok: false,
                  error:
                    "Não foi possível preparar a revalidação da sessão web.",
                },
                afterSettled: async (settledEpoch, intentGeneration) => {
                  // Se o write foi aplicado e só o ACK se perdeu, o ADMISSION
                  // durável carrega a identidade esperada. Se o gate ficou CLEAR,
                  // nenhum request remoto ocorreu e /me ainda precisa provar A.
                  await performRefetch(
                    settledEpoch,
                    expectedRotationUser.id,
                    intentGeneration,
                  );
                },
              };
            }
            if (!lease.isCurrent()) {
              return {
                value: {
                  ok: false,
                  error: "A sessão mudou durante esta operação.",
                },
              };
            }
          }

          let result: {
            ok: boolean;
            token?: string;
            error?: string;
            status?: number;
            code?: AuthMutationErrorCode;
          };
          try {
            result = capabilityReceipt
              ? await operation(transitionCredential, capabilityReceipt)
              : await operation(transitionCredential);
          } catch (error) {
            setSessionValidation({
              status: "UNAVAILABLE",
              sequence: lease.sequence,
            });
            return {
              value: {
                ok: false,
                error: "Não foi possível confirmar a troca de senha.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedRotationUser.id,
                  intentGeneration,
                );
                throw error;
              },
            };
          }
          if (!lease.isCurrent()) {
            return {
              value: {
                ok: false,
                error: "A sessão mudou durante esta operação.",
              },
            };
          }
          if (!result.ok) {
            if (
              Platform.OS === "web" &&
              isSessionMutationMismatchCode(result.code)
            ) {
              return {
                value: {
                  ok: false,
                  error: "A sessão mudou em outra aba antes da operação.",
                },
                afterSettled: async (settledEpoch, intentGeneration) => {
                  // Só /me canônico pode abandonar a ADMISSION stale; o
                  // finalizador privado vive na mesma autoridade do request.
                  await performRefetch(
                    settledEpoch,
                    expectedRotationUser.id,
                    intentGeneration,
                  );
                },
              };
            }
            // 401/409/500 são indistinguíveis aqui: a transação remota pode ter
            // commitado antes de a resposta falhar. Nenhum deles fabrica VERIFIED.
            setSessionValidation({
              status: "UNAVAILABLE",
              sequence: lease.sequence,
            });
            const reconciledResult: { ok: boolean; error?: string } = {
              ok: false,
              error: result.error,
            };
            return {
              value: reconciledResult,
              afterSettled: async (settledEpoch, intentGeneration) => {
                const outcome = await performRefetch(
                  settledEpoch,
                  expectedRotationUser.id,
                  intentGeneration,
                );
                if (outcome === "UNAVAILABLE" || outcome === "STALE") {
                  reconciledResult.error =
                    "Não foi possível confirmar o resultado da troca de senha.";
                }
              },
            };
          }

          if (Platform.OS !== "web") {
            if (!result.token) {
              return {
                value: await rollbackFailedLogin(
                  lease.epoch,
                  "O servidor não devolveu uma sessão válida.",
                  undefined,
                  true,
                  true,
                ),
              };
            }
            let commitAttempted = false;
            try {
              if (!lease.isCurrent() || !expectedRotationUser) {
                throw new Error("A identidade da rotação não é mais atual");
              }
              const stagedToken = await Auth.stageSessionToken(
                result.token,
                expectedRotationUser.id,
              );
              // A identidade conhecida precisa estar durável antes de B ganhar
              // autoridade; o /me pós-END ainda é a prova canônica para a UI tenant.
              await Auth.setUserInfo(expectedRotationUser);
              if (!lease.isCurrent())
                throw new Error("Lease de rotação substituída");
              commitAttempted = true;
              await Auth.commitStagedSessionToken(stagedToken);
            } catch (error) {
              if (
                commitAttempted &&
                expectedRotationUser &&
                isAmbiguousSessionTokenCommit(error)
              ) {
                return reconcileAmbiguousSessionCommit(
                  expectedRotationUser.id,
                  "Não foi possível confirmar a nova sessão; a revalidação permanece bloqueada.",
                );
              }
              return {
                value: await rollbackFailedLogin(
                  lease.epoch,
                  "A senha foi alterada, mas a nova sessão não pôde ser salva com segurança.",
                  result.token,
                  true,
                  false,
                  expectedRotationUser?.id,
                ),
              };
            }
          }

          if (!user) {
            return {
              value: {
                ok: false,
                error:
                  "A identidade da sessão não está disponível para revalidação.",
              },
            };
          }
          return completeCanonicalSessionAdmission(
            user.id,
            "A operação foi recebida, mas a nova sessão ainda não pôde ser revalidada.",
          );
        },
        {
          expectedUserId: expectedRotationUser?.id,
          requireClearGate: true,
          invalidatedValue: () => ({
            ok: false,
            error: "A sessão mudou em outra aba antes da operação.",
          }),
        },
      );
      return mutation.finally(() => {
        if (transitionCredential) {
          Auth.discardSessionTransitionCredential(transitionCredential);
        }
      });
    },
    [
      completeCanonicalSessionAdmission,
      performRefetch,
      reconcileAmbiguousSessionCommit,
      rollbackFailedLogin,
      runSessionMutation,
      user,
    ],
  );

  const logout = useCallback((): Promise<void> => {
    const logoutTransportTicket =
      Platform.OS === "web" && user
        ? Auth.captureSessionTransportTicket()
        : null;
    const logoutSessionInstance =
      logoutTransportTicket === null
        ? null
        : Auth.getSessionTransportSessionInstance(logoutTransportTicket);
    return runSessionMutation<void>(
      async (lease) => {
        const revocationAlreadyInFlight =
          Platform.OS === "web"
            ? webSessionRevocationFlight !== null
            : nativeSessionRevocationFlight !== null;
        let explicitRevocation: SessionRevocationResult | null = null;
        if (Platform.OS !== "web") {
          // Logout nativo é monotônico: ADMITTED/PENDING vira revoke-only e
          // nunca volta a COMMITTED por inferência de /me. Um 500 preserva o
          // mesmo Bearer para o próximo POST /logout tipado.
          explicitRevocation = await revokeQuarantinedNativeSession(
            lease.epoch,
            undefined,
            false,
            user?.id,
          );
        } else if (revocationAlreadyInFlight) {
          explicitRevocation = await revokeQuarantinedWebSession(
            lease.epoch,
            user?.id,
            logoutSessionInstance ?? undefined,
          );
        } else {
          try {
            const gate = await Auth.getWebSessionGateState();
            if (gate.state !== "CLEAR") {
              explicitRevocation = await revokeQuarantinedWebSession(
                lease.epoch,
                user?.id,
                logoutSessionInstance ?? undefined,
              );
            } else if (user && !logoutSessionInstance) {
              explicitRevocation = {
                confirmed: false,
                pushStateCleared: false,
                error: new Error(
                  "Instância canônica da sessão web indisponível",
                ),
              };
            }
          } catch (error) {
            explicitRevocation = {
              confirmed: false,
              pushStateCleared: false,
              error,
            };
          }
        }
        if (explicitRevocation) {
          // Uma revogação explícita já possui o único efeito remoto autoritativo
          // deste transporte. O botão de logout junta o mesmo ACK em vez de
          // enfileirar um segundo POST que poderia receber 401 após o primeiro 2xx.
          closePushRegistrationAdmission();
          suspendQueryCachePersistence();
          if (!lease.isCurrent()) return { value: undefined };
          if (explicitRevocation.confirmed) {
            await endSession(
              lease.epoch,
              explicitRevocation.pushStateCleared,
              false,
            );
            if (explicitRevocation.requiresCanonicalReadmission) {
              sessionMutationState.reconciliationRequired = true;
            }
            return { value: undefined };
          }
          setSessionValidation({
            status: "UNAVAILABLE",
            sequence: lease.sequence,
          });
          return {
            value: undefined,
            afterSettled: async () => {
              // Sem prova 2xx tipada, mantém REVOKE_REQUIRED e espera a próxima
              // tentativa de logout; não consulta /me para fabricar ACK.
              throw new SessionTerminationNotDurableError(
                explicitRevocation.error,
              );
            },
          };
        }

        // O logout HTTP ainda pode falhar. Fecha push e pausa a persistência
        // antes do primeiro await, mas guarda um rollback CAS para a MESMA lease:
        // se o servidor não revogar a sessão, usuário/cache permanecem válidos e
        // a gravação local volta imediatamente, sem depender de remount.
        closePushRegistrationAdmission();
        sessionMutationState.reconciliationRequired = true;
        suspendQueryCachePersistence();
        await waitForPushRegistrationIdle();
        if (!lease.isCurrent()) return { value: undefined };
        const pushToken = getLastPushToken();
        try {
          // Barreira de crash: nenhuma chamada que revoga a row no servidor pode
          // começar enquanto uma prova fresca dessa row ainda estiver no disco.
          await clearPushRegistrationState();
        } catch (error) {
          if (!lease.isCurrent()) return { value: undefined };
          setSessionValidation({
            status: "UNAVAILABLE",
            sequence: lease.sequence,
          });
          return {
            value: undefined,
            afterSettled: async (settledEpoch, intentGeneration) => {
              const outcome = await performRefetch(
                settledEpoch,
                user?.id,
                intentGeneration,
              );
              if (outcome === "INVALID") return;
              throw new SessionTerminationNotDurableError(error);
            },
          };
        }
        if (!lease.isCurrent()) return { value: undefined };
        if (Platform.OS === "web") {
          try {
            await Auth.beginWebSessionQuarantine(
              user?.id,
              logoutSessionInstance ?? undefined,
            );
          } catch (error) {
            setSessionValidation({
              status: "UNAVAILABLE",
              sequence: lease.sequence,
            });
            return {
              value: undefined,
              afterSettled: async (settledEpoch, intentGeneration) => {
                const outcome = await performRefetch(
                  settledEpoch,
                  user?.id,
                  intentGeneration,
                );
                if (outcome === "INVALID") return;
                throw new SessionTerminationNotDurableError(error);
              },
            };
          }
        }
        if (!lease.isCurrent()) return { value: undefined };
        let requiresCanonicalReadmission = false;
        try {
          if (Platform.OS === "web") {
            // A autoridade web funde POST + parser tipado + CAS do nonce. O
            // hook não recebe uma API capaz de limpar REVOKE_REQUIRED por
            // disciplina ou por um status fabricado pelo caller.
            const outcome = await Auth.revokeWebSessionQuarantine(
              user?.id,
              logoutSessionInstance ?? undefined,
            );
            requiresCanonicalReadmission =
              outcome.status === "STALE_QUARANTINE_CLEARED";
          } else {
            await authApi.logout(
              pushToken,
              user?.id,
              logoutSessionInstance ?? undefined,
            );
          }
        } catch (error) {
          if (!lease.isCurrent()) return { value: undefined };
          setSessionValidation({
            status: "UNAVAILABLE",
            sequence: lease.sequence,
          });
          return {
            value: undefined,
            afterSettled: async (settledEpoch, intentGeneration) => {
              // Resposta perdida mantém o marker fechado. O refetch encontra
              // REVOKE_REQUIRED e repete o logout tipado; /me nunca é prova de
              // revogação remota.
              const outcome = await performRefetch(
                settledEpoch,
                user?.id,
                intentGeneration,
              );
              if (outcome === "INVALID") return;
              throw new SessionTerminationNotDurableError(error);
            },
          };
        }
        if (!lease.isCurrent()) return { value: undefined };
        await endSession(lease.epoch, true, false);
        if (requiresCanonicalReadmission) {
          sessionMutationState.reconciliationRequired = true;
        }
        return { value: undefined };
      },
      {
        expectedUserId: user?.id,
        invalidatedValue: () => undefined,
      },
    );
  }, [
    endSession,
    performRefetch,
    revokeQuarantinedNativeSession,
    revokeQuarantinedWebSession,
    runSessionMutation,
    user,
  ]);

  const deleteAccount = useCallback(
    (
      password: string,
    ): Promise<{
      ok: boolean;
      status: number;
      error?: string;
      code?: AuthMutationErrorCode;
    }> => {
      const expectedDeletionUser = user;
      const deletionTransportTicket =
        Platform.OS === "web" && expectedDeletionUser
          ? Auth.captureSessionTransportTicket()
          : null;
      const deletionSessionInstance =
        deletionTransportTicket === null
          ? undefined
          : (Auth.getSessionTransportSessionInstance(deletionTransportTicket) ??
            undefined);
      const transitionCredential = expectedDeletionUser
        ? Auth.captureSessionTransitionCredential(
            "delete-account",
            expectedDeletionUser.id,
          )
        : null;
      let reversibleNativeDeletion: Auth.ReversibleSessionRevocation | null =
        null;
      let reversibleWebDeletion: Auth.ReversibleWebSessionRevocation | null =
        null;
      const mutation = runSessionMutation<{
        ok: boolean;
        status: number;
        error?: string;
        code?: AuthMutationErrorCode;
      }>(
        async (lease) => {
          if (!transitionCredential || !expectedDeletionUser) {
            return {
              value: {
                ok: false,
                status: 0,
                error: "A sessão precisa ser revalidada antes da exclusão.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedDeletionUser?.id,
                  intentGeneration,
                );
              },
            };
          }
          if (lease.reconciliationWasRequired) {
            return {
              value: {
                ok: false,
                status: 0,
                error: "A sessão anterior ainda está sendo reconciliada.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedDeletionUser.id,
                  intentGeneration,
                );
              },
            };
          }
          let capabilityReceipt: SessionBindingCapabilityReceipt | undefined;
          try {
            if (exactSessionBindingClientActive()) {
              capabilityReceipt =
                await authApi.prepareSessionBindingMutation("delete-account");
            }
          } catch {
            return {
              value: {
                ok: false,
                status: 0,
                code: "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
                error:
                  "A exclusão foi bloqueada: o servidor ainda não confirmou o protocolo seguro de sessão.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedDeletionUser.id,
                  intentGeneration,
                );
              },
            };
          }
          try {
            if (Platform.OS === "web") {
              // DELETE é terminal/ambíguo: cold restart nunca pode readmitir A.
              // Só a receipt deste processo restaura após 4xx precommit.
              reversibleWebDeletion =
                await Auth.prepareReversibleWebSessionRevocation(
                  expectedDeletionUser.id,
                  deletionSessionInstance,
                );
            } else {
              reversibleNativeDeletion =
                await Auth.prepareReversibleSessionTokenRevocation(
                  expectedDeletionUser.id,
                );
              Auth.bindSessionTransitionCredentialToReversibleRevocation(
                transitionCredential,
                reversibleNativeDeletion,
              );
            }
          } catch {
            return {
              value: {
                ok: false,
                status: 0,
                error:
                  "Não foi possível preparar com segurança a exclusão da conta.",
              },
              afterSettled: async (settledEpoch, intentGeneration) => {
                await performRefetch(
                  settledEpoch,
                  expectedDeletionUser.id,
                  intentGeneration,
                );
              },
            };
          }
          // DELETE /me pode limpar o cookie e revoga os registros push no mesmo
          // commit. Pausa a persistência antes de fechar a admissão, e invalida a
          // prova push antes do request remoto, mantendo a operação inteira no
          // mesmo Web Lock de login/logout.
          const resumePersistence = suspendQueryCachePersistence();
          const cancelBeforeRemoteRequest = async (
            settledEpoch: SessionEpochTicket,
            intentGeneration: number,
          ): Promise<void> => {
            const isIntentCurrent = () =>
              appSessionEpoch.isCurrent(settledEpoch) &&
              sessionMutationState.intentGeneration === intentGeneration;
            if (!isIntentCurrent()) return;
            try {
              if (Platform.OS === "web") {
                if (!reversibleWebDeletion) {
                  throw new Error("Receipt web da exclusão indisponível");
                }
                // A capability só cancela o marker enquanto o cliente HTTP
                // ainda não a consumiu. Depois do dispatch, nem um 4xx pode
                // restaurar/limpar REVOKE_REQUIRED por status fornecido pelo
                // caller: a convergência passa pelo /logout tipado.
                await Auth.cancelReversibleWebSessionRevocation(
                  reversibleWebDeletion,
                );
              } else {
                if (!reversibleNativeDeletion) {
                  throw new Error("Receipt nativa da exclusão indisponível");
                }
                await Auth.restoreReversibleSessionTokenAdmission(
                  reversibleNativeDeletion,
                );
              }
              if (!isIntentCurrent()) {
                Auth.closeSessionTokenTransportAdmission();
                return;
              }
            } catch (error) {
              if (isIntentCurrent()) {
                setSessionValidation({
                  status: "UNAVAILABLE",
                  sequence: ++latestAuthRefetchSequence,
                });
              }
              console.error(
                "[Auth] DELETE não iniciado não cancelou sua barreira local",
                error,
              );
              return;
            }
            const outcome = await performRefetch(
              settledEpoch,
              expectedDeletionUser.id,
              intentGeneration,
            );
            if (outcome === "VERIFIED" && isIntentCurrent()) {
              resumePersistence();
            }
          };
          closePushRegistrationAdmission();
          await waitForPushRegistrationIdle();
          try {
            await clearPushRegistrationState();
          } catch (error) {
            const value = {
              ok: false,
              status: 0,
              error: "Não foi possível preparar a exclusão com segurança.",
            } as const;
            return {
              value,
              afterSettled: async (settledEpoch, intentGeneration) => {
                await cancelBeforeRemoteRequest(settledEpoch, intentGeneration);
                console.error(
                  "[Auth] Exclusão não iniciou por falha da barreira push",
                  error,
                );
              },
            };
          }
          if (!lease.isCurrent()) {
            return {
              value: {
                ok: false,
                status: 0,
                error: "A sessão mudou durante a exclusão.",
              },
            };
          }

          let result: Awaited<ReturnType<typeof authApi.deleteAccount>>;
          try {
            if (Platform.OS === "web") {
              result = capabilityReceipt
                ? await authApi.deleteAccount(
                    password,
                    transitionCredential,
                    capabilityReceipt,
                    reversibleWebDeletion ?? undefined,
                  )
                : await authApi.deleteAccount(
                    password,
                    transitionCredential,
                    undefined,
                    reversibleWebDeletion ?? undefined,
                  );
            } else {
              if (!reversibleNativeDeletion) {
                throw new Error(
                  "Receipt nativa da exclusão indisponível antes do request",
                );
              }
              result = await Auth.deleteAccountWithReversibleSessionCleanup(
                password,
                transitionCredential,
                reversibleNativeDeletion,
              );
            }
          } catch (error) {
            result = {
              ok: false,
              status: 0,
              error:
                error instanceof Error
                  ? error.message
                  : "Não foi possível confirmar a exclusão da conta.",
            };
          }

          let requiresCanonicalReadmission = false;
          if (Platform.OS === "web") {
            try {
              // Mesmo o DELETE 2xx não entrega ao hook autoridade para liberar
              // o nonce. Um /logout real e tipado confirma ROTATED ou
              // ALREADY_INVALID; erro/rede mantém a barreira para retry/cold boot.
              const outcome = await Auth.revokeWebSessionQuarantine(
                expectedDeletionUser.id,
                deletionSessionInstance,
              );
              requiresCanonicalReadmission =
                outcome.status === "STALE_QUARANTINE_CLEARED";
            } catch (error) {
              setSessionValidation({
                status: "UNAVAILABLE",
                sequence: lease.sequence,
              });
              console.error(
                "[Auth] DELETE não obteve prova tipada de encerramento web",
                error,
              );
              return { value: result };
            }
            await endSession(lease.epoch, true, false);
            if (requiresCanonicalReadmission) {
              sessionMutationState.reconciliationRequired = true;
            }
            return {
              value: isSessionMutationMismatchCode(result.code)
                ? {
                    ...result,
                    error: "A sessão mudou em outra aba antes da exclusão.",
                  }
                : result,
            };
          }

          if (result.ok) {
            await endSession(lease.epoch, true, false);
            return { value: result };
          }

          const conclusivelyPrecommit =
            result.code === "SESSION_BINDING_CAPABILITY_UNAVAILABLE" ||
            result.status === 400 ||
            result.status === 401 ||
            result.status === 403 ||
            result.status === 409 ||
            result.status === 428;
          if (!conclusivelyPrecommit) {
            // Rede/5xx/malformed podem esconder um commit. A sessão continua
            // PENDING/REVOKE_REQUIRED; cold restart só sabe revogar, nunca
            // readmitir A por conveniência.
            setSessionValidation({
              status: "UNAVAILABLE",
              sequence: lease.sequence,
            });
            return { value: result };
          }

          return {
            value: result,
            afterSettled: async (settledEpoch, intentGeneration) => {
              await cancelBeforeRemoteRequest(settledEpoch, intentGeneration);
            },
          };
        },
        {
          expectedUserId: expectedDeletionUser?.id,
          requireClearGate: true,
          invalidatedValue: () => ({
            ok: false,
            status: 0,
            error: "A sessão mudou em outra aba antes da exclusão.",
          }),
        },
      );
      return mutation.finally(() => {
        if (transitionCredential) {
          Auth.discardSessionTransitionCredential(transitionCredential);
        }
        if (reversibleNativeDeletion) {
          Auth.discardReversibleSessionTokenRevocation(
            reversibleNativeDeletion,
          );
        }
        if (reversibleWebDeletion) {
          Auth.discardReversibleWebSessionRevocation(reversibleWebDeletion);
        }
      });
    },
    [endSession, performRefetch, runSessionMutation, user],
  );

  const value = useMemo<AuthContextValue>(() => {
    // A função captura o receipt VERIFIED, mas sua prova `isCurrent()` lê
    // epoch/sequence de módulo ao vivo. Um BEGIN a invalida na mesma pilha,
    // antes do rerender/cleanup dos consumers account-scoped.
    const isSessionAuthorizationCurrent = () =>
      Boolean(
        user &&
        sessionValidation.status === "VERIFIED" &&
        sessionValidation.userId === user.id &&
        sessionValidation.isCurrent(),
      );
    return {
      user,
      isLoading,
      // `user` é identidade exibível, não prova de que o transporte atual
      // continua autorizado. Consumers account-scoped (push, sync, tRPC)
      // só recebem admissão enquanto o /me da epoch corrente está VERIFIED.
      isAuthenticated: isSessionAuthorizationCurrent(),
      isSessionAuthorizationCurrent,
      pushRegistrationRevision,
      sessionValidation,
      login,
      rotateSession,
      deleteAccount,
      logout,
      refetch,
    };
  }, [
    user,
    isLoading,
    pushRegistrationRevision,
    sessionValidation,
    login,
    rotateSession,
    deleteAccount,
    logout,
    refetch,
  ]);

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
