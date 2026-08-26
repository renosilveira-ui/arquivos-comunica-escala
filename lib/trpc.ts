// lib/trpc.ts — Client-side tRPC com hooks para React Native
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import { TRPCClientError, type Operation, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import superjson from "superjson";
import { Platform } from "react-native";
import * as Auth from "@/lib/_core/auth";
import { getApiBaseUrl } from "@/lib/_core/api";
import { withRequestDeadline } from "@/lib/request-deadline";
import { getActiveInstitutionId } from "@/lib/tenant-state";
import type { AppRouter } from "@/server/routers";

export const trpc = createTRPCReact<AppRouter>();
const CLIENT_SESSION_TICKET_HEADER = "x-client-session-ticket";
const EXPECTED_SESSION_USER_HEADER = "x-client-expected-user-id";
const SESSION_INSTANCE_HEADER = "x-client-session-instance";
const SESSION_TRANSPORT_PROOF_CONTEXT = "__sessionTransportProof";

type SessionTransportProof = Readonly<{
  ticket: number;
  expectedUserId: number;
  sessionInstance?: string;
}>;

function captureSessionTransportProof(): SessionTransportProof | null {
  const ticket = Auth.captureSessionTransportTicket();
  if (ticket === null) return null;
  const expectedUserId = Auth.getSessionTransportExpectedUserId(ticket);
  if (expectedUserId === null) return null;
  const sessionInstance =
    Platform.OS === "web"
      ? Auth.getSessionTransportSessionInstance(ticket)
      : undefined;
  if (Platform.OS === "web" && !sessionInstance) return null;
  return {
    ticket,
    expectedUserId,
    ...(sessionInstance ? { sessionInstance } : {}),
  };
}

function operationSessionTransportProof(
  op: Operation,
): SessionTransportProof | null {
  const proof = op.context[SESSION_TRANSPORT_PROOF_CONTEXT];
  if (
    typeof proof !== "object" ||
    proof === null ||
    !Number.isSafeInteger((proof as SessionTransportProof).ticket) ||
    !Number.isSafeInteger((proof as SessionTransportProof).expectedUserId)
  ) {
    return null;
  }
  return proof as SessionTransportProof;
}

function sessionTransportProofLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) => {
      const proof = captureSessionTransportProof();
      if (!proof) {
        return observable((observer) => {
          observer.error(
            TRPCClientError.from(
              new Error("Transporte bloqueado até a sessão ser revalidada"),
            ),
          );
        });
      }
      return next({
        ...op,
        context: {
          ...op.context,
          [SESSION_TRANSPORT_PROOF_CONTEXT]: proof,
        },
      });
    };
}

function batchSessionTransportProof(
  opList?: readonly Operation[],
): SessionTransportProof {
  if (!opList) {
    const proof = captureSessionTransportProof();
    if (proof) return proof;
    throw new Error("Transporte bloqueado até a sessão ser revalidada");
  }
  const first = operationSessionTransportProof(opList[0]);
  if (!first) throw new Error("Lote tRPC sem prova de sessão na origem");
  for (const op of opList) {
    const current = operationSessionTransportProof(op);
    if (
      !current ||
      current.ticket !== first.ticket ||
      current.expectedUserId !== first.expectedUserId ||
      current.sessionInstance !== first.sessionInstance
    ) {
      throw new Error("Lote tRPC mistura sessões diferentes");
    }
  }
  if (!Auth.isSessionTransportTicketCurrent(first.ticket)) {
    throw new Error("Sessão mudou antes de montar o lote tRPC");
  }
  return first;
}

export async function buildTRPCRequestHeaders(
  opList?: readonly Operation[],
): Promise<Record<string, string>> {
  const {
    ticket: transportTicket,
    expectedUserId,
    sessionInstance,
  } = batchSessionTransportProof(opList);
  if (Platform.OS === "web") {
    // O cookie HttpOnly é anexado pelo navegador fora do controle do caller.
    // Enquanto login/rotação/revogação não assentam a identidade canônica, o
    // único fail-closed possível é impedir o request antes do fetch.
    const gate = await Auth.getWebSessionGateState();
    if (gate.state !== "CLEAR") {
      throw new Error("Transporte web bloqueado por sessão em reconciliação");
    }
  }

  const headers: Record<string, string> = {};
  const activeInstitutionId = await getActiveInstitutionId();
  if (activeInstitutionId) {
    headers["x-tenant-id"] = String(activeInstitutionId);
  }
  if (Platform.OS !== "web") {
    const token = await Auth.getSessionToken();
    if (!token) {
      throw new Error("Bearer bloqueado até a sessão ser revalidada");
    }
    headers.Authorization = `Bearer ${token}`;
  }
  if (!Auth.isSessionTransportTicketCurrent(transportTicket)) {
    throw new Error("Sessão mudou durante a construção do request");
  }
  // Metadado exclusivamente local. O fetch abaixo o consome/remove antes da
  // rede e repete o CAS sem await, fechando a janela headers→Set-Cookie.
  headers[CLIENT_SESSION_TICKET_HEADER] = String(transportTicket);
  // Constraint, não autoridade: o servidor autentica cookie/Bearer e rejeita
  // se outra aba substituiu a identidade depois que esta operation nasceu.
  headers[EXPECTED_SESSION_USER_HEADER] = String(expectedUserId);
  if (Platform.OS === "web") {
    if (!sessionInstance) {
      throw new Error("Instância canônica da sessão web indisponível");
    }
    headers[SESSION_INSTANCE_HEADER] = sessionInstance;
  }
  return headers;
}

export function createTRPCClient() {
  return trpc.createClient({
    links: [
      sessionTransportProofLink(),
      httpBatchLink({
        url: `${getApiBaseUrl()}/api/trpc`,
        transformer: superjson,
        headers: ({ opList }) => buildTRPCRequestHeaders(opList),
        fetch(url, options) {
          const headers = new Headers(options?.headers);
          const rawTicket = headers.get(CLIENT_SESSION_TICKET_HEADER);
          headers.delete(CLIENT_SESSION_TICKET_HEADER);
          const transportTicket = rawTicket === null ? NaN : Number(rawTicket);
          if (!Auth.isSessionTransportTicketCurrent(transportTicket)) {
            return Promise.reject(
              new Error("Sessão mudou antes do envio do request"),
            );
          }
          const deadline = withRequestDeadline(options?.signal);
          return fetch(url, {
            ...options,
            headers,
            signal: deadline.signal,
            credentials: Platform.OS === "web" ? "include" : undefined,
          }).finally(() => deadline.cleanup());
        },
      }),
    ],
  });
}
