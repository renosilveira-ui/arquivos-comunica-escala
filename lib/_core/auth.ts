// lib/_core/auth.ts — Gerenciamento de sessão/token para o app mobile
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  enterWebSessionWorkflow,
  getActiveWebSessionWorkflowSignal,
  waitForActiveWebSessionWorkflow,
} from "./web-session-workflow";
import { requestCanonicalSession } from "./canonical-session-request";
import {
  exactSessionBindingClientActive,
  isSupportedExactSessionBindingCapability,
  requestedSessionBindingProtocol,
  SESSION_BINDING_PROTOCOL_HEADER,
  type SessionBindingState,
} from "./session-binding-protocol";
import { getApiBaseUrl } from "./api-base-url";
import { getActiveInstitutionId } from "../tenant-state";

const SESSION_TOKEN_KEY = "session_token";
const SESSION_TOKEN_REVOKED_KEY = "session_token_revoked_v1";
const SESSION_TOKEN_ADMISSION_KEY = "session_token_admission_v3";
const SESSION_TOKEN_BLOCKED_MARKER = "blocked:v3";
const SESSION_TOKEN_PENDING_PREFIX = "pending:v3";
const SESSION_TOKEN_COMMITTED_PREFIX = "committed:v3";
const SESSION_TOKEN_LEGACY_REVOKE_PREFIX = "legacy-revoke-required:v1";
const SESSION_TOKEN_LEGACY_REVOKE_V2_PREFIX = "legacy-revoke-required:v2";
const SESSION_TOKEN_REVOKED_CLEANUP_PREFIX = "revoked-cleanup-required:v1";
const WEB_SESSION_QUARANTINE_KEY = "web_session_quarantine_v1";
const WEB_SESSION_WORKFLOW_REVISION_KEY = "web_session_workflow_revision_v1";
const WEB_SESSION_WORKFLOW_REVISION_PREFIX = "workflow:v1";
const SESSION_INSTANCE_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
export const WEB_SESSION_MUTATION_DEADLINE_MS = 15_000;

export class WebSessionMutationCancelledError extends Error {
  readonly code = "WEB_SESSION_MUTATION_CANCELLED";

  constructor() {
    super("Workflow de sessão web excedeu o prazo seguro");
    this.name = "WebSessionMutationCancelledError";
  }
}
const WEB_SESSION_QUARANTINE_PREFIX = "pending-revocation:v2";
const WEB_SESSION_BOUND_QUARANTINE_PREFIX = "pending-revocation:v3";
const WEB_SESSION_EXACT_QUARANTINE_PREFIX = "pending-revocation:v4";
const WEB_LOGIN_IN_PROGRESS_PREFIX = "login-in-progress:v3";
const WEB_PENDING_ADMISSION_PREFIX = "pending-admission:v3";
const USER_INFO_KEY = "user_info";

let sessionTokenCacheInitialized = false;
let sessionTokenCache: string | null = null;
let sessionTokenCacheVersion = 0;
let sessionTokenRead: Promise<string | null> | null = null;
let sessionTokenMutationTail: Promise<void> = Promise.resolve();
let nativeSessionTransportAdmission: {
  version: number;
  binding: SessionTokenBinding;
} | null = null;
let sessionTransportGeneration = 0;
let sessionTransportAdmittedUserId: number | null = null;
declare const sessionValidationChallengeBrand: unique symbol;
declare const sessionValidationReceiptBrand: unique symbol;
type SessionValidationChallenge = Readonly<{
  [sessionValidationChallengeBrand]: true;
}>;
export type SessionValidationReceipt = Readonly<{
  [sessionValidationReceiptBrand]: true;
}>;
type SessionValidationState = Readonly<{
  transportGeneration: number;
  tokenVersion: number;
  expectedUserId?: number;
  platform: "web" | "native";
  nativeTokenFingerprint?: string;
  webWorkflowRevision?: string;
  sessionInstance?: string;
}>;
const sessionValidationChallenges = new WeakMap<
  object,
  SessionValidationState
>();
const sessionValidationReceipts = new WeakMap<
  object,
  SessionValidationState & Readonly<{ userId: number }>
>();
declare const sessionTransitionCredentialBrand: unique symbol;
export type SessionTransitionCredential = Readonly<{
  [sessionTransitionCredentialBrand]: true;
}>;
export type SessionTransitionPurpose = "rotate-session" | "delete-account";
type SessionTransitionCredentialState = Readonly<{
  purpose: SessionTransitionPurpose;
  expectedUserId: number;
  nativeToken: string | null;
  tokenVersion: number;
  nativeAuthority: "ADMITTED" | "REVERSIBLE_PENDING";
  webWorkflowRevision?: string;
  webSessionInstance?: string;
  reversibleTicket?: ReversibleSessionRevocation;
}>;
const sessionTransitionCredentials = new WeakMap<
  object,
  SessionTransitionCredentialState
>();
declare const webSessionMutationIntentBrand: unique symbol;
export type WebSessionMutationIntent = Readonly<{
  [webSessionMutationIntentBrand]: true;
}>;
type WebSessionMutationIntentState = Readonly<{
  revision: string | null;
  gate: string | null;
  expectedUserId?: number;
  requireClearGate: boolean;
}>;
const webSessionMutationIntents = new WeakMap<
  object,
  WebSessionMutationIntentState
>();
let stagedSessionToken: {
  version: number;
  token: string;
  binding: SessionTokenBinding;
  ticket: StagedSessionToken;
} | null = null;
declare const reversibleSessionRevocationBrand: unique symbol;
export type ReversibleSessionRevocation = Readonly<{
  [reversibleSessionRevocationBrand]: true;
}>;
let reversibleSessionRevocation: {
  version: number;
  token: string;
  binding: SessionTokenBinding;
  ticket: ReversibleSessionRevocation;
} | null = null;
declare const reversibleWebSessionRevocationBrand: unique symbol;
export type ReversibleWebSessionRevocation = Readonly<{
  [reversibleWebSessionRevocationBrand]: true;
}>;
let reversibleWebSessionRevocation: {
  expectedUserId: number;
  marker: string;
  ticket: ReversibleWebSessionRevocation;
  workflowSignal: AbortSignal;
  requestDispatched: boolean;
} | null = null;
declare const webLoginInProgressBrand: unique symbol;
export type WebLoginInProgress = Readonly<{
  [webLoginInProgressBrand]: true;
}>;
let webLoginInProgress: {
  marker: string;
  ticket: WebLoginInProgress;
  workflowSignal: AbortSignal;
} | null = null;
declare const webStaleQuarantineReceiptBrand: unique symbol;
type WebStaleQuarantineReceipt = Readonly<{
  [webStaleQuarantineReceiptBrand]: true;
}>;
type WebStaleQuarantineReceiptState = Readonly<{
  marker: string;
  transportGeneration: number;
  expectedUserId: number;
  currentSessionUserId: number;
  workflowSignal: AbortSignal;
}>;
const webStaleQuarantineReceipts = new WeakMap<
  object,
  WebStaleQuarantineReceiptState
>();
let webSessionQuarantineTail: Promise<void> = Promise.resolve();
let ownedWebSessionGate: string | null = null;
let observedWebSessionGate: string | null = null;
let admittedWebSessionWorkflowRevision: string | null = null;
let admittedWebSessionInstance: string | null = null;
const webSessionWorkflowRevisions = new WeakMap<
  AbortSignal,
  Readonly<{ previousRevision: string | null; revision: string }>
>();
const externalWebSessionInvalidationListeners = new Set<() => void>();
let userInfoMutationTail: Promise<void> = Promise.resolve();

export interface User {
  id: number;
  name: string | null;
  email: string | null;
  role: "admin" | "manager" | "doctor" | "nurse" | "tech";
  approvalStatus?: "PENDING" | "APPROVED";
  mustChangePassword?: boolean;
}

type SessionTokenBinding = Readonly<{
  expectedUserId: number;
  nonce: string;
  fingerprint: string;
}>;

type RevokedCleanupBinding = Readonly<{
  expectedUserId?: number;
  nonce: string;
  fingerprint: string;
}>;

type NativeSessionSnapshot = Readonly<{
  marker: string | null;
  token: string | null;
  admission: string | null;
}>;

type LegacySessionTokenBinding =
  | Readonly<{
      revision: "v1";
      fingerprint: string;
    }>
  | Readonly<{
      revision: "v2";
      nonce: string;
      fingerprint: string;
    }>;

export type PreparedSessionTokenRevocation =
  | Readonly<{
      token: string;
      phase: "PENDING";
      fingerprint: string;
      nonce: string;
      expectedUserId: number;
    }>
  | Readonly<{
      token: string;
      phase: "LEGACY";
      fingerprint: string;
      nonce: string;
      expectedUserId?: never;
    }>;

type NativeSessionRevocationProof =
  | Readonly<{ status: "ROTATED"; revocationUserId: number }>
  | Readonly<{
      status: "ALREADY_INVALID";
      revocationUserId?: number;
    }>;

type NativeSessionRevocationResponse = Readonly<{
  ok?: unknown;
  revocation?: unknown;
  revocationUserId?: unknown;
  currentSessionUserId?: unknown;
  sessionFenceRotated?: unknown;
  code?: unknown;
  error?: unknown;
}>;

export type WebSessionRevocationResult =
  | Readonly<{
      status: "REVOKED";
      revocation: NativeSessionRevocationProof;
    }>
  | Readonly<{
      status: "STALE_QUARANTINE_CLEARED";
    }>;

export type NativeAccountDeletionErrorCode =
  | "EXPECTED_USER_MISMATCH"
  | "MALFORMED_EXPECTED_USER_ID"
  | "SESSION_INSTANCE_MISMATCH"
  | "MALFORMED_SESSION_INSTANCE"
  | "SESSION_INSTANCE_REQUIRED"
  | "MALFORMED_SESSION_PROTOCOL"
  | "SESSION_BINDING_CAPABILITY_UNAVAILABLE"
  | "SESSION_BINDING_REAUTH_REQUIRED";

export type NativeAccountDeletionResult = Readonly<{
  ok: boolean;
  status: number;
  error?: string;
  code?: NativeAccountDeletionErrorCode;
}>;

type NativeAccountDeletionResponse = Readonly<{
  ok?: unknown;
  error?: unknown;
  code?: unknown;
}>;

export type NativeSessionGateState =
  | Readonly<{ state: "CLEAR" }>
  | Readonly<{ state: "ADMITTED"; expectedUserId: number }>
  | Readonly<{ state: "REVOKE_REQUIRED" }>
  | Readonly<{ state: "LEGACY_REVOKE_REQUIRED" }>
  | Readonly<{ state: "REVOKED_CLEANUP_REQUIRED" }>
  | Readonly<{ state: "BLOCKED" }>;

export class SessionTokenCommitAmbiguousError extends Error {
  readonly code = "SESSION_TOKEN_COMMIT_AMBIGUOUS" as const;
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "SessionTokenCommitAmbiguousError";
    this.cause = cause;
  }
}

export function isSessionTokenCommitAmbiguousError(
  error: unknown,
): error is SessionTokenCommitAmbiguousError {
  return (
    error instanceof SessionTokenCommitAmbiguousError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "SESSION_TOKEN_COMMIT_AMBIGUOUS")
  );
}

export class ConfirmedSessionRevocationLocalCleanupError extends Error {
  readonly code = "SESSION_REVOCATION_CONFIRMED_LOCAL_CLEANUP_FAILED" as const;
  readonly cause: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(
      `O servidor confirmou a revogação, mas o estado local não foi persistido${detail}`,
    );
    this.name = "ConfirmedSessionRevocationLocalCleanupError";
    this.cause = cause;
  }
}

export function isConfirmedSessionRevocationLocalCleanupError(
  error: unknown,
): error is ConfirmedSessionRevocationLocalCleanupError {
  return (
    error instanceof ConfirmedSessionRevocationLocalCleanupError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code ===
        "SESSION_REVOCATION_CONFIRMED_LOCAL_CLEANUP_FAILED")
  );
}

export class ConfirmedNativeAccountDeletionLocalCleanupError extends Error {
  readonly code = "ACCOUNT_DELETION_CONFIRMED_LOCAL_CLEANUP_FAILED" as const;
  readonly result: NativeAccountDeletionResult;
  readonly cause: unknown;

  constructor(result: NativeAccountDeletionResult, cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(
      `O servidor confirmou a exclusão da conta, mas o estado local não foi persistido${detail}`,
    );
    this.name = "ConfirmedNativeAccountDeletionLocalCleanupError";
    this.result = result;
    this.cause = cause;
  }
}

export function isConfirmedNativeAccountDeletionLocalCleanupError(
  error: unknown,
): error is ConfirmedNativeAccountDeletionLocalCleanupError {
  const result =
    typeof error === "object" && error !== null
      ? (error as { result?: unknown }).result
      : undefined;
  const confirmedResult =
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === true &&
    typeof (result as { status?: unknown }).status === "number" &&
    Number.isInteger((result as { status: number }).status) &&
    (result as { status: number }).status >= 200 &&
    (result as { status: number }).status < 300;
  return (
    typeof error === "object" &&
    error !== null &&
    (error instanceof ConfirmedNativeAccountDeletionLocalCleanupError ||
      (error as { code?: unknown }).code ===
        "ACCOUNT_DELETION_CONFIRMED_LOCAL_CLEANUP_FAILED") &&
    confirmedResult
  );
}

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function fingerprintSessionToken(token: string): string {
  const bytes = utf8Bytes(token);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) {
    bytes.push((high >>> shift) & 0xff);
  }
  for (let shift = 24; shift >= 0; shift -= 8) {
    bytes.push((low >>> shift) & 0xff);
  }

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] =
        (bytes[byteOffset] << 24) |
        (bytes[byteOffset + 1] << 16) |
        (bytes[byteOffset + 2] << 8) |
        bytes[byteOffset + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15];
      const beforePrevious = words[index - 2];
      const sigma0 =
        rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const sigma1 =
        rotateRight(beforePrevious, 17) ^
        rotateRight(beforePrevious, 19) ^
        (beforePrevious >>> 10);
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 =
        rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 =
        (h +
          upperSigma1 +
          choice +
          SHA256_ROUND_CONSTANTS[index] +
          words[index]) >>>
        0;
      const upperSigma0 =
        rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function createSessionTokenNonce(): string {
  const nativeUuid = globalThis.expo
    ?.uuidv4?.()
    .replaceAll("-", "")
    .toLowerCase();
  if (nativeUuid && /^[0-9a-f]{32}$/.test(nativeUuid)) return nativeUuid;
  const randomSource = globalThis.crypto;
  if (!randomSource?.getRandomValues) {
    throw new Error("Gerador seguro indisponível para preparar a sessão");
  }
  const bytes = randomSource.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function createSessionTokenBinding(
  token: string,
  expectedUserId: number,
): SessionTokenBinding {
  return {
    expectedUserId,
    nonce: createSessionTokenNonce(),
    fingerprint: fingerprintSessionToken(token),
  };
}

function encodePendingBinding(binding: SessionTokenBinding): string {
  return `${SESSION_TOKEN_PENDING_PREFIX}:${binding.expectedUserId}:${binding.nonce}:${binding.fingerprint}`;
}

function encodeCommittedAdmission(binding: SessionTokenBinding): string {
  return `${SESSION_TOKEN_COMMITTED_PREFIX}:${binding.expectedUserId}:${binding.nonce}:${binding.fingerprint}`;
}

function encodeLegacyRevocationBinding(
  binding: Extract<LegacySessionTokenBinding, { revision: "v2" }>,
): string {
  return `${SESSION_TOKEN_LEGACY_REVOKE_V2_PREFIX}:${binding.nonce}:${binding.fingerprint}`;
}

function encodeRevokedCleanupBinding(binding: RevokedCleanupBinding): string {
  const identity =
    binding.expectedUserId === undefined
      ? "anonymous"
      : String(binding.expectedUserId);
  return `${SESSION_TOKEN_REVOKED_CLEANUP_PREFIX}:${identity}:${binding.nonce}:${binding.fingerprint}`;
}

function parseLegacyRevocationBinding(
  value: string | null,
): LegacySessionTokenBinding | null {
  if (value === null) return null;
  const v2 = new RegExp(
    `^${SESSION_TOKEN_LEGACY_REVOKE_V2_PREFIX}:([0-9a-f]{32}):([0-9a-f]{64})$`,
  ).exec(value);
  if (v2) {
    return { revision: "v2", nonce: v2[1], fingerprint: v2[2] };
  }
  const v1 = new RegExp(
    `^${SESSION_TOKEN_LEGACY_REVOKE_PREFIX}:([0-9a-f]{64})$`,
  ).exec(value);
  return v1 ? { revision: "v1", fingerprint: v1[1] } : null;
}

function parseBinding(
  value: string | null,
  prefix: string,
): SessionTokenBinding | null {
  if (value === null) return null;
  const pattern = new RegExp(
    `^${prefix}:([1-9][0-9]*):([0-9a-f]{32}):([0-9a-f]{64})$`,
  );
  const match = pattern.exec(value);
  if (!match) return null;
  const expectedUserId = Number(match[1]);
  if (
    !Number.isSafeInteger(expectedUserId) ||
    expectedUserId <= 0 ||
    String(expectedUserId) !== match[1]
  ) {
    return null;
  }
  return {
    expectedUserId,
    nonce: match[2],
    fingerprint: match[3],
  };
}

function revokedCleanupBindingFromAdmission(
  admission: string | null,
): RevokedCleanupBinding | null {
  const userBound = parseBinding(
    admission,
    SESSION_TOKEN_REVOKED_CLEANUP_PREFIX,
  );
  if (userBound) return userBound;
  if (admission === null) return null;
  const match = new RegExp(
    `^${SESSION_TOKEN_REVOKED_CLEANUP_PREFIX}:anonymous:([0-9a-f]{32}):([0-9a-f]{64})$`,
  ).exec(admission);
  return match ? { nonce: match[1], fingerprint: match[2] } : null;
}

function isRevokedCleanupAdmissionNamespace(admission: string | null): boolean {
  return (
    admission === SESSION_TOKEN_REVOKED_CLEANUP_PREFIX ||
    admission?.startsWith(`${SESSION_TOKEN_REVOKED_CLEANUP_PREFIX}:`) === true
  );
}

function sameBinding(
  left: SessionTokenBinding,
  right: SessionTokenBinding,
): boolean {
  return (
    left.expectedUserId === right.expectedUserId &&
    left.nonce === right.nonce &&
    left.fingerprint === right.fingerprint
  );
}

function sameRevokedCleanupBinding(
  left: RevokedCleanupBinding,
  right: RevokedCleanupBinding,
): boolean {
  return (
    left.expectedUserId === right.expectedUserId &&
    left.nonce === right.nonce &&
    left.fingerprint === right.fingerprint
  );
}

function preparedPendingRevocation(
  token: string,
  binding: SessionTokenBinding,
): PreparedSessionTokenRevocation {
  return Object.freeze({
    token,
    phase: "PENDING" as const,
    fingerprint: binding.fingerprint,
    nonce: binding.nonce,
    expectedUserId: binding.expectedUserId,
  });
}

function preparedLegacyRevocation(
  token: string,
  binding: Extract<LegacySessionTokenBinding, { revision: "v2" }>,
): PreparedSessionTokenRevocation {
  return Object.freeze({
    token,
    phase: "LEGACY" as const,
    fingerprint: binding.fingerprint,
    nonce: binding.nonce,
  });
}

function parseNativeSessionRevocationProof(
  data: NativeSessionRevocationResponse | null,
): NativeSessionRevocationProof | null {
  if (data?.ok !== true) return null;
  const hasRevocationUserId = Object.prototype.hasOwnProperty.call(
    data,
    "revocationUserId",
  );
  const revocationUserId = data.revocationUserId;
  const hasValidRevocationUserId =
    typeof revocationUserId === "number" &&
    Number.isSafeInteger(revocationUserId) &&
    revocationUserId > 0;

  if (data.revocation === "ROTATED") {
    return hasRevocationUserId && hasValidRevocationUserId
      ? { status: "ROTATED", revocationUserId }
      : null;
  }
  if (data.revocation !== "ALREADY_INVALID") return null;
  if (!hasRevocationUserId) return { status: "ALREADY_INVALID" };
  return hasValidRevocationUserId
    ? { status: "ALREADY_INVALID", revocationUserId }
    : null;
}

async function requestPreparedSessionTokenRevocation(
  token: string,
): Promise<NativeSessionRevocationProof> {
  if (Platform.OS === "web") {
    throw new Error("Revogação explícita do Bearer indisponível no web");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const activeInstitutionId = await getActiveInstitutionId();
  if (activeInstitutionId) {
    headers["x-tenant-id"] = String(activeInstitutionId);
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
      method: "POST",
      headers,
      body: "{}",
      cache: "no-store",
    });
  } catch (error) {
    throw new AggregateError(
      [error],
      "O servidor não confirmou a revogação do token em quarentena",
    );
  }

  let data: NativeSessionRevocationResponse | null = null;
  try {
    const value: unknown = await response.json();
    data =
      typeof value === "object" && value !== null
        ? (value as NativeSessionRevocationResponse)
        : null;
  } catch {
    data = null;
  }
  const proof = parseNativeSessionRevocationProof(data);
  if (!response.ok || proof === null) {
    throw new Error(
      "O servidor não confirmou a revogação do token em quarentena",
    );
  }
  return proof;
}

type WebSessionRevocationRequestResult =
  | Readonly<{
      status: "REVOKED";
      revocation: NativeSessionRevocationProof;
    }>
  | Readonly<{
      status: "STALE_QUARANTINE_CLEARED";
      receipt: WebStaleQuarantineReceipt;
    }>;

/**
 * Executa o efeito remoto que autoriza a liberação do gate web. O parser e o
 * fetch ficam na mesma autoridade: nenhum caller consegue fornecer status,
 * body ou uma confirmação fabricada para avançar o estado local.
 */
async function requestPreparedWebSessionRevocation(
  expectedUserId?: number,
  sessionInstance?: string,
  staleReceiptContext?: Readonly<{
    marker: string;
    transportGeneration: number;
    workflowSignal: AbortSignal;
  }>,
): Promise<WebSessionRevocationRequestResult> {
  if (Platform.OS !== "web") {
    throw new Error("Revogação do cookie indisponível no nativo");
  }
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (!workflowSignal || workflowSignal.aborted) {
    throw new Error("Revogação do cookie fora do workflow web exclusivo");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (expectedUserId !== undefined) {
    headers["x-client-expected-user-id"] = String(expectedUserId);
  }
  if (sessionInstance !== undefined) {
    headers["x-client-session-instance"] = sessionInstance;
  }
  const activeInstitutionId = await getActiveInstitutionId();
  if (activeInstitutionId) headers["x-tenant-id"] = String(activeInstitutionId);

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
      method: "POST",
      headers,
      body: "{}",
      credentials: "include",
      cache: "no-store",
      signal: workflowSignal,
    });
  } catch (error) {
    throw new AggregateError(
      [error],
      "O servidor não confirmou a revogação do cookie em quarentena",
    );
  }

  let data: NativeSessionRevocationResponse | null = null;
  try {
    const value: unknown = await response.json();
    data =
      typeof value === "object" && value !== null
        ? (value as NativeSessionRevocationResponse)
        : null;
  } catch {
    data = null;
  }
  if (
    response.status === 409 &&
    expectedUserId !== undefined &&
    data?.code === "EXPECTED_USER_MISMATCH"
  ) {
    const currentSessionUserId = data.currentSessionUserId;
    if (
      typeof currentSessionUserId !== "number" ||
      !Number.isSafeInteger(currentSessionUserId) ||
      currentSessionUserId <= 0 ||
      currentSessionUserId === expectedUserId
    ) {
      throw new Error(
        "O servidor não confirmou a identidade corrente da sessão web",
      );
    }
    if (!staleReceiptContext) {
      throw new Error("Contexto físico da quarentena web indisponível");
    }
    const receipt = Object.freeze({}) as WebStaleQuarantineReceipt;
    webStaleQuarantineReceipts.set(receipt, {
      marker: staleReceiptContext.marker,
      transportGeneration: staleReceiptContext.transportGeneration,
      expectedUserId,
      currentSessionUserId,
      workflowSignal: staleReceiptContext.workflowSignal,
    });
    return { status: "STALE_QUARANTINE_CLEARED", receipt };
  }
  const proof = parseNativeSessionRevocationProof(data);
  if (!response.ok || proof === null || data?.sessionFenceRotated !== true) {
    throw new Error(
      "O servidor não confirmou a revogação do cookie em quarentena",
    );
  }
  return { status: "REVOKED", revocation: proof };
}

function consumeWebStaleQuarantineReceipt(
  receipt: WebStaleQuarantineReceipt,
  expected: Omit<WebStaleQuarantineReceiptState, "currentSessionUserId">,
): void {
  const state = webStaleQuarantineReceipts.get(receipt);
  webStaleQuarantineReceipts.delete(receipt);
  if (
    !state ||
    state.marker !== expected.marker ||
    state.transportGeneration !== expected.transportGeneration ||
    state.transportGeneration !== sessionTransportGeneration ||
    state.expectedUserId !== expected.expectedUserId ||
    state.workflowSignal !== expected.workflowSignal ||
    state.workflowSignal.aborted ||
    state.currentSessionUserId === state.expectedUserId
  ) {
    throw new Error("Receipt do mismatch web inválida, stale ou já consumida");
  }
}

function nativeAccountDeletionErrorCode(
  value: unknown,
): NativeAccountDeletionErrorCode | undefined {
  return value === "EXPECTED_USER_MISMATCH" ||
    value === "MALFORMED_EXPECTED_USER_ID" ||
    value === "SESSION_INSTANCE_MISMATCH" ||
    value === "MALFORMED_SESSION_INSTANCE" ||
    value === "SESSION_INSTANCE_REQUIRED" ||
    value === "MALFORMED_SESSION_PROTOCOL" ||
    value === "SESSION_BINDING_CAPABILITY_UNAVAILABLE" ||
    value === "SESSION_BINDING_REAUTH_REQUIRED"
    ? value
    : undefined;
}

async function requestPreparedNativeAccountDeletion(
  password: string,
  credential: SessionTransitionCredential,
): Promise<NativeAccountDeletionResult> {
  const authority = consumeSessionTransitionCredentialForRequest(
    credential,
    "/api/auth/me",
    "DELETE",
  );
  if (!authority.authorization) {
    throw new Error("DELETE nativo não possui o Bearer reversível esperado");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authority.authorization,
    "x-client-expected-user-id": String(authority.expectedUserId),
  };
  const requestedProtocol = requestedSessionBindingProtocol();
  if (requestedProtocol) {
    headers[SESSION_BINDING_PROTOCOL_HEADER] = requestedProtocol;
  }
  const activeInstitutionId = await getActiveInstitutionId();
  if (activeInstitutionId) {
    headers["x-tenant-id"] = String(activeInstitutionId);
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ password }),
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error:
        error instanceof Error
          ? error.message
          : "Falha de conexão com o servidor.",
    };
  }

  let data: NativeAccountDeletionResponse | null = null;
  try {
    const value: unknown = await response.json();
    data =
      typeof value === "object" && value !== null
        ? (value as NativeAccountDeletionResponse)
        : null;
  } catch {
    data = null;
  }
  if (response.ok && data?.ok === true) {
    return { ok: true, status: response.status };
  }
  const code = nativeAccountDeletionErrorCode(data?.code);
  return {
    ok: false,
    status: response.status,
    ...(code === undefined ? {} : { code }),
    error:
      typeof data?.error === "string" ? data.error : "Erro ao excluir conta",
  };
}

function tokenMatchesBinding(
  token: string,
  binding: Readonly<{ fingerprint: string }>,
): boolean {
  return fingerprintSessionToken(token) === binding.fingerprint;
}

function tokenMatchesLegacyBinding(
  token: string,
  binding: LegacySessionTokenBinding,
): boolean {
  return fingerprintSessionToken(token) === binding.fingerprint;
}

// --- Token ---

function beginSessionTokenMutation(): number {
  closeSessionTokenTransportAdmission();
  return ++sessionTokenCacheVersion;
}

/**
 * Fecha sincronicamente o canal Bearer usado por API/tRPC. A prova física pode
 * continuar no SecureStore para recovery ou revogação, mas nenhum consumidor
 * normal volta a recebê-la antes de um `/me` canônico do mesmo usuário.
 */
export function closeSessionTokenTransportAdmission(): void {
  nativeSessionTransportAdmission = null;
  admittedWebSessionWorkflowRevision = null;
  admittedWebSessionInstance = null;
  sessionTransportAdmittedUserId = null;
  sessionTransportGeneration += 1;
}

/** Inicia internamente a prova antes do request canônico de `/me`. */
function beginCanonicalSessionValidation(
  expectedUserId?: number,
): SessionValidationChallenge {
  if (
    expectedUserId !== undefined &&
    (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0)
  ) {
    throw new Error("Usuário esperado da validação inválido");
  }
  const platform = Platform.OS === "web" ? "web" : "native";
  const webWorkflowRevision =
    platform === "web" ? ensureWebSessionWorkflowRevision() : undefined;
  const challenge = Object.freeze({}) as SessionValidationChallenge;
  sessionValidationChallenges.set(challenge, {
    transportGeneration: sessionTransportGeneration,
    tokenVersion: sessionTokenCacheVersion,
    ...(expectedUserId === undefined ? {} : { expectedUserId }),
    platform,
    ...(webWorkflowRevision === undefined ? {} : { webWorkflowRevision }),
  });
  return challenge;
}

function completeCanonicalSessionValidation(
  challenge: SessionValidationChallenge,
  authenticatedUserId: number,
  sessionInstance?: string,
): SessionValidationReceipt {
  const state = sessionValidationChallenges.get(challenge);
  sessionValidationChallenges.delete(challenge);
  if (
    !state ||
    !Number.isSafeInteger(authenticatedUserId) ||
    authenticatedUserId <= 0 ||
    state.transportGeneration !== sessionTransportGeneration ||
    state.tokenVersion !== sessionTokenCacheVersion ||
    (state.platform === "native" && !state.nativeTokenFingerprint) ||
    (state.platform === "web" &&
      (!state.webWorkflowRevision ||
        readWebSessionWorkflowRevision() !== state.webWorkflowRevision ||
        !sessionInstance ||
        !SESSION_INSTANCE_PATTERN.test(sessionInstance))) ||
    (state.expectedUserId !== undefined &&
      state.expectedUserId !== authenticatedUserId)
  ) {
    throw new Error("Resposta canônica stale ou divergente");
  }
  const receipt = Object.freeze({}) as SessionValidationReceipt;
  sessionValidationReceipts.set(receipt, {
    ...state,
    userId: authenticatedUserId,
    ...(sessionInstance === undefined ? {} : { sessionInstance }),
  });
  return receipt;
}

function consumeCanonicalSessionValidation(
  receipt: SessionValidationReceipt,
  platform: "web" | "native",
): Readonly<{
  userId: number;
  transportGeneration: number;
  tokenVersion: number;
  nativeTokenFingerprint?: string;
  webWorkflowRevision?: string;
  sessionInstance?: string;
}> {
  const state = sessionValidationReceipts.get(receipt);
  sessionValidationReceipts.delete(receipt);
  if (
    !state ||
    state.platform !== platform ||
    state.transportGeneration !== sessionTransportGeneration ||
    state.tokenVersion !== sessionTokenCacheVersion ||
    (platform === "web" &&
      (!state.webWorkflowRevision ||
        readWebSessionWorkflowRevision() !== state.webWorkflowRevision))
  ) {
    throw new Error("Receipt canônica inválida, stale ou já consumida");
  }
  return {
    userId: state.userId,
    transportGeneration: state.transportGeneration,
    tokenVersion: state.tokenVersion,
    ...(state.nativeTokenFingerprint
      ? { nativeTokenFingerprint: state.nativeTokenFingerprint }
      : {}),
    ...(state.webWorkflowRevision
      ? { webWorkflowRevision: state.webWorkflowRevision }
      : {}),
    ...(state.sessionInstance
      ? { sessionInstance: state.sessionInstance }
      : {}),
  };
}

export type CanonicalSessionValidationResult = Readonly<{
  user: User | null;
  sessionInvalid: boolean;
  networkOrServerError: boolean;
  code?:
    | "EXPECTED_USER_MISMATCH"
    | "MALFORMED_EXPECTED_USER_ID"
    | "SESSION_BINDING_REAUTH_REQUIRED";
  /** Identidade canônica somente para revogar a sessão recusada, nunca UI. */
  revocationUserId?: number;
  /** Instância canônica somente para o logout exact-v1 subsequente. */
  sessionInstance?: string;
  validationReceipt?: SessionValidationReceipt;
}>;

/**
 * Única fábrica de receipt: executa `/me` real e mantém begin/complete
 * privados no mesmo módulo. Nenhum sibling consegue cunhar autoridade local.
 */
export async function validateCanonicalSession(
  expectedUserId?: number,
  explicitNativeToken?: string,
): Promise<CanonicalSessionValidationResult> {
  if (explicitNativeToken !== undefined && Platform.OS === "web") {
    throw new Error("Bearer de recovery inválido");
  }
  if (explicitNativeToken !== undefined && !explicitNativeToken.trim()) {
    throw new Error("Bearer de recovery inválido");
  }
  const challenge = beginCanonicalSessionValidation(expectedUserId);
  const nativeToken =
    Platform.OS === "web"
      ? undefined
      : explicitNativeToken !== undefined
        ? explicitNativeToken.trim() || undefined
        : expectedUserId !== undefined
          ? await getSessionTokenForValidation(expectedUserId)
          : ((await getSessionToken()) ?? undefined);
  if (Platform.OS !== "web" && nativeToken) {
    const state = sessionValidationChallenges.get(challenge);
    if (!state) throw new Error("Validação canônica indisponível");
    sessionValidationChallenges.set(challenge, {
      ...state,
      nativeTokenFingerprint: fingerprintSessionToken(nativeToken),
    });
  }
  const response = await requestCanonicalSession<{
    user?: User;
    sessionInstance?: unknown;
    sessionBinding?: SessionBindingState;
    code?: unknown;
  }>({ expectedUserId, nativeToken });
  if (response.ok) {
    const user = response.data?.user ?? null;
    if (!user) {
      return {
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      };
    }
    let exactClientActive: boolean;
    try {
      exactClientActive = exactSessionBindingClientActive();
    } catch {
      return {
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      };
    }
    if (exactClientActive) {
      const sessionBinding = response.data?.sessionBinding;
      if (!isSupportedExactSessionBindingCapability(sessionBinding)) {
        return {
          user: null,
          sessionInvalid: false,
          networkOrServerError: true,
        };
      }
      if (sessionBinding.sessionVersion !== 1) {
        const revocationUserId = user.id;
        if (!Number.isSafeInteger(revocationUserId) || revocationUserId <= 0) {
          return {
            user: null,
            sessionInvalid: false,
            networkOrServerError: true,
          };
        }
        const sessionInstance = response.data?.sessionInstance;
        return {
          user: null,
          // A sessão legacy ainda foi autenticada. Apenas o transporte exact
          // foi recusado; o caller precisa revogá-la com estes metadados, sem
          // cair no cleanup genérico de um 401.
          sessionInvalid: false,
          networkOrServerError: false,
          code: "SESSION_BINDING_REAUTH_REQUIRED",
          revocationUserId,
          ...(typeof sessionInstance === "string" &&
          SESSION_INSTANCE_PATTERN.test(sessionInstance)
            ? { sessionInstance }
            : {}),
        };
      }
    }
    try {
      return {
        user,
        sessionInvalid: false,
        networkOrServerError: false,
        validationReceipt: completeCanonicalSessionValidation(
          challenge,
          user.id,
          typeof response.data?.sessionInstance === "string"
            ? response.data.sessionInstance
            : undefined,
        ),
      };
    } catch {
      return {
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      };
    }
  }
  const rejectedCredential = response.status === 401 || response.status === 403;
  const sessionInvalid = rejectedCredential && response.credentialPresented;
  const rawCode = response.data?.code;
  const code =
    rawCode === "EXPECTED_USER_MISMATCH" ||
    rawCode === "MALFORMED_EXPECTED_USER_ID"
      ? rawCode
      : undefined;
  return {
    user: null,
    sessionInvalid,
    networkOrServerError: !sessionInvalid,
    ...(code ? { code } : {}),
  };
}

/**
 * Ticket curto usado pelo transporte para abortar requests construídos antes
 * de um BEGIN/END. `null` significa que a sessão ainda não recebeu `/me`
 * canônico neste processo.
 */
export function captureSessionTransportTicket(): number | null {
  if (sessionTransportAdmittedUserId === null) return null;
  if (Platform.OS === "web") {
    try {
      if (
        admittedWebSessionWorkflowRevision === null ||
        admittedWebSessionInstance === null ||
        readWebSessionWorkflowRevision() !== admittedWebSessionWorkflowRevision
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return sessionTransportGeneration;
}

export function isSessionTransportTicketCurrent(ticket: number): boolean {
  const locallyCurrent =
    Number.isSafeInteger(ticket) &&
    sessionTransportAdmittedUserId !== null &&
    ticket === sessionTransportGeneration;
  if (!locallyCurrent) return false;
  if (Platform.OS !== "web") return true;
  try {
    return (
      admittedWebSessionWorkflowRevision !== null &&
      admittedWebSessionInstance !== null &&
      readWebSessionWorkflowRevision() === admittedWebSessionWorkflowRevision
    );
  } catch {
    return false;
  }
}

/** Identidade presa ao ticket local; `null` também cobre ticket já stale. */
export function getSessionTransportExpectedUserId(
  ticket: number,
): number | null {
  return isSessionTransportTicketCurrent(ticket)
    ? sessionTransportAdmittedUserId
    : null;
}

/** Constraint opaca da credencial web exata presa ao ticket. */
export function getSessionTransportSessionInstance(
  ticket: number,
): string | null {
  return Platform.OS === "web" && isSessionTransportTicketCurrent(ticket)
    ? admittedWebSessionInstance
    : null;
}

/** Prova síncrona usada por receipts UI/listeners entre evento e rerender. */
export function isSessionTransportUserCurrent(userId: number): boolean {
  if (!(
    Number.isSafeInteger(userId) &&
    userId > 0 &&
    sessionTransportAdmittedUserId === userId
  )) {
    return false;
  }
  if (Platform.OS !== "web") return true;
  try {
    return (
      admittedWebSessionWorkflowRevision !== null &&
      admittedWebSessionInstance !== null &&
      readWebSessionWorkflowRevision() === admittedWebSessionWorkflowRevision
    );
  } catch {
    return false;
  }
}

/**
 * Snapshot opaca da revisão física que sustentava a intenção desta aba. Para
 * mutações account-bound, a identidade local, a revisão persistida e o marker
 * precisam descrever a mesma sessão; um StorageEvent atrasado não é autoridade.
 */
export function captureWebSessionMutationIntent(
  expectedUserId?: number,
  requireClearGate = false,
): WebSessionMutationIntent | null {
  if (Platform.OS !== "web") return null;
  if (
    expectedUserId !== undefined &&
    (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0)
  ) {
    return null;
  }
  try {
    const storage = webLocalStorage();
    if (!storage) return null;
    const revision = readWebSessionWorkflowRevision();
    const gate = storage.getItem(WEB_SESSION_QUARANTINE_KEY);
    if (expectedUserId !== undefined) {
      const admittedSessionMatches =
        gate === null &&
        sessionTransportAdmittedUserId === expectedUserId &&
        admittedWebSessionWorkflowRevision !== null &&
        revision === admittedWebSessionWorkflowRevision;
      const gateExpectedUserId =
        gate === null
          ? null
          : (parseWebAdmissionExpectedUserId(gate) ??
            parseWebRevocation(gate)?.expectedUserId ??
            null);
      const recoverableBoundGateMatches =
        !requireClearGate &&
        gate !== null &&
        gateExpectedUserId === expectedUserId;
      if (!admittedSessionMatches && !recoverableBoundGateMatches) return null;
    }
    if (requireClearGate && gate !== null) return null;

    const intent = Object.freeze({}) as WebSessionMutationIntent;
    webSessionMutationIntents.set(intent, {
      revision,
      gate,
      ...(expectedUserId === undefined ? {} : { expectedUserId }),
      requireClearGate,
    });
    return intent;
  } catch {
    return null;
  }
}

/**
 * Consome a snapshot já dentro do Web Lock e avança a revisão antes de marker,
 * push ou HTTP. O compare físico fecha inclusive a janela em que o evento de
 * `storage` da outra aba ainda não foi entregue.
 */
export function beginWebSessionMutationIntent(
  intent: WebSessionMutationIntent,
): void {
  const state = webSessionMutationIntents.get(intent);
  webSessionMutationIntents.delete(intent);
  if (Platform.OS !== "web" || !state) {
    throw new Error("Intenção de sessão web inválida ou reutilizada");
  }
  const signal = getActiveWebSessionWorkflowSignal();
  if (!signal || signal.aborted) {
    throw new Error("Workflow de sessão web indisponível");
  }
  const storage = webLocalStorage();
  if (!storage) throw new Error("Storage cross-tab da sessão web indisponível");
  const revision = readWebSessionWorkflowRevision();
  const gate = storage.getItem(WEB_SESSION_QUARANTINE_KEY);
  if (revision !== state.revision || gate !== state.gate) {
    throw new Error("A sessão web mudou em outra aba antes da operação");
  }
  if (state.requireClearGate && gate !== null) {
    throw new Error("A sessão web não está livre para esta operação");
  }
  if (state.expectedUserId !== undefined && gate !== null) {
    const gateExpectedUserId =
      parseWebAdmissionExpectedUserId(gate) ??
      parseWebRevocation(gate)?.expectedUserId ??
      null;
    if (gateExpectedUserId !== state.expectedUserId) {
      throw new Error("O marker web não corresponde à conta da operação");
    }
  }
  advanceWebSessionWorkflowRevision();
}

export function discardWebSessionMutationIntent(
  intent: WebSessionMutationIntent,
): void {
  webSessionMutationIntents.delete(intent);
}

/**
 * Recovery/remount também pode terminar em Set-Cookie de logout sem passar por
 * runSessionMutation. A primeira chamada no workflow avança a revisão; chamadas
 * irmãs no mesmo lock apenas confirmam o mesmo valor.
 */
export function advanceWebSessionWorkflowRevision(): string {
  if (Platform.OS !== "web") return "native";
  const signal = getActiveWebSessionWorkflowSignal();
  if (!signal || signal.aborted) {
    throw new Error("Workflow de sessão web indisponível");
  }
  const workflow = webSessionWorkflowRevisions.get(signal);
  if (workflow) {
    const current = readWebSessionWorkflowRevision();
    if (current !== workflow.revision) {
      throw new Error("Revisão da sessão web mudou durante o workflow");
    }
    return current;
  }
  const storage = webLocalStorage();
  if (!storage) throw new Error("Storage cross-tab da sessão web indisponível");
  // Valor malformado nunca é normalizado silenciosamente: pode representar um
  // protocolo futuro que esta versão não sabe cercar.
  const previousRevision = readWebSessionWorkflowRevision();
  const revision = `${WEB_SESSION_WORKFLOW_REVISION_PREFIX}:${createWebSessionGateNonce()}`;
  storage.setItem(WEB_SESSION_WORKFLOW_REVISION_KEY, revision);
  if (storage.getItem(WEB_SESSION_WORKFLOW_REVISION_KEY) !== revision) {
    throw new Error("Revisão da sessão web não foi confirmada");
  }
  webSessionWorkflowRevisions.set(signal, { previousRevision, revision });
  return revision;
}

/**
 * Capability opaca e de uso único para a mutação que vai fechar o próprio
 * transporte antes do POST. No nativo ela prende o Bearer A exato ainda
 * admitido; no web prende somente a identidade, pois o cookie permanece
 * inacessível ao JavaScript e o workflow Web Lock cerca o request inteiro.
 */
export function captureSessionTransitionCredential(
  purpose: SessionTransitionPurpose,
  expectedUserId: number,
): SessionTransitionCredential | null {
  if (
    !Number.isSafeInteger(expectedUserId) ||
    expectedUserId <= 0 ||
    sessionTransportAdmittedUserId !== expectedUserId
  ) {
    return null;
  }

  let nativeToken: string | null = null;
  let webWorkflowRevision: string | undefined;
  let webSessionInstance: string | undefined;
  if (Platform.OS !== "web") {
    const admission = nativeSessionTransportAdmission;
    const token = sessionTokenCacheInitialized ? sessionTokenCache : null;
    if (
      !admission ||
      admission.version !== sessionTokenCacheVersion ||
      admission.binding.expectedUserId !== expectedUserId ||
      !token ||
      !tokenMatchesBinding(token, admission.binding)
    ) {
      return null;
    }
    nativeToken = token;
  } else {
    try {
      const revision = readWebSessionWorkflowRevision();
      if (
        admittedWebSessionWorkflowRevision === null ||
        admittedWebSessionInstance === null ||
        revision !== admittedWebSessionWorkflowRevision
      ) {
        return null;
      }
      webWorkflowRevision = revision;
      webSessionInstance = admittedWebSessionInstance;
    } catch {
      return null;
    }
  }

  const credential = Object.freeze({}) as SessionTransitionCredential;
  sessionTransitionCredentials.set(credential, {
    purpose,
    expectedUserId,
    nativeToken,
    tokenVersion: sessionTokenCacheVersion,
    nativeAuthority: "ADMITTED",
    ...(webWorkflowRevision === undefined ? {} : { webWorkflowRevision }),
    ...(webSessionInstance === undefined ? {} : { webSessionInstance }),
  });
  return credential;
}

type SessionTransitionRequestAuthority = Readonly<{
  expectedUserId: number;
  authorization?: string;
  sessionInstance?: string;
}>;

/**
 * Converte a capability uma única vez e somente para o endpoint/método preso
 * ao purpose. O Bearer nunca volta ao canal normal nem é exposto ao caller.
 */
export function consumeSessionTransitionCredentialForRequest(
  credential: SessionTransitionCredential,
  path: string,
  method: string,
): SessionTransitionRequestAuthority {
  const state = sessionTransitionCredentials.get(credential);
  sessionTransitionCredentials.delete(credential);
  if (!state)
    throw new Error("Credencial de transição inválida ou reutilizada");

  const normalizedMethod = method.toUpperCase();
  const endpointMatches =
    (state.purpose === "rotate-session" &&
      normalizedMethod === "POST" &&
      path === "/api/auth/change-password") ||
    (state.purpose === "delete-account" &&
      normalizedMethod === "DELETE" &&
      path === "/api/auth/me");
  if (!endpointMatches) {
    throw new Error(
      "Credencial de transição usada fora do endpoint autorizado",
    );
  }

  if (Platform.OS !== "web") {
    const admittedAuthorityCurrent =
      state.nativeAuthority === "ADMITTED" &&
      state.tokenVersion === sessionTokenCacheVersion &&
      Boolean(state.nativeToken) &&
      sessionTokenCacheInitialized &&
      sessionTokenCache === state.nativeToken;
    const pending = reversibleSessionRevocation;
    const reversibleAuthorityCurrent =
      state.nativeAuthority === "REVERSIBLE_PENDING" &&
      state.tokenVersion === sessionTokenCacheVersion &&
      Boolean(state.nativeToken) &&
      state.reversibleTicket !== undefined &&
      pending?.ticket === state.reversibleTicket &&
      pending.version === state.tokenVersion &&
      pending.token === state.nativeToken &&
      pending.binding.expectedUserId === state.expectedUserId &&
      tokenMatchesBinding(pending.token, pending.binding);
    if (!admittedAuthorityCurrent && !reversibleAuthorityCurrent) {
      throw new Error("Bearer da transição não corresponde à sessão capturada");
    }
    return {
      expectedUserId: state.expectedUserId,
      authorization: `Bearer ${state.nativeToken}`,
    };
  }

  const workflowSignal = getActiveWebSessionWorkflowSignal();
  const workflow = workflowSignal
    ? webSessionWorkflowRevisions.get(workflowSignal)
    : undefined;
  if (
    !workflowSignal ||
    workflowSignal.aborted ||
    !workflow ||
    state.webWorkflowRevision === undefined ||
    workflow.previousRevision !== state.webWorkflowRevision ||
    readWebSessionWorkflowRevision() !== workflow.revision
  ) {
    throw new Error(
      "Credencial web usada fora do workflow que cercou a sessão",
    );
  }

  if (
    !state.webSessionInstance ||
    !SESSION_INSTANCE_PATTERN.test(state.webSessionInstance)
  ) {
    throw new Error("Credencial web sem instância canônica da sessão");
  }
  return {
    expectedUserId: state.expectedUserId,
    sessionInstance: state.webSessionInstance,
  };
}

export function discardSessionTransitionCredential(
  credential: SessionTransitionCredential,
): void {
  sessionTransitionCredentials.delete(credential);
}

/** Atualiza a capability de DELETE depois que A virou PENDING reversível. */
export function bindSessionTransitionCredentialToReversibleRevocation(
  credential: SessionTransitionCredential,
  ticket: ReversibleSessionRevocation,
): void {
  const state = sessionTransitionCredentials.get(credential);
  const prepared = reversibleSessionRevocation;
  if (
    !state ||
    state.purpose !== "delete-account" ||
    !prepared ||
    prepared.ticket !== ticket ||
    state.expectedUserId !== prepared.binding.expectedUserId ||
    state.nativeToken !== prepared.token
  ) {
    sessionTransitionCredentials.delete(credential);
    throw new Error("DELETE não corresponde à sessão reversível preparada");
  }
  sessionTransitionCredentials.set(credential, {
    ...state,
    tokenVersion: prepared.version,
    nativeAuthority: "REVERSIBLE_PENDING",
    reversibleTicket: ticket,
  });
}

export function subscribeExternalWebSessionInvalidation(
  listener: () => void,
): () => void {
  externalWebSessionInvalidationListeners.add(listener);
  return () => externalWebSessionInvalidationListeners.delete(listener);
}

function notifyExternalWebSessionInvalidation(): void {
  closeSessionTokenTransportAdmission();
  for (const listener of externalWebSessionInvalidationListeners) listener();
}

if (
  Platform.OS === "web" &&
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (
      event.key !== WEB_SESSION_QUARANTINE_KEY &&
      event.key !== WEB_SESSION_WORKFLOW_REVISION_KEY &&
      event.key !== null
    ) {
      return;
    }
    // `storage` só dispara nas outras abas. Qualquer mudança significa que o
    // cookie pode ter sido substituído fora deste processo; fecha a prova A
    // antes de qualquer rerender e nunca conserva ownership de marker alheio.
    if (event.key === WEB_SESSION_QUARANTINE_KEY) {
      ownedWebSessionGate = null;
      observedWebSessionGate = event.newValue;
    } else if (event.key === WEB_SESSION_WORKFLOW_REVISION_KEY) {
      ownedWebSessionGate = null;
      observedWebSessionGate =
        webLocalStorage()?.getItem(WEB_SESSION_QUARANTINE_KEY) ?? null;
    } else if (event.key === null) {
      ownedWebSessionGate = null;
      observedWebSessionGate = null;
    }
    notifyExternalWebSessionInvalidation();
  });
}

async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    return AsyncStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function secureRemove(key: string): Promise<void> {
  if (Platform.OS === "web") {
    await AsyncStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

function pendingBindingFromMarker(
  marker: string | null,
): SessionTokenBinding | null {
  return parseBinding(marker, SESSION_TOKEN_PENDING_PREFIX);
}

function pendingBindingFromAdmission(
  admission: string | null,
): SessionTokenBinding | null {
  return parseBinding(admission, SESSION_TOKEN_PENDING_PREFIX);
}

function committedBindingFromAdmission(
  admission: string | null,
): SessionTokenBinding | null {
  return parseBinding(admission, SESSION_TOKEN_COMMITTED_PREFIX);
}

function legacyRevocationBindingFromSnapshot(
  snapshot: NativeSessionSnapshot,
): LegacySessionTokenBinding | null {
  const markerBinding = parseLegacyRevocationBinding(snapshot.marker);
  const admissionBinding = parseLegacyRevocationBinding(snapshot.admission);
  if (
    markerBinding &&
    admissionBinding &&
    (markerBinding.fingerprint !== admissionBinding.fingerprint ||
      (markerBinding.revision === "v2" &&
        admissionBinding.revision === "v2" &&
        markerBinding.nonce !== admissionBinding.nonce))
  ) {
    return null;
  }
  // Um valor sibling não legado (PENDING, COMMITTED, blocked ou malformado)
  // não pode ser projetado como migração raw-only. A única exceção é a metade
  // ausente de um write interrompido, retomada pela outra metade exata.
  if (
    (snapshot.marker !== null && !markerBinding) ||
    (snapshot.admission !== null && !admissionBinding)
  ) {
    return null;
  }
  if (markerBinding?.revision === "v2") return markerBinding;
  if (admissionBinding?.revision === "v2") return admissionBinding;
  return markerBinding ?? admissionBinding;
}

function isRawOnlyLegacySnapshot(snapshot: NativeSessionSnapshot): boolean {
  return (
    Boolean(snapshot.token?.trim()) &&
    snapshot.marker === null &&
    snapshot.admission === null
  );
}

async function readNativeSessionSnapshot(): Promise<NativeSessionSnapshot> {
  const [marker, token, admission] = await Promise.all([
    AsyncStorage.getItem(SESSION_TOKEN_REVOKED_KEY),
    secureGet(SESSION_TOKEN_KEY),
    secureGet(SESSION_TOKEN_ADMISSION_KEY),
  ]);
  return { marker, token, admission };
}

function admittedBindingFromSnapshot(
  snapshot: NativeSessionSnapshot,
): SessionTokenBinding | null {
  // O estado autorizado é positivo: ausência CONFIRMADA do marker + prova
  // COMMITTED canônica e bindada ao mesmo Bearer. Qualquer conteúdo presente,
  // inclusive ""/whitespace/valores legados, permanece bloqueado.
  if (snapshot.marker !== null) return null;
  const token = snapshot.token?.trim() ? snapshot.token : null;
  const binding = committedBindingFromAdmission(snapshot.admission);
  if (!token || !binding || !tokenMatchesBinding(token, binding)) return null;
  return binding;
}

function admittedTokenFromSnapshot(
  snapshot: NativeSessionSnapshot,
): string | null {
  return admittedBindingFromSnapshot(snapshot) ? snapshot.token : null;
}

function isCleanUnauthenticatedSnapshot(
  snapshot: NativeSessionSnapshot,
): boolean {
  const tokenAbsent = !snapshot.token?.trim();
  const admissionAbsent = !snapshot.admission?.trim();
  return tokenAbsent && admissionAbsent && snapshot.marker === null;
}

function isStartableRevokedSnapshot(snapshot: NativeSessionSnapshot): boolean {
  // A ausência confirmada do raw é a prova load-bearing: marker/admission
  // residuais não carregam um Bearer e jamais autorizam leitura. Um novo stage
  // pode substituí-los por PENDING canônico sem perder o único transporte que
  // permitiria revogar uma sessão remota. Qualquer raw presente, mesmo sob um
  // tombstone conhecido, continua bloqueado até reconciliação explícita.
  return !snapshot.token?.trim();
}

function isRevokedCleanupClearTail(snapshot: NativeSessionSnapshot): boolean {
  return (
    snapshot.marker === SESSION_TOKEN_BLOCKED_MARKER &&
    !snapshot.token?.trim() &&
    !snapshot.admission?.trim()
  );
}

function revocablePendingBindingFromSnapshot(
  snapshot: NativeSessionSnapshot,
): SessionTokenBinding | null {
  const markerBinding = pendingBindingFromMarker(snapshot.marker);
  if (markerBinding) return markerBinding;
  // A admission PENDING bindada ao raw B é uma prova positiva suficiente
  // SOMENTE para o escape de revogação. Isto cobre marker blocked/ausente e
  // também um valor legado/malformado que impediu o readback da nova escrita.
  // O marker continua bloqueando toda leitura normal; e um marker PENDING
  // canônico sempre vence, de modo que bindings A/B conflitantes não escolhem
  // silenciosamente a admission.
  return pendingBindingFromAdmission(snapshot.admission);
}

function revocableLegacyTokenFromSnapshot(
  snapshot: NativeSessionSnapshot,
): string | null {
  const token = snapshot.token?.trim() ? snapshot.token : null;
  if (!token) return null;
  const binding = legacyRevocationBindingFromSnapshot(snapshot);
  if (binding && tokenMatchesLegacyBinding(token, binding)) return token;
  return null;
}

function admissionMatchesCleanupBinding(
  admission: string | null,
  binding: RevokedCleanupBinding,
): boolean {
  if (admission === null || admission === "") return true;
  const cleanup = revokedCleanupBindingFromAdmission(admission);
  if (cleanup) return sameRevokedCleanupBinding(cleanup, binding);
  const pending = pendingBindingFromAdmission(admission);
  if (pending) {
    return (
      binding.expectedUserId !== undefined &&
      pending.expectedUserId === binding.expectedUserId &&
      pending.nonce === binding.nonce &&
      pending.fingerprint === binding.fingerprint
    );
  }
  const committed = committedBindingFromAdmission(admission);
  if (committed) {
    return (
      binding.expectedUserId !== undefined &&
      committed.expectedUserId === binding.expectedUserId &&
      committed.nonce === binding.nonce &&
      committed.fingerprint === binding.fingerprint
    );
  }
  const legacy = parseLegacyRevocationBinding(admission);
  return (
    legacy?.fingerprint === binding.fingerprint &&
    (legacy.revision === "v1" || legacy.nonce === binding.nonce)
  );
}

function markerCanPrecedeRevokedCleanup(
  marker: string | null,
  binding: RevokedCleanupBinding,
): boolean {
  if (marker === null || marker === SESSION_TOKEN_BLOCKED_MARKER) return true;
  const pending = pendingBindingFromMarker(marker);
  if (pending) {
    return (
      binding.expectedUserId !== undefined &&
      pending.expectedUserId === binding.expectedUserId &&
      pending.nonce === binding.nonce &&
      pending.fingerprint === binding.fingerprint
    );
  }
  const legacy = parseLegacyRevocationBinding(marker);
  return (
    legacy?.fingerprint === binding.fingerprint &&
    (legacy.revision === "v1" || legacy.nonce === binding.nonce)
  );
}

function bindingForReversibleDeleteCleanup(
  snapshot: NativeSessionSnapshot,
  token: string,
  expectedBinding: SessionTokenBinding,
): RevokedCleanupBinding {
  if (!tokenMatchesBinding(token, expectedBinding)) {
    throw new Error("Receipt reversível divergiu do Bearer preparado");
  }
  const existingCleanup = revokedCleanupBindingFromAdmission(
    snapshot.admission,
  );
  if (isRevokedCleanupAdmissionNamespace(snapshot.admission)) {
    if (!existingCleanup) {
      throw new Error("Admission REVOKED_CLEANUP_REQUIRED corrompida");
    }
    if (
      !markerCanPrecedeRevokedCleanup(snapshot.marker, existingCleanup) ||
      existingCleanup.expectedUserId !== expectedBinding.expectedUserId ||
      existingCleanup.nonce !== expectedBinding.nonce ||
      existingCleanup.fingerprint !== expectedBinding.fingerprint ||
      (snapshot.token?.trim() && snapshot.token !== token)
    ) {
      throw new Error("A confirmação remota divergiu do cleanup já persistido");
    }
    return existingCleanup;
  }

  if (snapshot.token !== token) {
    throw new Error(
      "O Bearer confirmado remotamente não corresponde ao raw físico",
    );
  }

  const markerPending = pendingBindingFromMarker(snapshot.marker);
  const admissionPending = pendingBindingFromAdmission(snapshot.admission);
  if (
    !markerPending ||
    !admissionPending ||
    !sameBinding(markerPending, expectedBinding) ||
    !sameBinding(admissionPending, expectedBinding)
  ) {
    throw new Error("DELETE não preservou ambas as provas PENDING da receipt");
  }
  return expectedBinding;
}

function validatePreparedRevocation(
  prepared: PreparedSessionTokenRevocation,
): void {
  if (
    !prepared.token.trim() ||
    !/^[0-9a-f]{64}$/.test(prepared.fingerprint) ||
    !/^[0-9a-f]{32}$/.test(prepared.nonce) ||
    fingerprintSessionToken(prepared.token) !== prepared.fingerprint ||
    (prepared.phase !== "PENDING" && prepared.phase !== "LEGACY") ||
    (prepared.expectedUserId !== undefined &&
      (!Number.isSafeInteger(prepared.expectedUserId) ||
        prepared.expectedUserId <= 0)) ||
    (prepared.phase === "PENDING" && prepared.expectedUserId === undefined) ||
    (prepared.phase === "LEGACY" && prepared.expectedUserId !== undefined)
  ) {
    throw new Error("Binding preparado da revogação é inválido");
  }
}

function sessionBindingMatchesPrepared(
  binding: SessionTokenBinding,
  prepared: PreparedSessionTokenRevocation,
): boolean {
  return (
    prepared.phase === "PENDING" &&
    binding.expectedUserId === prepared.expectedUserId &&
    binding.nonce === prepared.nonce &&
    binding.fingerprint === prepared.fingerprint
  );
}

function legacyBindingMatchesPrepared(
  binding: LegacySessionTokenBinding,
  prepared: PreparedSessionTokenRevocation,
): boolean {
  return (
    binding.revision === "v2" &&
    binding.nonce === prepared.nonce &&
    binding.fingerprint === prepared.fingerprint
  );
}

function cleanupUserIdFromRemoteProof(
  prepared: PreparedSessionTokenRevocation,
  revocationStatus: "ROTATED" | "ALREADY_INVALID",
  revocationUserId: number | null,
): number | undefined {
  const validServerUserId =
    revocationUserId !== null &&
    Number.isSafeInteger(revocationUserId) &&
    revocationUserId > 0;
  if (revocationStatus === "ROTATED" && !validServerUserId) {
    throw new Error("ROTATED exige revocationUserId positivo do servidor");
  }
  if (revocationUserId !== null && !validServerUserId) {
    throw new Error("revocationUserId remoto inválido");
  }
  if (
    validServerUserId &&
    prepared.expectedUserId !== undefined &&
    revocationUserId !== prepared.expectedUserId
  ) {
    throw new Error(
      "revocationUserId remoto divergiu do binding físico preparado",
    );
  }
  return validServerUserId
    ? revocationUserId
    : revocationStatus === "ALREADY_INVALID"
      ? prepared.expectedUserId
      : undefined;
}

function preparedRevocationCleanupAlreadyDurable(
  snapshot: NativeSessionSnapshot,
  prepared: PreparedSessionTokenRevocation,
): boolean {
  if (!isRevokedCleanupAdmissionNamespace(snapshot.admission)) return false;
  validatePreparedRevocation(prepared);
  const existingCleanup = revokedCleanupBindingFromAdmission(
    snapshot.admission,
  );
  if (
    !existingCleanup ||
    existingCleanup.nonce !== prepared.nonce ||
    existingCleanup.fingerprint !== prepared.fingerprint ||
    (prepared.expectedUserId !== undefined &&
      existingCleanup.expectedUserId !== prepared.expectedUserId) ||
    !markerCanPrecedeRevokedCleanup(snapshot.marker, existingCleanup) ||
    (snapshot.token?.trim() && snapshot.token !== prepared.token)
  ) {
    throw new Error("O cleanup durável divergiu do binding preparado");
  }
  return true;
}

function bindingForPreparedRevocation(
  snapshot: NativeSessionSnapshot,
  prepared: PreparedSessionTokenRevocation,
  revocationStatus: "ROTATED" | "ALREADY_INVALID",
  revocationUserId: number | null,
): RevokedCleanupBinding {
  validatePreparedRevocation(prepared);
  const cleanupUserId = cleanupUserIdFromRemoteProof(
    prepared,
    revocationStatus,
    revocationUserId,
  );
  const cleanupBinding: RevokedCleanupBinding = {
    ...(cleanupUserId === undefined ? {} : { expectedUserId: cleanupUserId }),
    nonce: prepared.nonce,
    fingerprint: prepared.fingerprint,
  };

  const existingCleanup = revokedCleanupBindingFromAdmission(
    snapshot.admission,
  );
  if (isRevokedCleanupAdmissionNamespace(snapshot.admission)) {
    if (
      !existingCleanup ||
      !sameRevokedCleanupBinding(existingCleanup, cleanupBinding) ||
      !markerCanPrecedeRevokedCleanup(snapshot.marker, existingCleanup) ||
      (snapshot.token?.trim() && snapshot.token !== prepared.token)
    ) {
      throw new Error("A prova remota divergiu do cleanup já persistido");
    }
    return existingCleanup;
  }

  if (snapshot.token !== prepared.token) {
    throw new Error("O raw físico mudou após a preparação da revogação");
  }

  const markerPending = pendingBindingFromMarker(snapshot.marker);
  const admissionPending = pendingBindingFromAdmission(snapshot.admission);
  const admissionCommitted = committedBindingFromAdmission(snapshot.admission);
  const markerLegacy = parseLegacyRevocationBinding(snapshot.marker);
  const admissionLegacy = parseLegacyRevocationBinding(snapshot.admission);

  if (prepared.phase === "PENDING") {
    const sessionCandidates = [
      markerPending,
      admissionPending,
      admissionCommitted,
    ].filter(
      (candidate): candidate is SessionTokenBinding => candidate !== null,
    );
    if (
      sessionCandidates.length === 0 ||
      sessionCandidates.some(
        (candidate) => !sessionBindingMatchesPrepared(candidate, prepared),
      ) ||
      (markerLegacy !== null &&
        !legacyBindingMatchesPrepared(markerLegacy, prepared)) ||
      (admissionLegacy !== null &&
        !legacyBindingMatchesPrepared(admissionLegacy, prepared)) ||
      (snapshot.marker !== null &&
        snapshot.marker !== SESSION_TOKEN_BLOCKED_MARKER &&
        markerPending === null &&
        markerLegacy === null) ||
      (snapshot.admission !== null &&
        admissionPending === null &&
        admissionCommitted === null &&
        admissionLegacy === null)
    ) {
      throw new Error("Binding PENDING físico divergiu da preparação");
    }
  } else if (
    !markerLegacy ||
    !admissionLegacy ||
    !legacyBindingMatchesPrepared(markerLegacy, prepared) ||
    !legacyBindingMatchesPrepared(admissionLegacy, prepared) ||
    snapshot.marker !==
      `${SESSION_TOKEN_LEGACY_REVOKE_V2_PREFIX}:${prepared.nonce}:${prepared.fingerprint}` ||
    snapshot.admission !==
      `${SESSION_TOKEN_LEGACY_REVOKE_V2_PREFIX}:${prepared.nonce}:${prepared.fingerprint}`
  ) {
    throw new Error("Binding legacy v2 físico divergiu da preparação");
  }

  return cleanupBinding;
}

async function persistPendingMarker(
  binding: SessionTokenBinding,
): Promise<void> {
  const expected = encodePendingBinding(binding);
  await AsyncStorage.setItem(SESSION_TOKEN_REVOKED_KEY, expected);
  const persisted = await AsyncStorage.getItem(SESSION_TOKEN_REVOKED_KEY);
  if (persisted !== expected) {
    throw new Error("Marcador pendente da sessão não foi confirmado");
  }
}

async function persistRevocationBarrier(
  binding: SessionTokenBinding,
): Promise<void> {
  const failures: unknown[] = [];
  let confirmed = false;
  // A prova positiva PENDING bloqueia o Bearer mesmo se o marker store perder
  // o ACK ou fizer set no-op. O getter de revogação reconhece essa metade
  // quando marker === null, preservando B através de restart.
  try {
    await persistExactSecureValue(
      SESSION_TOKEN_ADMISSION_KEY,
      encodePendingBinding(binding),
      "Barreira PENDING da revogação não foi confirmada",
    );
    confirmed = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    await persistPendingMarker(binding);
    confirmed = true;
  } catch (error) {
    failures.push(error);
  }
  if (!confirmed) {
    throw new AggregateError(
      failures,
      "Nenhuma barreira durável da revogação foi confirmada",
    );
  }
}

async function persistBlockedMarker(): Promise<void> {
  await AsyncStorage.setItem(
    SESSION_TOKEN_REVOKED_KEY,
    SESSION_TOKEN_BLOCKED_MARKER,
  );
  const persisted = await AsyncStorage.getItem(SESSION_TOKEN_REVOKED_KEY);
  if (persisted !== SESSION_TOKEN_BLOCKED_MARKER) {
    throw new Error("Marcador de revogação não foi confirmado");
  }
}

async function persistRevokedCleanupPhase(
  binding: RevokedCleanupBinding,
): Promise<void> {
  const expectedAdmission = encodeRevokedCleanupBinding(binding);
  const admission = await confirmWriteDespiteLostAck(
    expectedAdmission,
    () => secureSet(SESSION_TOKEN_ADMISSION_KEY, expectedAdmission),
    () => secureGet(SESSION_TOKEN_ADMISSION_KEY),
  );
  if (!admission.confirmed) {
    throw new AggregateError(
      admission.error === undefined ? [] : [admission.error],
      "Admission REVOKED_CLEANUP_REQUIRED não foi confirmada",
    );
  }

  await persistRevokedCleanupBlockedMarker();
}

async function persistRevokedCleanupBlockedMarker(): Promise<void> {
  const marker = await confirmWriteDespiteLostAck(
    SESSION_TOKEN_BLOCKED_MARKER,
    () =>
      AsyncStorage.setItem(
        SESSION_TOKEN_REVOKED_KEY,
        SESSION_TOKEN_BLOCKED_MARKER,
      ),
    () => AsyncStorage.getItem(SESSION_TOKEN_REVOKED_KEY),
  );
  if (!marker.confirmed) {
    throw new AggregateError(
      marker.error === undefined ? [] : [marker.error],
      "Marker bloqueado do cleanup revogado não foi confirmado",
    );
  }
}

async function persistExactSecureValue(
  key: string,
  value: string,
  errorMessage: string,
): Promise<void> {
  await secureSet(key, value);
  const persisted = await secureGet(key);
  if (persisted !== value) throw new Error(errorMessage);
}

async function confirmWriteDespiteLostAck(
  expected: string,
  write: () => Promise<void>,
  read: () => Promise<string | null>,
): Promise<Readonly<{ confirmed: boolean; error?: unknown }>> {
  let writeError: unknown;
  try {
    await write();
  } catch (error) {
    writeError = error;
  }
  try {
    if ((await read()) === expected) return { confirmed: true };
  } catch (readError) {
    return {
      confirmed: false,
      error: new AggregateError(
        [writeError, readError].filter((error) => error !== undefined),
        "Readback da barreira legacy falhou",
      ),
    };
  }
  return {
    confirmed: false,
    error:
      writeError ??
      new Error("A escrita da barreira legacy não produziu o valor esperado"),
  };
}

async function ensureLegacyRevocationBarrier(
  snapshot: NativeSessionSnapshot,
  token: string,
): Promise<Extract<LegacySessionTokenBinding, { revision: "v2" }>> {
  const fingerprint = fingerprintSessionToken(token);
  const existingMarker = parseLegacyRevocationBinding(snapshot.marker);
  const existingAdmission = parseLegacyRevocationBinding(snapshot.admission);
  const existingBinding = legacyRevocationBindingFromSnapshot(snapshot);
  if (
    snapshot.token !== token ||
    (!isRawOnlyLegacySnapshot(snapshot) && !existingBinding) ||
    (existingMarker && existingMarker.fingerprint !== fingerprint) ||
    (existingAdmission && existingAdmission.fingerprint !== fingerprint)
  ) {
    throw new Error("O binding legacy não corresponde ao Bearer físico");
  }

  const expectedBinding = {
    revision: "v2" as const,
    nonce:
      existingBinding?.revision === "v2"
        ? existingBinding.nonce
        : createSessionTokenNonce(),
    fingerprint,
  };
  const expected = encodeLegacyRevocationBinding(expectedBinding);

  // Admission primeiro: um crash nunca deixa somente um marker novo com nonce
  // sem a metade segura. As duas metades v2 precisam de readback exato antes de
  // qualquer /me/logout; v1 parcial continua apenas revoke-only.
  if (snapshot.admission !== expected) {
    const admission = await confirmWriteDespiteLostAck(
      expected,
      () => secureSet(SESSION_TOKEN_ADMISSION_KEY, expected),
      () => secureGet(SESSION_TOKEN_ADMISSION_KEY),
    );
    if (!admission.confirmed) {
      throw new AggregateError(
        admission.error === undefined ? [] : [admission.error],
        "A admission legacy v2 não pôde ser confirmada",
      );
    }
  }
  if (snapshot.marker !== expected) {
    const marker = await confirmWriteDespiteLostAck(
      expected,
      () => AsyncStorage.setItem(SESSION_TOKEN_REVOKED_KEY, expected),
      () => AsyncStorage.getItem(SESSION_TOKEN_REVOKED_KEY),
    );
    if (!marker.confirmed) {
      throw new AggregateError(
        marker.error === undefined ? [] : [marker.error],
        "O marker legacy v2 não pôde ser confirmado",
      );
    }
  }

  // O raw precisa continuar sendo exatamente o que foi bindado. Uma escrita
  // concorrente ou um SecureStore no-op jamais ganha um request remoto por
  // herdar o marker de outro token.
  const persisted = await readNativeSessionSnapshot();
  const persistedToken = persisted.token?.trim() ? persisted.token : null;
  const binding = legacyRevocationBindingFromSnapshot(persisted);
  if (
    persistedToken !== token ||
    binding?.revision !== "v2" ||
    binding.nonce !== expectedBinding.nonce ||
    persisted.marker !== expected ||
    persisted.admission !== expected ||
    !tokenMatchesLegacyBinding(token, binding)
  ) {
    throw new Error("A barreira legacy perdeu o vínculo com o Bearer físico");
  }
  return expectedBinding;
}

async function resolveLegacyRevocationUserId(
  token: string,
): Promise<number | null> {
  const response = await requestCanonicalSession<{ user?: User }>({
    nativeToken: token,
  });
  if (response.ok) {
    const userId = response.data?.user?.id;
    if (
      typeof userId !== "number" ||
      !Number.isSafeInteger(userId) ||
      userId <= 0
    ) {
      throw new Error("O /me legacy não devolveu identidade canônica");
    }
    return userId;
  }
  if (response.status === 401 && response.credentialPresented) {
    // O endpoint canônico recusou exatamente este Bearer. O logout explícito
    // permanece idempotente, mas não é preciso fabricar userId para enviá-lo.
    return null;
  }
  throw new Error("O /me legacy não confirmou a sessão para revogação");
}

async function releasePendingMarker(
  binding: SessionTokenBinding,
): Promise<void> {
  let releaseError: unknown;
  try {
    await AsyncStorage.removeItem(SESSION_TOKEN_REVOKED_KEY);
    const persisted = await AsyncStorage.getItem(SESSION_TOKEN_REVOKED_KEY);
    if (persisted !== null) {
      throw new Error("Commit do token de sessão não foi confirmado");
    }
    return;
  } catch (error) {
    releaseError = error;
  }

  // Recuperação sequencial: uma barreira confirmada preserva o único B capaz
  // de revogar a sessão remota. Tombstone só é aceitável se marker e prova
  // PENDING deixarem de ser confirmáveis.
  const barrierFailures: unknown[] = [];
  try {
    await persistPendingMarker(binding);
    throw releaseError;
  } catch (error) {
    if (error === releaseError) throw error;
    barrierFailures.push(error);
  }
  try {
    const admission = await secureGet(SESSION_TOKEN_ADMISSION_KEY);
    if (admission !== encodePendingBinding(binding)) {
      throw new Error("Barreira positiva PENDING não foi confirmada");
    }
    throw releaseError;
  } catch (error) {
    if (error === releaseError) throw error;
    barrierFailures.push(error);
  }
  try {
    await persistExactSecureValue(
      SESSION_TOKEN_KEY,
      "",
      "Tombstone do token de sessão não foi confirmado",
    );
    throw releaseError;
  } catch (error) {
    if (error === releaseError) throw error;
    barrierFailures.push(error);
  }
  throw new SessionTokenCommitAmbiguousError(
    "Release do token ficou ambíguo sem barreira local confirmada",
    new AggregateError(
      [releaseError, ...barrierFailures],
      "Release do token falhou sem barreira local confirmada",
    ),
  );
}

async function persistCommittedAdmission(
  binding: SessionTokenBinding,
): Promise<void> {
  const expected = encodeCommittedAdmission(binding);
  let writeError: unknown;
  try {
    await secureSet(SESSION_TOKEN_ADMISSION_KEY, expected);
  } catch (error) {
    writeError = error;
  }
  let persisted: string | null = null;
  let readError: unknown;
  try {
    persisted = await secureGet(SESSION_TOKEN_ADMISSION_KEY);
  } catch (error) {
    readError = error;
  }
  if (persisted === expected) return;
  const admissionError = new AggregateError(
    [writeError, readError].filter((error) => error !== undefined),
    "Autorização positiva do token não foi confirmada",
  );

  // A escrita COMMITTED pode ter sido aplicada antes de set/get falhar. Antes
  // de rejeitar, confirma ao menos uma barreira que torne esse estado ambíguo
  // não publicável após restart. A primeira opção não toca o raw B e preserva
  // sua revogação explícita; as demais são contenções de último recurso.
  const barrierFailures: unknown[] = [];
  const confirmFallbackBarrier = async (
    operation: () => Promise<void>,
  ): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (error) {
      barrierFailures.push(error);
      return false;
    }
  };
  if (await confirmFallbackBarrier(() => persistPendingMarker(binding))) {
    throw admissionError;
  }
  if (
    await confirmFallbackBarrier(() =>
      persistExactSecureValue(
        SESSION_TOKEN_ADMISSION_KEY,
        encodePendingBinding(binding),
        "Restauração da barreira positiva não foi confirmada",
      ),
    )
  ) {
    throw admissionError;
  }
  if (
    await confirmFallbackBarrier(() =>
      persistExactSecureValue(
        SESSION_TOKEN_KEY,
        "",
        "Tombstone do token de sessão não foi confirmado",
      ),
    )
  ) {
    throw admissionError;
  }
  throw new SessionTokenCommitAmbiguousError(
    "Commit do token ficou ambíguo sem barreira local confirmada",
    new AggregateError(
      [admissionError, ...barrierFailures],
      "Commit do token falhou sem barreira local confirmada",
    ),
  );
}

export async function getSessionToken(): Promise<string | null> {
  if (Platform.OS !== "web") {
    const transportAdmission = nativeSessionTransportAdmission;
    if (
      !transportAdmission ||
      transportAdmission.version !== sessionTokenCacheVersion
    ) {
      nativeSessionTransportAdmission = null;
      return null;
    }
  }
  if (sessionTokenCacheInitialized) return sessionTokenCache;
  if (sessionTokenRead) return sessionTokenRead;

  const readVersion = sessionTokenCacheVersion;
  const expectedTransportAdmission = nativeSessionTransportAdmission;
  const read = (async (): Promise<{
    storedValue: string | null;
    cacheable: boolean;
  }> => {
    try {
      const snapshot = await readNativeSessionSnapshot();
      const binding = admittedBindingFromSnapshot(snapshot);
      const transportStillCurrent =
        Platform.OS === "web" ||
        (expectedTransportAdmission !== null &&
          nativeSessionTransportAdmission === expectedTransportAdmission &&
          expectedTransportAdmission.version === readVersion &&
          binding !== null &&
          sameBinding(binding, expectedTransportAdmission.binding));
      return {
        storedValue: transportStillCurrent ? snapshot.token : null,
        cacheable: transportStillCurrent,
      };
    } catch {
      // Sem ler as duas metades da prova não há autoridade. Não memoriza o
      // resultado para permitir recuperação numa leitura posterior.
      return { storedValue: null, cacheable: false };
    }
  })().then(({ storedValue, cacheable }) => {
    const storedToken = storedValue?.trim() ? storedValue : null;
    if (sessionTokenCacheVersion === readVersion) {
      // Falha ao ler a prova retorna null, mas não pode virar uma prova
      // cacheada. Uma leitura saudável posterior deve poder se recuperar.
      // A snapshot é repetida só após falha; uma prova saudável passa a usar
      // exclusivamente a memória e elimina os RTTs de storage.
      if (cacheable) {
        sessionTokenCache = storedToken;
        sessionTokenCacheInitialized = true;
      }
      return storedToken;
    }
    return sessionTokenCacheInitialized ? sessionTokenCache : null;
  });
  const cachedRead = read.finally(() => {
    if (sessionTokenRead === cachedRead) sessionTokenRead = null;
  });
  sessionTokenRead = cachedRead;
  return cachedRead;
}

/**
 * Bearer físico restrito ao `/me` de admissão. Não abre o canal normal e
 * exige marker ausente, COMMITTED canônico, SHA exato e o mesmo userId.
 */
export async function getSessionTokenForValidation(
  expectedUserId: number,
): Promise<string> {
  if (Platform.OS === "web") {
    throw new Error("Validação Bearer indisponível no web");
  }
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) {
    throw new Error("Usuário esperado da sessão inválido");
  }
  const snapshot = await readNativeSessionSnapshot();
  const binding = admittedBindingFromSnapshot(snapshot);
  const token = snapshot.token?.trim() ? snapshot.token : null;
  if (!binding || binding.expectedUserId !== expectedUserId || !token) {
    throw new Error("Bearer admitido não corresponde à validação esperada");
  }
  return token;
}

/**
 * Abre o canal normal somente depois de o caller provar `/me` do mesmo userId.
 * A snapshot é relida e vinculada à versão corrente para impedir que uma
 * mutação concorrente libere outro Bearer entre a prova e a publicação.
 */
export async function admitSessionTokenTransport(
  receipt: SessionValidationReceipt,
): Promise<void> {
  if (Platform.OS === "web") return;
  const readVersion = sessionTokenCacheVersion;
  const snapshot = await readNativeSessionSnapshot();
  const binding = admittedBindingFromSnapshot(snapshot);
  const token = snapshot.token?.trim() ? snapshot.token : null;
  const validation = consumeCanonicalSessionValidation(receipt, "native");
  const expectedUserId = validation.userId;
  if (
    sessionTokenCacheVersion !== readVersion ||
    !binding ||
    binding.expectedUserId !== expectedUserId ||
    !token ||
    validation.nativeTokenFingerprint !== fingerprintSessionToken(token)
  ) {
    nativeSessionTransportAdmission = null;
    throw new Error("Sessão nativa não pôde ser admitida no transporte");
  }
  nativeSessionTransportAdmission = { version: readVersion, binding };
  sessionTransportAdmittedUserId = expectedUserId;
  sessionTransportGeneration += 1;
  sessionTokenCache = token;
  sessionTokenCacheInitialized = true;
}

/**
 * Web não expõe o cookie. A mesma receipt canônica que admite o transporte
 * também remove por CAS a ADMISSION física correspondente. REVOKE_REQUIRED,
 * LOGIN_IN_PROGRESS e markers desconhecidos jamais são liberados aqui.
 */
export async function admitWebSessionTransport(
  receipt: SessionValidationReceipt,
): Promise<void> {
  if (Platform.OS !== "web") return;
  const validation = consumeCanonicalSessionValidation(receipt, "web");
  const expectedUserId = validation.userId;
  if (!validation.webWorkflowRevision) {
    throw new Error("Receipt web sem revisão física da sessão");
  }
  if (!validation.sessionInstance) {
    throw new Error("Receipt web sem instância canônica da sessão");
  }
  const mutation = webSessionQuarantineTail.then(async () => {
    const storage = webLocalStorage();
    if (!storage) {
      throw new Error("Storage cross-tab da sessão web indisponível");
    }
    const marker = storage.getItem(WEB_SESSION_QUARANTINE_KEY);
    if (marker !== null) {
      if (parseWebAdmissionExpectedUserId(marker) !== expectedUserId) {
        throw new Error("Receipt canônica não corresponde à ADMISSION web");
      }
      await clearExactWebSessionGate(marker);
      if (ownedWebSessionGate === marker) ownedWebSessionGate = null;
      if (observedWebSessionGate === marker) observedWebSessionGate = null;
    }
    if (
      validation.transportGeneration !== sessionTransportGeneration ||
      validation.tokenVersion !== sessionTokenCacheVersion ||
      readWebSessionWorkflowRevision() !== validation.webWorkflowRevision
    ) {
      throw new Error("Receipt web ficou stale durante a liberação do gate");
    }
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
  admittedWebSessionWorkflowRevision = validation.webWorkflowRevision;
  admittedWebSessionInstance = validation.sessionInstance;
  sessionTransportAdmittedUserId = expectedUserId;
  sessionTransportGeneration += 1;
}

/**
 * Identidade durável esperada para o Bearer atualmente admitido. No disco,
 * só uma snapshot saudável (marker ausente + COMMITTED bindado) conta.
 * PENDING, corrupção ou quarentena não concedem identidade. Um disco
 * limpo com admissão em memória deste processo (resume Android) reusa
 * essa admissão — miss de Keystore não é logout.
 */
export async function getAdmittedSessionUserId(): Promise<number | null> {
  const snapshot = await readNativeSessionSnapshot();
  const fromDisk = admittedBindingFromSnapshot(snapshot)?.expectedUserId ?? null;
  if (fromDisk !== null) return fromDisk;
  // Disco limpo após `/me` canônico: no Android o Keystore pode devolver
  // vazio no resume. A admissão em memória deste processo continua válida
  // até BEGIN/logout — um miss transitório não é logout.
  if (
    isCleanUnauthenticatedSnapshot(snapshot) &&
    nativeSessionTransportAdmission !== null &&
    nativeSessionTransportAdmission.version === sessionTokenCacheVersion &&
    sessionTransportAdmittedUserId !== null &&
    sessionTransportAdmittedUserId ===
      nativeSessionTransportAdmission.binding.expectedUserId
  ) {
    return sessionTransportAdmittedUserId;
  }
  return null;
}

declare const stagedSessionTokenBrand: unique symbol;
export type StagedSessionToken = Readonly<{
  [stagedSessionTokenBrand]: true;
}>;

/**
 * Primeira fase da admissão nativa. O Bearer B chega ao SecureStore, mas o
 * marcador independente continua bloqueando qualquer leitura normal. Assim a
 * identidade/cache/tenant podem ser reconciliados sem uma janela em que B já
 * tenha autoridade e o restante do estado local ainda pertença a A.
 */
export async function stageSessionToken(
  token: string,
  expectedUserId: number,
): Promise<StagedSessionToken> {
  if (!token.trim()) throw new Error("Token de sessão vazio");
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) {
    throw new Error("Usuário esperado da sessão inválido");
  }
  if (Platform.OS !== "web") {
    // Um login após crash não repete revogação remota: conclui primeiro apenas
    // o cleanup local já autorizado pela admission durável.
    await resumeRevokedSessionCleanupIfRequired();
  }
  const binding = createSessionTokenBinding(token, expectedUserId);
  const mutationVersion = beginSessionTokenMutation();
  sessionTokenCache = null;
  sessionTokenCacheInitialized = true;
  stagedSessionToken = null;

  const mutation = sessionTokenMutationTail.then(async () => {
    const previous = await readNativeSessionSnapshot();
    // Revalida dentro da fila: outro contexto pode ter persistido a prova de
    // revogação depois do preflight local e antes desta mutação adquirir sua
    // vez. Mesmo sem raw, essa fase só pode desaparecer pelo cleanup local
    // ordenado; um novo PENDING jamais o sobrescreve.
    if (isRevokedCleanupAdmissionNamespace(previous.admission)) {
      throw new Error(
        revokedCleanupBindingFromAdmission(previous.admission)
          ? "Cleanup revogado precisa concluir antes de um novo login"
          : "Admission REVOKED_CLEANUP_REQUIRED corrompida",
      );
    }
    if (
      !isCleanUnauthenticatedSnapshot(previous) &&
      !isStartableRevokedSnapshot(previous) &&
      !admittedBindingFromSnapshot(previous)
    ) {
      // Um B em PENDING/estado ambíguo é o único Bearer capaz de revogar
      // aquela sessão remota. Nunca o sobrescreve com C: o caller precisa
      // concluir a revogação/recovery antes de iniciar outro login.
      throw new Error(
        "Existe uma sessão pendente que ainda exige reconciliação",
      );
    }
    await persistPendingMarker(binding);
    await persistExactSecureValue(
      SESSION_TOKEN_KEY,
      token,
      "Token preparado não foi confirmado no SecureStore",
    );
    await persistExactSecureValue(
      SESSION_TOKEN_ADMISSION_KEY,
      encodePendingBinding(binding),
      "Barreira positiva do token não foi confirmada",
    );
  });
  sessionTokenMutationTail = mutation.catch(() => undefined);
  try {
    await mutation;
    if (sessionTokenCacheVersion === mutationVersion) {
      const ticket = Object.freeze({}) as StagedSessionToken;
      stagedSessionToken = { version: mutationVersion, token, binding, ticket };
      return ticket;
    }
    throw new Error(
      "A preparação do token foi substituída por outra transição",
    );
  } catch (error) {
    if (sessionTokenCacheVersion === mutationVersion) {
      sessionTokenCache = null;
      sessionTokenCacheInitialized = true;
      stagedSessionToken = null;
    }
    throw error;
  }
}

/**
 * Commit da segunda fase. O marker só é liberado após o contexto B; mesmo
 * assim, B só ganha autoridade no restart com uma prova COMMITTED bindada.
 */
export async function commitStagedSessionToken(
  ticket: StagedSessionToken,
): Promise<void> {
  const staged = stagedSessionToken;
  if (
    !staged ||
    staged.ticket !== ticket ||
    sessionTokenCacheVersion !== staged.version
  ) {
    throw new Error("Token preparado não é mais o atual");
  }

  const mutation = sessionTokenMutationTail.then(async () => {
    if (
      stagedSessionToken?.ticket !== ticket ||
      sessionTokenCacheVersion !== staged.version
    ) {
      throw new Error("Token preparado não é mais o atual");
    }
    const snapshot = await readNativeSessionSnapshot();
    const markerBinding = pendingBindingFromMarker(snapshot.marker);
    const admissionBinding = pendingBindingFromAdmission(snapshot.admission);
    if (
      !markerBinding ||
      !admissionBinding ||
      !sameBinding(markerBinding, staged.binding) ||
      !sameBinding(admissionBinding, staged.binding) ||
      snapshot.token !== staged.token ||
      !tokenMatchesBinding(staged.token, staged.binding)
    ) {
      throw new Error("Token preparado perdeu a barreira de admissão");
    }
    await releasePendingMarker(staged.binding);
    await persistCommittedAdmission(staged.binding);
  });
  sessionTokenMutationTail = mutation.catch(() => undefined);
  try {
    await mutation;
    if (
      stagedSessionToken?.ticket === ticket &&
      sessionTokenCacheVersion === staged.version
    ) {
      sessionTokenCache = staged.token;
      sessionTokenCacheInitialized = true;
      stagedSessionToken = null;
      return;
    }
    throw new Error("Token preparado foi substituído durante o commit");
  } catch (error) {
    if (sessionTokenCacheVersion === staged.version) {
      sessionTokenCache = null;
      // Um commit distribuído ambíguo só pode ser assentado por snapshot
      // durável + /me canônico. Não cacheia null: se B realmente ficou
      // COMMITTED, o recovery precisa conseguir relê-lo; se ficou PENDING, a
      // quarentena o revoga sem nunca expor transporte normal.
      sessionTokenCacheInitialized = !isSessionTokenCommitAmbiguousError(error);
      if (isSessionTokenCommitAmbiguousError(error)) stagedSessionToken = null;
    }
    throw error;
  }
}

export async function isSessionTokenQuarantined(): Promise<boolean> {
  let snapshot: NativeSessionSnapshot;
  try {
    snapshot = await readNativeSessionSnapshot();
  } catch {
    // Sem ler a barreira não existe prova para liberar o transporte.
    return true;
  }
  if (
    isRevokedCleanupAdmissionNamespace(snapshot.admission) ||
    isRevokedCleanupClearTail(snapshot)
  ) {
    if (
      !isRevokedCleanupClearTail(snapshot) &&
      !revokedCleanupBindingFromAdmission(snapshot.admission)
    ) {
      throw new Error("Admission REVOKED_CLEANUP_REQUIRED corrompida");
    }
    // A leitura é deliberadamente não destrutiva. O caller precisa distinguir
    // esta prova de ACK remoto de REVOKE_REQUIRED antes de iniciar qualquer POST.
    return true;
  }
  const gate = nativeSessionGateStateFromSnapshot(snapshot);
  return (
    gate.state === "REVOKE_REQUIRED" ||
    gate.state === "LEGACY_REVOKE_REQUIRED" ||
    gate.state === "BLOCKED"
  );
}

/**
 * Projeção fechada do estado físico nativo. Em especial, um `session_token`
 * de versões antigas sem admission nunca é confundido com sessão autenticada:
 * ele só pode seguir pelo protocolo `LEGACY_REVOKE_REQUIRED`.
 */
function nativeSessionGateStateFromSnapshot(
  snapshot: NativeSessionSnapshot,
): NativeSessionGateState {
  const admitted = admittedBindingFromSnapshot(snapshot);
  if (admitted) {
    return { state: "ADMITTED", expectedUserId: admitted.expectedUserId };
  }
  const token = snapshot.token?.trim() ? snapshot.token : null;
  const pending = revocablePendingBindingFromSnapshot(snapshot);
  if (token && pending && tokenMatchesBinding(token, pending)) {
    return { state: "REVOKE_REQUIRED" };
  }
  if (
    token &&
    (isRawOnlyLegacySnapshot(snapshot) ||
      revocableLegacyTokenFromSnapshot(snapshot) === token)
  ) {
    return { state: "LEGACY_REVOKE_REQUIRED" };
  }
  if (
    isCleanUnauthenticatedSnapshot(snapshot) ||
    isStartableRevokedSnapshot(snapshot)
  ) {
    return { state: "CLEAR" };
  }
  return { state: "BLOCKED" };
}

export async function getNativeSessionGateState(): Promise<NativeSessionGateState> {
  if (Platform.OS === "web") return { state: "CLEAR" };
  const snapshot = await readNativeSessionSnapshot();
  if (
    isRevokedCleanupAdmissionNamespace(snapshot.admission) ||
    isRevokedCleanupClearTail(snapshot)
  ) {
    if (
      !isRevokedCleanupClearTail(snapshot) &&
      !revokedCleanupBindingFromAdmission(snapshot.admission)
    ) {
      return { state: "BLOCKED" };
    }
    // Preserva a proveniência do ACK para o coordenador encerrar UI/cache e
    // notificações antes de consumir a fase com removeSessionToken().
    return { state: "REVOKED_CLEANUP_REQUIRED" };
  }
  return nativeSessionGateStateFromSnapshot(snapshot);
}

/**
 * Único escape da quarentena: devolve o valor bruto exclusivamente para o
 * endpoint de revogação. Nunca deve ser usado como Bearer de leitura normal.
 */
export async function getQuarantinedSessionTokenForRevocation(): Promise<string> {
  const snapshot = await readNativeSessionSnapshot();
  if (isRevokedCleanupAdmissionNamespace(snapshot.admission)) {
    throw new Error(
      revokedCleanupBindingFromAdmission(snapshot.admission)
        ? "A revogação remota já foi confirmada; resta somente cleanup local"
        : "Admission REVOKED_CLEANUP_REQUIRED corrompida",
    );
  }
  const binding = revocablePendingBindingFromSnapshot(snapshot);
  const token = snapshot.token?.trim() ? snapshot.token : null;
  if (binding && token && tokenMatchesBinding(token, binding)) return token;
  const legacyToken = revocableLegacyTokenFromSnapshot(snapshot);
  if (!legacyToken) {
    // Marker sem binding canônico, raw ausente ou raw divergente são estados
    // não confirmáveis. O caller não pode fabricar logout confirmado sem POST.
    throw new Error("A quarentena do token não pôde ser confirmada");
  }
  return legacyToken;
}

/**
 * Converte um Bearer COMMITTED em PENDING antes de qualquer tentativa de
 * revogação remota. A invalidação da cache ocorre sincronicamente, e o POST
 * só pode começar depois do marker bindado ter sido relido exatamente.
 *
 * O caminho é idempotente para uma sessão que já esteja PENDING. Um token
 * explícito divergente nunca substitui o binding existente.
 */
export async function prepareSessionTokenRevocation(
  expectedToken?: string,
  expectedUserId?: number,
): Promise<PreparedSessionTokenRevocation> {
  if (expectedToken !== undefined && !expectedToken.trim()) {
    throw new Error("Token de sessão vazio");
  }
  if (
    expectedUserId !== undefined &&
    (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0)
  ) {
    throw new Error("Usuário esperado da sessão inválido");
  }
  const mutationVersion = beginSessionTokenMutation();
  sessionTokenCache = null;
  sessionTokenCacheInitialized = true;
  stagedSessionToken = null;

  const mutation = sessionTokenMutationTail.then(async () => {
    const snapshot = await readNativeSessionSnapshot();
    if (isRevokedCleanupAdmissionNamespace(snapshot.admission)) {
      throw new Error(
        revokedCleanupBindingFromAdmission(snapshot.admission)
          ? "A revogação remota já foi confirmada; resta somente cleanup local"
          : "Admission REVOKED_CLEANUP_REQUIRED corrompida",
      );
    }
    const token = snapshot.token?.trim() ? snapshot.token : null;
    const pendingBinding = revocablePendingBindingFromSnapshot(snapshot);
    if (pendingBinding) {
      if (token && tokenMatchesBinding(token, pendingBinding)) {
        if (expectedToken !== undefined && token !== expectedToken) {
          throw new Error(
            "O Bearer pendente não corresponde à revogação esperada",
          );
        }
        if (
          expectedUserId !== undefined &&
          expectedUserId !== pendingBinding.expectedUserId
        ) {
          throw new Error(
            "A identidade esperada divergiu do binding PENDING físico",
          );
        }
        // Se o release do marker tinha ocorrido antes de uma falha, reinstala
        // a segunda barreira sem sacrificar a admission PENDING já segura.
        if (snapshot.marker === null) {
          try {
            await persistPendingMarker(pendingBinding);
          } catch {
            // A prova positiva confirmada continua bloqueando/revogando B.
          }
        }
        return preparedPendingRevocation(token, pendingBinding);
      }
      if (
        expectedToken !== undefined &&
        tokenMatchesBinding(expectedToken, pendingBinding) &&
        (expectedUserId === undefined ||
          expectedUserId === pendingBinding.expectedUserId)
      ) {
        // Crash parcial: o binding de B chegou ao disco, mas o raw ainda é A
        // ou está ausente. Completa exatamente o MESMO B; C nunca pode tomar
        // o lugar de uma revogação PENDING.
        await persistRevocationBarrier(pendingBinding);
        await persistExactSecureValue(
          SESSION_TOKEN_KEY,
          expectedToken,
          "Bearer de revogação não foi confirmado",
        );
        return preparedPendingRevocation(expectedToken, pendingBinding);
      }
      throw new Error("A sessão PENDING não pode ser substituída");
    }

    const legacyToken =
      token &&
      (isRawOnlyLegacySnapshot(snapshot) ||
        revocableLegacyTokenFromSnapshot(snapshot) === token)
        ? token
        : null;
    if (
      legacyToken &&
      (expectedToken === undefined || expectedToken === legacyToken)
    ) {
      // Migração de instalações antigas que tinham apenas `session_token`.
      // A barreira de SHA precisa estar confirmada ANTES de `/me` ou logout;
      // assim crash, rede e ACK perdido sempre retomam revoke-only.
      const legacyBinding = await ensureLegacyRevocationBarrier(
        snapshot,
        legacyToken,
      );
      const revocationUserId =
        expectedUserId !== undefined
          ? expectedUserId
          : await resolveLegacyRevocationUserId(legacyToken);
      if (revocationUserId !== null) {
        const binding: SessionTokenBinding = {
          expectedUserId: revocationUserId,
          nonce: legacyBinding.nonce,
          fingerprint: legacyBinding.fingerprint,
        };
        await persistRevocationBarrier(binding);
        return preparedPendingRevocation(legacyToken, binding);
      }
      // 401 do `/me` canônico também é terminal para a autoridade do Bearer,
      // mas o caller ainda envia o logout idempotente com este raw explícito.
      // Nenhum caminho promove userId, cache, receipt ou transporte normal.
      return preparedLegacyRevocation(legacyToken, legacyBinding);
    }

    const admittedBinding = admittedBindingFromSnapshot(snapshot);
    if (
      admittedBinding &&
      token &&
      (expectedToken === undefined || token === expectedToken)
    ) {
      await persistRevocationBarrier(admittedBinding);
      return preparedPendingRevocation(token, admittedBinding);
    }

    if (expectedToken !== undefined && expectedUserId !== undefined) {
      // O servidor pode ter emitido B, mas a primeira tentativa de stage ter
      // falhado antes do marker (o slot ainda contém A ou está vazio). Instala
      // B diretamente como PENDING revogável; nunca o admite nem restaura A.
      const explicitBinding = createSessionTokenBinding(
        expectedToken,
        expectedUserId,
      );
      // Bloqueia A/estado anterior antes de substituir o raw pelo B explícito.
      await persistRevocationBarrier(explicitBinding);
      await persistExactSecureValue(
        SESSION_TOKEN_KEY,
        expectedToken,
        "Bearer de revogação não foi confirmado",
      );
      return preparedPendingRevocation(expectedToken, explicitBinding);
    }

    throw new Error("A sessão atual não possui Bearer revogável confirmado");
  });
  sessionTokenMutationTail = mutation.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await mutation;
  } catch (error) {
    if (sessionTokenCacheVersion === mutationVersion) {
      // Não presume se o marker foi ou não aplicado quando o ACK falha. Uma
      // leitura futura reconstrói autoridade apenas de uma snapshot saudável.
      sessionTokenCache = null;
      sessionTokenCacheInitialized = true;
    }
    throw error;
  }
}

/**
 * Converte exclusivamente uma sessão ADMITTED coerente em PENDING reversível.
 * A receipt opaca só existe no processo que iniciou o logout: PENDING de
 * rollback, mismatch, commit ambíguo ou cold restart continua revoke-only.
 */
export async function prepareReversibleSessionTokenRevocation(
  expectedUserId: number,
): Promise<ReversibleSessionRevocation> {
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) {
    throw new Error("Usuário esperado da sessão inválido");
  }
  const mutationVersion = beginSessionTokenMutation();
  sessionTokenCache = null;
  sessionTokenCacheInitialized = true;
  stagedSessionToken = null;
  reversibleSessionRevocation = null;

  const mutation = sessionTokenMutationTail.then(async () => {
    const snapshot = await readNativeSessionSnapshot();
    const binding = admittedBindingFromSnapshot(snapshot);
    const token = snapshot.token?.trim() ? snapshot.token : null;
    if (!binding || binding.expectedUserId !== expectedUserId || !token) {
      throw new Error("A sessão atual não admite logout reversível");
    }

    // Diferentemente da quarentena genérica, a restauração futura exige as
    // DUAS metades PENDING exatas. Falha parcial permanece segura, mas não
    // emite receipt capaz de promover o transporte novamente.
    await persistExactSecureValue(
      SESSION_TOKEN_ADMISSION_KEY,
      encodePendingBinding(binding),
      "Barreira positiva reversível não foi confirmada",
    );
    await persistPendingMarker(binding);
    return { token, binding };
  });
  sessionTokenMutationTail = mutation.then(
    () => undefined,
    () => undefined,
  );

  try {
    const { token, binding } = await mutation;
    if (sessionTokenCacheVersion !== mutationVersion) {
      throw new Error("Preparação reversível foi substituída");
    }
    const ticket = Object.freeze({}) as ReversibleSessionRevocation;
    reversibleSessionRevocation = {
      version: mutationVersion,
      token,
      binding,
      ticket,
    };
    return ticket;
  } catch (error) {
    if (sessionTokenCacheVersion === mutationVersion) {
      sessionTokenCache = null;
      sessionTokenCacheInitialized = true;
      reversibleSessionRevocation = null;
    }
    throw error;
  }
}

export function getReversibleSessionTokenForRevocation(
  ticket: ReversibleSessionRevocation,
): string {
  const prepared = reversibleSessionRevocation;
  if (
    !prepared ||
    prepared.ticket !== ticket ||
    prepared.version !== sessionTokenCacheVersion
  ) {
    throw new Error("Receipt reversível da sessão inválida");
  }
  return prepared.token;
}

export function discardReversibleSessionTokenRevocation(
  ticket: ReversibleSessionRevocation,
): void {
  if (reversibleSessionRevocation?.ticket === ticket) {
    reversibleSessionRevocation = null;
  }
}

/**
 * Promove novamente somente a receipt que este processo acabou de revalidar
 * por `/me`. Snapshot, token, usuário, nonce e SHA precisam continuar exatos.
 */
export async function restoreReversibleSessionTokenAdmission(
  ticket: ReversibleSessionRevocation,
): Promise<void> {
  const prepared = reversibleSessionRevocation;
  if (
    !prepared ||
    prepared.ticket !== ticket ||
    prepared.version !== sessionTokenCacheVersion
  ) {
    throw new Error("Receipt reversível da sessão inválida");
  }

  const mutation = sessionTokenMutationTail.then(async () => {
    if (
      reversibleSessionRevocation?.ticket !== ticket ||
      sessionTokenCacheVersion !== prepared.version
    ) {
      throw new Error("Receipt reversível da sessão foi substituída");
    }
    const snapshot = await readNativeSessionSnapshot();
    const markerBinding = pendingBindingFromMarker(snapshot.marker);
    const admissionBinding = pendingBindingFromAdmission(snapshot.admission);
    if (
      !markerBinding ||
      !admissionBinding ||
      !sameBinding(markerBinding, prepared.binding) ||
      !sameBinding(admissionBinding, prepared.binding) ||
      snapshot.token !== prepared.token ||
      !tokenMatchesBinding(prepared.token, prepared.binding)
    ) {
      throw new Error("A sessão reversível perdeu o binding PENDING");
    }

    // Reconfirma ambas as barreiras antes do release. Se qualquer write/readback
    // ficar ambíguo, B continua sem cache e o recovery retorna ao revoke-only.
    await persistExactSecureValue(
      SESSION_TOKEN_ADMISSION_KEY,
      encodePendingBinding(prepared.binding),
      "Barreira positiva reversível não foi reconfirmada",
    );
    await persistPendingMarker(prepared.binding);
    await releasePendingMarker(prepared.binding);
    await persistCommittedAdmission(prepared.binding);
  });
  sessionTokenMutationTail = mutation.then(
    () => undefined,
    () => undefined,
  );

  try {
    await mutation;
    if (
      sessionTokenCacheVersion !== prepared.version ||
      reversibleSessionRevocation?.ticket !== ticket
    ) {
      throw new Error("Restauração reversível foi substituída");
    }
    sessionTokenCache = prepared.token;
    sessionTokenCacheInitialized = true;
    reversibleSessionRevocation = null;
  } catch (error) {
    if (sessionTokenCacheVersion === prepared.version) {
      sessionTokenCache = null;
      sessionTokenCacheInitialized = false;
    }
    throw error;
  }
}

async function removeSessionTokenWithoutRemoteCleanupProof(): Promise<void> {
  const previousToken = await getSessionToken();
  const mutationVersion = beginSessionTokenMutation();
  sessionTokenCache = null;
  sessionTokenCacheInitialized = true;
  stagedSessionToken = null;

  const mutation = sessionTokenMutationTail.then(async () => {
    const failures: unknown[] = [];
    let durableRevocation = false;

    try {
      await persistBlockedMarker();
      durableRevocation = true;
    } catch (error) {
      failures.push(error);
    }

    try {
      await secureRemove(SESSION_TOKEN_KEY);
      const persisted = await secureGet(SESSION_TOKEN_KEY);
      if (persisted?.trim()) {
        throw new Error("Remoção do token de sessão não foi confirmada");
      }
      durableRevocation = true;
    } catch (removeError) {
      failures.push(removeError);
      try {
        await persistExactSecureValue(
          SESSION_TOKEN_KEY,
          "",
          "Tombstone do token de sessão não foi confirmado",
        );
        durableRevocation = true;
      } catch (overwriteError) {
        failures.push(overwriteError);
      }
    }

    if (!durableRevocation) {
      throw new AggregateError(
        failures,
        "Não foi possível remover o token de sessão do dispositivo",
      );
    }

    // A admission é o único binding revogável de um raw que não pôde ser
    // removido. Só pode ser apagada depois de uma barreira independente
    // confirmada (marker bloqueado ou raw ausente/tombstonado).
    try {
      await secureRemove(SESSION_TOKEN_ADMISSION_KEY);
      const persisted = await secureGet(SESSION_TOKEN_ADMISSION_KEY);
      if (persisted?.trim()) {
        throw new Error("Remoção da admission da sessão não foi confirmada");
      }
    } catch (removeError) {
      failures.push(removeError);
      try {
        await persistExactSecureValue(
          SESSION_TOKEN_ADMISSION_KEY,
          "",
          "Tombstone da admission da sessão não foi confirmado",
        );
      } catch (overwriteError) {
        failures.push(overwriteError);
      }
    }
  });
  sessionTokenMutationTail = mutation.catch(() => undefined);
  try {
    await mutation;
  } catch (error) {
    if (sessionTokenCacheVersion === mutationVersion) {
      // Um ACK perdido do marker pode significar que `blocked:v3` já está
      // durável. Invalida a memória antes de sondar; A só volta se a snapshot
      // saudável ainda provar marker AUSENTE + COMMITTED bindado exatamente.
      sessionTokenCache = null;
      sessionTokenCacheInitialized = false;
      try {
        const snapshot = await readNativeSessionSnapshot();
        const admittedToken = admittedTokenFromSnapshot(snapshot);
        if (sessionTokenCacheVersion === mutationVersion) {
          sessionTokenCache =
            admittedToken === previousToken ? admittedToken : null;
          sessionTokenCacheInitialized = true;
        }
      } catch {
        // Storage ainda indisponível: nenhuma prova negativa é cacheada e uma
        // leitura futura pode recuperar, mas A não reaparece por memória.
        if (sessionTokenCacheVersion === mutationVersion) {
          sessionTokenCache = null;
          sessionTokenCacheInitialized = false;
        }
      }
    }
    throw error;
  }
}

async function neutralizeRevokedRaw(
  binding: RevokedCleanupBinding,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await secureRemove(SESSION_TOKEN_KEY);
  } catch (error) {
    failures.push(error);
  }

  let persisted: string | null;
  try {
    persisted = await secureGet(SESSION_TOKEN_KEY);
  } catch (error) {
    throw new AggregateError(
      [...failures, error],
      "Readback do raw revogado falhou",
    );
  }
  if (persisted === null || persisted === "") return;
  if (!tokenMatchesBinding(persisted, binding)) {
    throw new AggregateError(
      failures,
      "O raw mudou depois da confirmação remota",
    );
  }

  try {
    await secureSet(SESSION_TOKEN_KEY, "");
  } catch (error) {
    failures.push(error);
  }
  try {
    persisted = await secureGet(SESSION_TOKEN_KEY);
  } catch (error) {
    throw new AggregateError(
      [...failures, error],
      "Readback do tombstone do raw revogado falhou",
    );
  }
  if (persisted === null || persisted === "") return;
  if (!tokenMatchesBinding(persisted, binding)) {
    throw new AggregateError(
      failures,
      "O raw mudou durante o cleanup revogado",
    );
  }
  throw new AggregateError(
    failures,
    "Raw revogado não pôde ser removido nem tombstonado",
  );
}

async function neutralizeRevokedAdmission(
  binding: RevokedCleanupBinding,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await secureRemove(SESSION_TOKEN_ADMISSION_KEY);
  } catch (error) {
    failures.push(error);
  }

  let persisted: string | null;
  try {
    persisted = await secureGet(SESSION_TOKEN_ADMISSION_KEY);
  } catch (error) {
    throw new AggregateError(
      [...failures, error],
      "Readback da admission revogada falhou",
    );
  }
  if (persisted === null || persisted === "") return;
  if (!admissionMatchesCleanupBinding(persisted, binding)) {
    throw new AggregateError(
      failures,
      "A admission mudou durante o cleanup revogado",
    );
  }

  try {
    await secureSet(SESSION_TOKEN_ADMISSION_KEY, "");
  } catch (error) {
    failures.push(error);
  }
  try {
    persisted = await secureGet(SESSION_TOKEN_ADMISSION_KEY);
  } catch (error) {
    throw new AggregateError(
      [...failures, error],
      "Readback do tombstone da admission revogada falhou",
    );
  }
  if (persisted === null || persisted === "") return;
  if (!admissionMatchesCleanupBinding(persisted, binding)) {
    throw new AggregateError(
      failures,
      "A admission mudou durante o tombstone revogado",
    );
  }
  throw new AggregateError(
    failures,
    "Admission revogada não pôde ser removida nem tombstonada",
  );
}

async function clearRevokedCleanupMarker(): Promise<void> {
  const expected = SESSION_TOKEN_BLOCKED_MARKER;
  let removeError: unknown;
  try {
    await AsyncStorage.removeItem(SESSION_TOKEN_REVOKED_KEY);
  } catch (error) {
    removeError = error;
  }
  let persisted: string | null = null;
  let readError: unknown;
  let readSucceeded = false;
  try {
    persisted = await AsyncStorage.getItem(SESSION_TOKEN_REVOKED_KEY);
    readSucceeded = true;
  } catch (error) {
    readError = error;
  }
  if (readSucceeded && persisted === null) return;
  if (persisted !== expected) {
    throw new AggregateError(
      [removeError, readError].filter((error) => error !== undefined),
      "Marker mudou durante o cleanup revogado",
    );
  }
  throw new AggregateError(
    [removeError, readError].filter((error) => error !== undefined),
    "Marker bloqueado do cleanup revogado não pôde ser removido",
  );
}

async function completeRevokedSessionCleanup(): Promise<void> {
  let snapshot = await readNativeSessionSnapshot();
  if (isRevokedCleanupClearTail(snapshot)) {
    await clearRevokedCleanupMarker();
    return;
  }
  if (!isRevokedCleanupAdmissionNamespace(snapshot.admission)) {
    throw new Error("Cleanup local não possui confirmação remota durável");
  }
  const binding = revokedCleanupBindingFromAdmission(snapshot.admission);
  if (!binding) {
    throw new Error("Admission REVOKED_CLEANUP_REQUIRED corrompida");
  }
  if (snapshot.marker !== SESSION_TOKEN_BLOCKED_MARKER) {
    if (!markerCanPrecedeRevokedCleanup(snapshot.marker, binding)) {
      throw new Error("Marker divergiu da admission REVOKED_CLEANUP_REQUIRED");
    }
    // Crash entre as duas writes da fase: repara somente a barreira local. A
    // admission bindada já prova que a revogação remota foi confirmada.
    await persistRevokedCleanupBlockedMarker();
    snapshot = await readNativeSessionSnapshot();
    const persistedBinding = revokedCleanupBindingFromAdmission(
      snapshot.admission,
    );
    if (
      snapshot.marker !== SESSION_TOKEN_BLOCKED_MARKER ||
      !persistedBinding ||
      !sameRevokedCleanupBinding(persistedBinding, binding)
    ) {
      throw new Error("Fase REVOKED_CLEANUP_REQUIRED mudou durante o reparo");
    }
  }
  if (snapshot.token?.trim() && !tokenMatchesBinding(snapshot.token, binding)) {
    throw new Error("Raw divergiu da admission REVOKED_CLEANUP_REQUIRED");
  }
  if (!admissionMatchesCleanupBinding(snapshot.admission, binding)) {
    throw new Error("Admission REVOKED_CLEANUP_REQUIRED perdeu o binding");
  }

  // Esta ordem é load-bearing: nonce+fingerprint (e userId quando provado)
  // sobrevivem enquanto o raw ainda existe. Admission só é neutralizada após o
  // readback conclusivo do raw; marker some por último, com ambas inertes.
  await neutralizeRevokedRaw(binding);
  await neutralizeRevokedAdmission(binding);
  await clearRevokedCleanupMarker();
}

async function persistRevokedCleanupWithReadback(
  binding: RevokedCleanupBinding,
  token: string,
): Promise<void> {
  await persistRevokedCleanupPhase(binding);
  const persisted = await readNativeSessionSnapshot();
  const persistedBinding = revokedCleanupBindingFromAdmission(
    persisted.admission,
  );
  if (
    persisted.marker !== SESSION_TOKEN_BLOCKED_MARKER ||
    !persistedBinding ||
    !sameRevokedCleanupBinding(persistedBinding, binding) ||
    (persisted.token?.trim() && persisted.token !== token)
  ) {
    throw new Error(
      "REVOKED_CLEANUP_REQUIRED perdeu o binding após o readback",
    );
  }
}

/**
 * Única autoridade para revogar um Bearer nativo preparado: revalida o binding
 * físico, envia o próprio POST `/logout`, valida o 2xx tipado e só então grava
 * REVOKED_CLEANUP_REQUIRED. Status/ID remotos nunca entram como argumentos
 * públicos, portanto um sibling não consegue fabricar `ALREADY_INVALID`.
 */
export async function revokePreparedSessionToken(
  prepared: PreparedSessionTokenRevocation,
): Promise<void> {
  if (Platform.OS === "web") {
    throw new Error("Revogação explícita do Bearer indisponível no web");
  }

  const mutationVersion = beginSessionTokenMutation();
  sessionTokenCache = null;
  sessionTokenCacheInitialized = true;
  stagedSessionToken = null;
  reversibleSessionRevocation = null;
  const mutation = sessionTokenMutationTail.then(async () => {
    let snapshot = await readNativeSessionSnapshot();
    if (preparedRevocationCleanupAlreadyDurable(snapshot, prepared)) return;

    // Rejeita clone/fase/nonce/SHA divergentes antes de emitir qualquer byte.
    bindingForPreparedRevocation(snapshot, prepared, "ALREADY_INVALID", null);
    const proof = await requestPreparedSessionTokenRevocation(prepared.token);
    try {
      snapshot = await readNativeSessionSnapshot();
      const binding = bindingForPreparedRevocation(
        snapshot,
        prepared,
        proof.status,
        proof.revocationUserId ?? null,
      );
      await persistRevokedCleanupWithReadback(binding, prepared.token);
    } catch (error) {
      // A partir daqui o 2xx tipado já foi validado. Preserva essa fronteira
      // para que o caller encerre a UI e trate somente a higiene local restante.
      throw new ConfirmedSessionRevocationLocalCleanupError(error);
    }
  });
  sessionTokenMutationTail = mutation.catch(() => undefined);
  try {
    await mutation;
  } catch (error) {
    if (sessionTokenCacheVersion === mutationVersion) {
      sessionTokenCache = null;
      sessionTokenCacheInitialized = true;
    }
    throw error;
  }
}

/** Finalizador privado: somente o request DELETE tipado abaixo pode alcançá-lo. */
async function persistReversibleDeleteCleanup(
  ticket: ReversibleSessionRevocation,
): Promise<void> {
  if (Platform.OS === "web") {
    throw new Error("Cleanup revogado nativo indisponível no web");
  }
  const current = reversibleSessionRevocation;
  if (
    !current ||
    current.ticket !== ticket ||
    current.version !== sessionTokenCacheVersion
  ) {
    throw new Error("Receipt reversível do DELETE inválida");
  }

  const mutationVersion = beginSessionTokenMutation();
  const prepared = { ...current, version: mutationVersion };
  reversibleSessionRevocation = prepared;
  sessionTokenCache = null;
  sessionTokenCacheInitialized = true;
  stagedSessionToken = null;
  const mutation = sessionTokenMutationTail.then(async () => {
    if (
      reversibleSessionRevocation !== prepared ||
      prepared.ticket !== ticket ||
      sessionTokenCacheVersion !== mutationVersion
    ) {
      throw new Error("Receipt reversível do DELETE foi substituída");
    }
    const snapshot = await readNativeSessionSnapshot();
    const binding = bindingForReversibleDeleteCleanup(
      snapshot,
      prepared.token,
      prepared.binding,
    );
    await persistRevokedCleanupWithReadback(binding, prepared.token);
  });
  sessionTokenMutationTail = mutation.catch(() => undefined);
  try {
    await mutation;
    if (reversibleSessionRevocation === prepared) {
      reversibleSessionRevocation = null;
    }
  } catch (error) {
    if (sessionTokenCacheVersion === mutationVersion) {
      sessionTokenCache = null;
      sessionTokenCacheInitialized = true;
    }
    throw error;
  }
}

/**
 * Autoridade única do DELETE nativo: consome a credencial purpose-bound,
 * executa o próprio request com o Bearer reversível, exige `2xx + ok:true` e
 * só então persiste REVOKED_CLEANUP_REQUIRED. Nenhum caller fornece status,
 * proof ou confirmação pós-fato.
 */
export async function deleteAccountWithReversibleSessionCleanup(
  password: string,
  credential: SessionTransitionCredential,
  ticket: ReversibleSessionRevocation,
): Promise<NativeAccountDeletionResult> {
  if (Platform.OS === "web") {
    throw new Error("DELETE nativo explícito indisponível no web");
  }
  const current = reversibleSessionRevocation;
  if (
    !current ||
    current.ticket !== ticket ||
    current.version !== sessionTokenCacheVersion
  ) {
    throw new Error("Receipt reversível do DELETE inválida");
  }

  const result = await requestPreparedNativeAccountDeletion(
    password,
    credential,
  );
  if (!result.ok) return result;
  try {
    await persistReversibleDeleteCleanup(ticket);
  } catch (error) {
    // O DELETE 2xx já é irreversível. Preserva resultado e causa em um tipo que
    // impede o caller de convertê-lo em falha pré-dispatch/status 0.
    throw new ConfirmedNativeAccountDeletionLocalCleanupError(result, error);
  }
  return result;
}

/**
 * Remove somente estado local cuja revogação remota já foi persistida. Boot e
 * login podem repetir esta função: ela nunca chama `/me`, logout ou admissão.
 */
export async function removeSessionToken(): Promise<void> {
  if (Platform.OS === "web") {
    return removeSessionTokenWithoutRemoteCleanupProof();
  }

  const mutationVersion = beginSessionTokenMutation();
  sessionTokenCache = null;
  sessionTokenCacheInitialized = true;
  stagedSessionToken = null;
  reversibleSessionRevocation = null;
  const mutation = sessionTokenMutationTail.then(async () => {
    const snapshot = await readNativeSessionSnapshot();
    if (isCleanUnauthenticatedSnapshot(snapshot)) return;
    await completeRevokedSessionCleanup();
  });
  sessionTokenMutationTail = mutation.catch(() => undefined);
  try {
    await mutation;
  } catch (error) {
    if (sessionTokenCacheVersion === mutationVersion) {
      sessionTokenCache = null;
      sessionTokenCacheInitialized = true;
    }
    throw error;
  }
}

async function resumeRevokedSessionCleanupIfRequired(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const snapshot = await readNativeSessionSnapshot();
  if (
    !isRevokedCleanupAdmissionNamespace(snapshot.admission) &&
    !isRevokedCleanupClearTail(snapshot)
  ) {
    return false;
  }
  if (
    !isRevokedCleanupClearTail(snapshot) &&
    !revokedCleanupBindingFromAdmission(snapshot.admission)
  ) {
    throw new Error("Admission REVOKED_CLEANUP_REQUIRED corrompida");
  }
  await removeSessionToken();
  return true;
}

// --- Quarentena do cookie web ---

export type WebSessionGateState =
  | Readonly<{ state: "CLEAR" }>
  | Readonly<{
      state: "REVOKE_REQUIRED";
      expectedUserId?: number;
      sessionInstance?: string;
    }>
  | Readonly<{ state: "ADMISSION"; expectedUserId: number }>;

export type WebSessionRevocationBootstrapResult =
  | Readonly<{ state: "LEGACY" }>
  | Readonly<{
      state: "BOUND";
      expectedUserId: number;
      sessionInstance: string;
    }>
  | Readonly<{ state: "INVALID" }>
  | Readonly<{ state: "MISMATCH" }>;

function createWebSessionGateNonce(): string {
  const uuid = globalThis.crypto
    ?.randomUUID?.()
    .replaceAll("-", "")
    .toLowerCase();
  if (uuid && /^[0-9a-f]{32}$/.test(uuid)) return uuid;
  const source = globalThis.crypto;
  if (!source?.getRandomValues) {
    throw new Error("Gerador seguro indisponível para a sessão web");
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function webLocalStorage(): Storage | null {
  return Platform.OS === "web" && typeof window !== "undefined"
    ? window.localStorage
    : null;
}

function parseWebSessionWorkflowRevision(value: string): string | null {
  return /^workflow:v1:[0-9a-f]{32}$/.test(value) ? value : null;
}

function readWebSessionWorkflowRevision(): string | null {
  const storage = webLocalStorage();
  if (!storage) throw new Error("Storage cross-tab da sessão web indisponível");
  const raw = storage.getItem(WEB_SESSION_WORKFLOW_REVISION_KEY);
  if (raw === null) return null;
  const revision = parseWebSessionWorkflowRevision(raw);
  if (!revision) throw new Error("Revisão da sessão web inválida");
  return revision;
}

function ensureWebSessionWorkflowRevision(): string {
  const current = readWebSessionWorkflowRevision();
  if (current) return current;
  const storage = webLocalStorage();
  if (!storage) throw new Error("Storage cross-tab da sessão web indisponível");
  const revision = `${WEB_SESSION_WORKFLOW_REVISION_PREFIX}:${createWebSessionGateNonce()}`;
  storage.setItem(WEB_SESSION_WORKFLOW_REVISION_KEY, revision);
  if (storage.getItem(WEB_SESSION_WORKFLOW_REVISION_KEY) !== revision) {
    throw new Error("Revisão da sessão web não foi confirmada");
  }
  return revision;
}

async function withWebSessionGateLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (Platform.OS !== "web") {
    return operation();
  }
  if (!webLocalStorage()) {
    throw new Error("Storage cross-tab da sessão web indisponível");
  }
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) {
    throw new Error("Bloqueio cross-tab da sessão web indisponível");
  }
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (workflowSignal) {
    return locks.request(
      "escalas-web-session-gate-v1",
      { mode: "exclusive", signal: workflowSignal },
      operation,
    );
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new Error("Lock do gate web excedeu o prazo seguro"));
  }, WEB_SESSION_MUTATION_DEADLINE_MS);
  try {
    return await locks.request(
      "escalas-web-session-gate-v1",
      { mode: "exclusive", signal: controller.signal },
      operation,
    );
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Serializa a mutação remota completa entre abas. O lock pontual do gate evita
 * apenas um write/remove concorrente; este lock maior cobre também o intervalo
 * entre marker, Set-Cookie, `/me` canônico e liberação do marker.
 */
export async function runExclusiveWebSessionMutation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (Platform.OS !== "web") {
    return operation(new AbortController().signal);
  }
  if (!webLocalStorage()) {
    throw new Error("Storage cross-tab da sessão web indisponível");
  }
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) {
    throw new Error("Bloqueio cross-tab da sessão web indisponível");
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new WebSessionMutationCancelledError());
  }, WEB_SESSION_MUTATION_DEADLINE_MS);
  try {
    return await locks.request(
      "escalas-web-session-mutation-v1",
      { mode: "exclusive", signal: controller.signal },
      async () => {
        const leaveWorkflow = enterWebSessionWorkflow(controller.signal);
        try {
          // Requests do workflow recebem este signal no wrapper HTTP. O lock só
          // é liberado depois que o abort assentou a promise do fetch/caller;
          // callbacks locais também consultam o mesmo signal antes de efeitos.
          return await operation(controller.signal);
        } finally {
          leaveWorkflow();
        }
      },
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new WebSessionMutationCancelledError();
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function transitionExactWebSessionGate(
  expected: string | null,
  next: string,
  errorMessage: string,
): Promise<void> {
  await withWebSessionGateLock(async () => {
    const storage = webLocalStorage();
    if (storage) {
      if (storage.getItem(WEB_SESSION_QUARANTINE_KEY) !== expected) {
        throw new Error("A sessão web mudou em outra aba");
      }
      storage.setItem(WEB_SESSION_QUARANTINE_KEY, next);
      if (storage.getItem(WEB_SESSION_QUARANTINE_KEY) !== next) {
        throw new Error(errorMessage);
      }
      return;
    }
    const current = await AsyncStorage.getItem(WEB_SESSION_QUARANTINE_KEY);
    if (current !== expected)
      throw new Error("A sessão web mudou em outra aba");
    await AsyncStorage.setItem(WEB_SESSION_QUARANTINE_KEY, next);
    if ((await AsyncStorage.getItem(WEB_SESSION_QUARANTINE_KEY)) !== next) {
      throw new Error(errorMessage);
    }
  });
}

async function clearExactWebSessionGate(
  expected: string | null,
  authorizeRemoval?: () => void,
): Promise<void> {
  await withWebSessionGateLock(async () => {
    const storage = webLocalStorage();
    if (storage) {
      const current = storage.getItem(WEB_SESSION_QUARANTINE_KEY);
      if (current === null) {
        if (authorizeRemoval) {
          throw new Error("A sessão web mudou em outra aba");
        }
        return;
      }
      if (expected === null || current !== expected) {
        throw new Error("A sessão web mudou em outra aba");
      }
      authorizeRemoval?.();
      storage.removeItem(WEB_SESSION_QUARANTINE_KEY);
      if (storage.getItem(WEB_SESSION_QUARANTINE_KEY) !== null) {
        throw new Error("Liberação da sessão web não foi confirmada");
      }
      return;
    }
    const current = await AsyncStorage.getItem(WEB_SESSION_QUARANTINE_KEY);
    if (current === null) {
      if (authorizeRemoval) {
        throw new Error("A sessão web mudou em outra aba");
      }
      return;
    }
    if (expected === null || current !== expected) {
      throw new Error("A sessão web mudou em outra aba");
    }
    authorizeRemoval?.();
    await AsyncStorage.removeItem(WEB_SESSION_QUARANTINE_KEY);
    if ((await AsyncStorage.getItem(WEB_SESSION_QUARANTINE_KEY)) !== null) {
      throw new Error("Liberação da sessão web não foi confirmada");
    }
  });
}

function parseWebAdmissionExpectedUserId(value: string): number | null {
  const match =
    /^pending-admission:v3:([1-9][0-9]*):[0-9a-f]{32}$/.exec(value) ??
    /^pending-admission:v2:([1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const expectedUserId = Number(match[1]);
  if (
    !Number.isSafeInteger(expectedUserId) ||
    expectedUserId <= 0 ||
    String(expectedUserId) !== match[1]
  ) {
    return null;
  }
  return expectedUserId;
}

type ParsedWebRevocation = Readonly<{
  expectedUserId: number;
  sessionInstance?: string;
}>;

function parseWebRevocation(value: string): ParsedWebRevocation | null {
  const exactMatch =
    /^pending-revocation:v4:([1-9][0-9]*):[0-9a-f]{32}:(v1\.[A-Za-z0-9_-]{43})$/.exec(
      value,
    );
  const match =
    exactMatch ??
    /^pending-revocation:v3:([1-9][0-9]*):[0-9a-f]{32}$/.exec(value);
  if (!match) return null;
  const expectedUserId = Number(match[1]);
  if (
    !Number.isSafeInteger(expectedUserId) ||
    expectedUserId <= 0 ||
    String(expectedUserId) !== match[1]
  ) {
    return null;
  }
  return {
    expectedUserId,
    ...(exactMatch ? { sessionInstance: exactMatch[2] } : {}),
  };
}

function isUnboundWebRevocation(value: string): boolean {
  return /^pending-revocation:v2:[0-9a-f]{32}$/.test(value);
}

function createWebRevocationMarker(
  expectedUserId?: number,
  sessionInstance?: string,
): string {
  if (expectedUserId === undefined) {
    return `${WEB_SESSION_QUARANTINE_PREFIX}:${createWebSessionGateNonce()}`;
  }
  return sessionInstance
    ? `${WEB_SESSION_EXACT_QUARANTINE_PREFIX}:${expectedUserId}:${createWebSessionGateNonce()}:${sessionInstance}`
    : `${WEB_SESSION_BOUND_QUARANTINE_PREFIX}:${expectedUserId}:${createWebSessionGateNonce()}`;
}

function webRevocationRecoveryExpectedUserId(marker: string): number | null {
  const revocation = parseWebRevocation(marker);
  if (revocation) return revocation.expectedUserId;
  return parseWebAdmissionExpectedUserId(marker);
}

function isRecoverableWebRevocationMarker(marker: string): boolean {
  return (
    parseWebRevocation(marker) !== null ||
    parseWebAdmissionExpectedUserId(marker) !== null ||
    /^login-in-progress:v3:[0-9a-f]{32}$/.test(marker) ||
    isUnboundWebRevocation(marker)
  );
}

/**
 * Recupera somente a prova necessária para REVOGAR um cookie após crash entre
 * Set-Cookie e ADMISSION. A resposta de `/me` nunca vira receipt de admissão:
 * ela apenas converte, por CAS do marker físico exato, a barreira existente em
 * v4(userId, sessionInstance). Sessão legacy também pode fornecer a proof para
 * logout; isso não autoriza sua promoção num cliente exact ativo.
 */
export async function bootstrapExactWebSessionRevocation(
  explicitExpectedUserId?: number,
): Promise<WebSessionRevocationBootstrapResult> {
  if (Platform.OS !== "web") return { state: "LEGACY" };
  if (!exactSessionBindingClientActive()) return { state: "LEGACY" };
  if (
    explicitExpectedUserId !== undefined &&
    (!Number.isSafeInteger(explicitExpectedUserId) ||
      explicitExpectedUserId <= 0)
  ) {
    throw new Error("Usuário esperado da revogação web inválido");
  }
  if (!getActiveWebSessionWorkflowSignal()) {
    throw new Error("Recovery exact-v1 fora do workflow web exclusivo");
  }

  await webSessionQuarantineTail;
  const storage = webLocalStorage();
  if (!storage) {
    throw new Error("Storage cross-tab da sessão web indisponível");
  }

  let marker = storage.getItem(WEB_SESSION_QUARANTINE_KEY);
  if (marker === null) {
    marker =
      explicitExpectedUserId === undefined
        ? `${WEB_SESSION_QUARANTINE_PREFIX}:${createWebSessionGateNonce()}`
        : `${WEB_SESSION_BOUND_QUARANTINE_PREFIX}:${explicitExpectedUserId}:${createWebSessionGateNonce()}`;
    await transitionExactWebSessionGate(
      null,
      marker,
      "Barreira do bootstrap exact-v1 não foi confirmada",
    );
    ownedWebSessionGate = marker;
    observedWebSessionGate = marker;
  }
  if (!isRecoverableWebRevocationMarker(marker)) {
    throw new Error(
      "Marker web desconhecido não autoriza bootstrap de revogação",
    );
  }

  const parsed = parseWebRevocation(marker);
  if (parsed?.sessionInstance) {
    if (
      explicitExpectedUserId !== undefined &&
      explicitExpectedUserId !== parsed.expectedUserId
    ) {
      throw new Error("Identidade da revogação web divergiu do marker durável");
    }
    return {
      state: "BOUND",
      expectedUserId: parsed.expectedUserId,
      sessionInstance: parsed.sessionInstance,
    };
  }

  const markerExpectedUserId = webRevocationRecoveryExpectedUserId(marker);
  if (
    explicitExpectedUserId !== undefined &&
    markerExpectedUserId !== null &&
    explicitExpectedUserId !== markerExpectedUserId
  ) {
    throw new Error("Identidade da revogação web divergiu do marker durável");
  }
  const expectedUserId = explicitExpectedUserId ?? markerExpectedUserId;
  const response = await requestCanonicalSession<{
    user?: User;
    sessionInstance?: unknown;
    sessionBinding?: SessionBindingState;
    code?: unknown;
  }>({
    ...(expectedUserId === null || expectedUserId === undefined
      ? {}
      : { expectedUserId }),
  });

  if (
    response.status === 409 &&
    response.data?.code === "EXPECTED_USER_MISMATCH" &&
    expectedUserId !== null &&
    expectedUserId !== undefined
  ) {
    // /me não é prova de revogação. O caller ainda precisa executar o logout
    // expected-bound; só essa resposta remota pode abandonar o marker por CAS.
    return { state: "MISMATCH" };
  }
  if (
    (response.status === 401 || response.status === 403) &&
    response.credentialPresented
  ) {
    return { state: "INVALID" };
  }
  const user = response.ok ? response.data?.user : null;
  const sessionInstance = response.data?.sessionInstance;
  if (
    !user ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    typeof sessionInstance !== "string" ||
    !SESSION_INSTANCE_PATTERN.test(sessionInstance) ||
    (expectedUserId !== null &&
      expectedUserId !== undefined &&
      user.id !== expectedUserId)
  ) {
    throw new Error("/me não confirmou a instância revogável da sessão web");
  }

  const exactMarker = `${WEB_SESSION_EXACT_QUARANTINE_PREFIX}:${user.id}:${createWebSessionGateNonce()}:${sessionInstance}`;
  await transitionExactWebSessionGate(
    marker,
    exactMarker,
    "Binding exact-v1 da revogação web não foi confirmado",
  );
  ownedWebSessionGate = exactMarker;
  observedWebSessionGate = exactMarker;
  return {
    state: "BOUND",
    expectedUserId: user.id,
    sessionInstance,
  };
}

/**
 * DELETE é terminal/ambíguo: instala REVOKE_REQUIRED, mas emite uma receipt
 * apenas para este processo restaurar A após um 4xx conclusivamente precommit.
 * Cold restart perde a receipt e permanece revoke-only.
 */
export async function prepareReversibleWebSessionRevocation(
  expectedUserId: number,
  sessionInstance?: string,
): Promise<ReversibleWebSessionRevocation> {
  if (Platform.OS !== "web") {
    throw new Error("Revogação web reversível indisponível no nativo");
  }
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) {
    throw new Error("Usuário esperado da revogação web inválido");
  }
  if (
    sessionInstance !== undefined &&
    !SESSION_INSTANCE_PATTERN.test(sessionInstance)
  ) {
    throw new Error("Instância esperada da revogação web inválida");
  }
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (!workflowSignal || workflowSignal.aborted) {
    throw new Error("DELETE web fora do workflow exclusivo");
  }
  closeSessionTokenTransportAdmission();
  reversibleWebSessionRevocation = null;
  const marker = sessionInstance
    ? `${WEB_SESSION_EXACT_QUARANTINE_PREFIX}:${expectedUserId}:${createWebSessionGateNonce()}:${sessionInstance}`
    : `${WEB_SESSION_BOUND_QUARANTINE_PREFIX}:${expectedUserId}:${createWebSessionGateNonce()}`;
  const mutation = webSessionQuarantineTail.then(async () => {
    await transitionExactWebSessionGate(
      null,
      marker,
      "Barreira reversível do DELETE web não foi confirmada",
    );
    ownedWebSessionGate = marker;
    observedWebSessionGate = marker;
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
  const ticket = Object.freeze({}) as ReversibleWebSessionRevocation;
  reversibleWebSessionRevocation = {
    expectedUserId,
    marker,
    ticket,
    workflowSignal,
    requestDispatched: false,
  };
  return ticket;
}

/** Consumida pelo cliente HTTP imediatamente antes do DELETE remoto. */
export function consumeReversibleWebSessionRevocationForRequest(
  ticket: ReversibleWebSessionRevocation,
): void {
  const prepared = reversibleWebSessionRevocation;
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (
    !prepared ||
    prepared.ticket !== ticket ||
    prepared.requestDispatched ||
    !workflowSignal ||
    workflowSignal !== prepared.workflowSignal ||
    workflowSignal.aborted
  ) {
    throw new Error("Receipt reversível do DELETE web inválida");
  }
  const storage = webLocalStorage();
  if (
    !storage ||
    storage.getItem(WEB_SESSION_QUARANTINE_KEY) !== prepared.marker
  ) {
    throw new Error("Marker do DELETE web mudou antes do request");
  }
  reversibleWebSessionRevocation = {
    ...prepared,
    requestDispatched: true,
  };
}

/**
 * Cancela somente a preparação local cujo request ainda não foi despachado.
 * Depois do consumo, erro/rejeição mantém REVOKE_REQUIRED e exige o logout
 * tipado; não existe API pública que aceite um status remoto fornecido pelo
 * caller para restaurar ou liberar o marker.
 */
export async function cancelReversibleWebSessionRevocation(
  ticket: ReversibleWebSessionRevocation,
): Promise<void> {
  const prepared = reversibleWebSessionRevocation;
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (
    !prepared ||
    prepared.ticket !== ticket ||
    prepared.requestDispatched ||
    !workflowSignal ||
    workflowSignal !== prepared.workflowSignal ||
    workflowSignal.aborted
  ) {
    throw new Error("Receipt reversível do DELETE web inválida");
  }
  const mutation = webSessionQuarantineTail.then(async () => {
    if (reversibleWebSessionRevocation !== prepared) {
      throw new Error("Receipt reversível do DELETE web foi substituída");
    }
    await clearExactWebSessionGate(prepared.marker);
    if (ownedWebSessionGate === prepared.marker) ownedWebSessionGate = null;
    if (observedWebSessionGate === prepared.marker)
      observedWebSessionGate = null;
    reversibleWebSessionRevocation = null;
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
}

export function discardReversibleWebSessionRevocation(
  ticket: ReversibleWebSessionRevocation,
): void {
  if (reversibleWebSessionRevocation?.ticket === ticket) {
    reversibleWebSessionRevocation = null;
  }
}

/**
 * Barreira durável que antecede o POST /login. A capability só permite
 * cancelar o marker enquanto o request ainda não foi despachado no mesmo
 * workflow; depois do consumo, somente logout remoto tipado pode liberá-lo.
 */
export async function beginWebLoginInProgress(): Promise<WebLoginInProgress> {
  if (Platform.OS !== "web") {
    throw new Error("Capability de login web indisponível no nativo");
  }
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (!workflowSignal || workflowSignal.aborted) {
    throw new Error("Login web fora do workflow exclusivo");
  }
  closeSessionTokenTransportAdmission();
  webLoginInProgress = null;
  const next = `${WEB_LOGIN_IN_PROGRESS_PREFIX}:${createWebSessionGateNonce()}`;
  const mutation = webSessionQuarantineTail.then(async () => {
    await transitionExactWebSessionGate(
      null,
      next,
      "Início do login web não foi confirmado",
    );
    ownedWebSessionGate = next;
    observedWebSessionGate = next;
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
  const ticket = Object.freeze({}) as WebLoginInProgress;
  webLoginInProgress = { marker: next, ticket, workflowSignal };
  return ticket;
}

/** Consumida pelo cliente HTTP imediatamente antes de enfileirar o fetch. */
export function consumeWebLoginInProgressForRequest(
  ticket: WebLoginInProgress,
): void {
  const prepared = webLoginInProgress;
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (
    Platform.OS !== "web" ||
    !prepared ||
    prepared.ticket !== ticket ||
    !workflowSignal ||
    workflowSignal !== prepared.workflowSignal ||
    workflowSignal.aborted
  ) {
    throw new Error("Capability de login web inválida, stale ou reutilizada");
  }
  const storage = webLocalStorage();
  if (
    !storage ||
    storage.getItem(WEB_SESSION_QUARANTINE_KEY) !== prepared.marker
  ) {
    webLoginInProgress = null;
    throw new Error("Marker do login web mudou antes do request");
  }
  // Apagar a capability antes do primeiro await torna qualquer erro posterior
  // conservador: o marker exige logout remoto, mesmo se o fetch não saiu.
  webLoginInProgress = null;
}

/** Cancela apenas o LOGIN_IN_PROGRESS ainda não consumido pelo cliente HTTP. */
export async function cancelWebLoginInProgress(
  ticket: WebLoginInProgress,
): Promise<void> {
  const prepared = webLoginInProgress;
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (
    Platform.OS !== "web" ||
    !prepared ||
    prepared.ticket !== ticket ||
    !workflowSignal ||
    workflowSignal !== prepared.workflowSignal ||
    workflowSignal.aborted
  ) {
    throw new Error(
      "Capability de cancelamento do login inválida ou consumida",
    );
  }
  const mutation = webSessionQuarantineTail.then(async () => {
    if (webLoginInProgress !== prepared) {
      throw new Error("Capability do login foi substituída");
    }
    await clearExactWebSessionGate(prepared.marker);
    if (ownedWebSessionGate === prepared.marker) ownedWebSessionGate = null;
    if (observedWebSessionGate === prepared.marker)
      observedWebSessionGate = null;
    webLoginInProgress = null;
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
}

/**
 * Barreira de rotação web. Diferente do login, a identidade esperada já é
 * conhecida antes do request remoto; por isso a transição é atômica de
 * CLEAR para ADMISSION e nunca passa por LOGIN_IN_PROGRESS.
 */
export async function beginWebSessionAdmission(
  expectedUserId: number,
): Promise<void> {
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) {
    throw new Error("Usuário esperado da sessão web inválido");
  }
  if (Platform.OS !== "web") return;
  closeSessionTokenTransportAdmission();
  const expected = `${WEB_PENDING_ADMISSION_PREFIX}:${expectedUserId}:${createWebSessionGateNonce()}`;
  const mutation = webSessionQuarantineTail.then(async () => {
    await transitionExactWebSessionGate(
      null,
      expected,
      "Admissão esperada da sessão web não foi confirmada",
    );
    ownedWebSessionGate = expected;
    observedWebSessionGate = expected;
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
}

/**
 * Registra a identidade esperada depois do POST e antes do /me canônico. Um
 * reload preserva ADMISSION, mas não promove a identidade por conta própria.
 */
export async function prepareWebSessionAdmission(
  expectedUserId: number,
): Promise<void> {
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) {
    throw new Error("Usuário esperado da sessão web inválido");
  }
  if (Platform.OS !== "web") return;
  closeSessionTokenTransportAdmission();
  const mutation = webSessionQuarantineTail.then(async () => {
    const current = ownedWebSessionGate;
    const match = current
      ? /^login-in-progress:v3:([0-9a-f]{32})$/.exec(current)
      : null;
    if (!match) {
      throw new Error("Login web em andamento não pôde ser confirmado");
    }
    const expected = `${WEB_PENDING_ADMISSION_PREFIX}:${expectedUserId}:${match[1]}`;
    await transitionExactWebSessionGate(
      current,
      expected,
      "Admissão esperada da sessão web não foi confirmada",
    );
    ownedWebSessionGate = expected;
    observedWebSessionGate = expected;
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
}

/**
 * Barreira explícita para logout/revogação. Diferente de ADMISSION, este
 * estado nunca autoriza recuperação de identidade após reload.
 */
export async function beginWebSessionQuarantine(
  expectedUserId?: number,
  sessionInstance?: string,
): Promise<void> {
  if (Platform.OS !== "web") return;
  if (
    expectedUserId !== undefined &&
    (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0)
  ) {
    throw new Error("Usuário esperado da revogação web inválido");
  }
  if (sessionInstance !== undefined) {
    if (
      expectedUserId === undefined ||
      !SESSION_INSTANCE_PATTERN.test(sessionInstance)
    ) {
      throw new Error("Instância esperada da revogação web inválida");
    }
  }
  closeSessionTokenTransportAdmission();
  const mutation = webSessionQuarantineTail.then(async () => {
    await withWebSessionGateLock(async () => {
      const storage = webLocalStorage();
      if (!storage) {
        throw new Error("Storage cross-tab da sessão web indisponível");
      }
      const current = storage.getItem(WEB_SESSION_QUARANTINE_KEY);
      const revocation = current ? parseWebRevocation(current) : null;
      const admissionExpectedUserId = current
        ? parseWebAdmissionExpectedUserId(current)
        : null;
      const loginInProgress =
        current !== null && /^login-in-progress:v3:[0-9a-f]{32}$/.test(current);
      const unbound = current !== null && isUnboundWebRevocation(current);
      let next: string;

      if (revocation) {
        if (
          (expectedUserId !== undefined &&
            expectedUserId !== revocation.expectedUserId) ||
          (sessionInstance !== undefined &&
            revocation.sessionInstance !== undefined &&
            sessionInstance !== revocation.sessionInstance)
        ) {
          throw new Error(
            "Binding físico da revogação web divergiu do request",
          );
        }
        // Reentradas e cold recovery nunca podem rebaixar v4/v3 para um marker
        // anônimo. Uma instância exata só fortalece v3 quando o mesmo usuário já
        // está fisicamente bindado.
        next =
          sessionInstance !== undefined &&
          revocation.sessionInstance === undefined
            ? createWebRevocationMarker(
                revocation.expectedUserId,
                sessionInstance,
              )
            : current!;
      } else if (unbound) {
        next =
          expectedUserId === undefined
            ? current!
            : createWebRevocationMarker(expectedUserId, sessionInstance);
      } else if (admissionExpectedUserId !== null) {
        if (
          expectedUserId !== undefined &&
          expectedUserId !== admissionExpectedUserId
        ) {
          throw new Error("Binding físico da admissão web divergiu do request");
        }
        next = createWebRevocationMarker(
          admissionExpectedUserId,
          sessionInstance,
        );
      } else if (current === null || loginInProgress) {
        next = createWebRevocationMarker(expectedUserId, sessionInstance);
      } else {
        throw new Error(
          "Marker web desconhecido não autoriza transição de revogação",
        );
      }

      if (next !== current) {
        storage.setItem(WEB_SESSION_QUARANTINE_KEY, next);
        if (storage.getItem(WEB_SESSION_QUARANTINE_KEY) !== next) {
          throw new Error("Quarentena da sessão web não foi confirmada");
        }
      }
      ownedWebSessionGate = next;
      observedWebSessionGate = next;
    });
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
}

/**
 * Autoridade única para liberar REVOKE_REQUIRED: captura o marker físico,
 * executa o próprio `/logout`, valida o body tipado/fence e só então remove o
 * mesmo nonce por CAS. Mismatch esperado também é provado pela resposta real
 * e abandona apenas o marker bindado da conta stale.
 */
export async function revokeWebSessionQuarantine(
  expectedUserId?: number,
  sessionInstance?: string,
): Promise<WebSessionRevocationResult> {
  if (Platform.OS !== "web") {
    throw new Error("Revogação da quarentena web indisponível no nativo");
  }
  if (
    expectedUserId !== undefined &&
    (!Number.isSafeInteger(expectedUserId) || expectedUserId <= 0)
  ) {
    throw new Error("Usuário esperado da revogação web inválido");
  }
  if (
    sessionInstance !== undefined &&
    (expectedUserId === undefined ||
      !SESSION_INSTANCE_PATTERN.test(sessionInstance))
  ) {
    throw new Error("Instância esperada da revogação web inválida");
  }
  const workflowSignal = getActiveWebSessionWorkflowSignal();
  if (!workflowSignal || workflowSignal.aborted) {
    throw new Error("Revogação web fora do workflow exclusivo");
  }
  await webSessionQuarantineTail;
  const storage = webLocalStorage();
  if (!storage) {
    throw new Error("Storage cross-tab da sessão web indisponível");
  }
  const marker = storage.getItem(WEB_SESSION_QUARANTINE_KEY);
  if (marker === null) {
    throw new Error("Quarentena web ausente antes da revogação remota");
  }
  const parsed = parseWebRevocation(marker);
  const unbound = isUnboundWebRevocation(marker);
  if (!parsed && !unbound) {
    throw new Error("Marker web não autoriza revogação remota");
  }
  if (
    parsed &&
    ((expectedUserId !== undefined &&
      parsed.expectedUserId !== expectedUserId) ||
      (sessionInstance !== undefined &&
        parsed.sessionInstance !== sessionInstance))
  ) {
    throw new Error("Binding físico da revogação web divergiu do request");
  }

  // O marker físico é a autoridade, não os argumentos opcionais do caller.
  // Assim uma leitura opaca/cold recovery nunca transforma A em um logout sem
  // expected-user nem remove a proof exact-v1 já persistida.
  const effectiveExpectedUserId = parsed?.expectedUserId ?? expectedUserId;
  const effectiveSessionInstance = parsed?.sessionInstance ?? sessionInstance;

  const requestTransportGeneration = sessionTransportGeneration;
  const remote = await requestPreparedWebSessionRevocation(
    effectiveExpectedUserId,
    effectiveSessionInstance,
    {
      marker,
      transportGeneration: requestTransportGeneration,
      workflowSignal,
    },
  );
  if (
    remote.status === "REVOKED" &&
    effectiveExpectedUserId !== undefined &&
    remote.revocation.revocationUserId !== undefined &&
    remote.revocation.revocationUserId !== effectiveExpectedUserId
  ) {
    throw new Error("Prova remota da revogação web pertence a outro usuário");
  }
  let staleReceipt: WebStaleQuarantineReceipt | undefined;
  if (remote.status === "STALE_QUARANTINE_CLEARED") {
    if (!parsed || effectiveExpectedUserId === undefined) {
      throw new Error("Mismatch remoto não corresponde ao marker web bindado");
    }
    staleReceipt = remote.receipt;
  }
  if (
    getActiveWebSessionWorkflowSignal() !== workflowSignal ||
    workflowSignal.aborted ||
    sessionTransportGeneration !== requestTransportGeneration
  ) {
    throw new Error("Prova remota da revogação web ficou stale");
  }
  const mutation = webSessionQuarantineTail.then(async () => {
    await clearExactWebSessionGate(marker, () => {
      if (
        getActiveWebSessionWorkflowSignal() !== workflowSignal ||
        workflowSignal.aborted ||
        sessionTransportGeneration !== requestTransportGeneration
      ) {
        throw new Error("Prova remota da revogação web ficou stale");
      }
      if (staleReceipt && effectiveExpectedUserId !== undefined) {
        consumeWebStaleQuarantineReceipt(staleReceipt, {
          marker,
          transportGeneration: requestTransportGeneration,
          expectedUserId: effectiveExpectedUserId,
          workflowSignal,
        });
      }
    });
    if (ownedWebSessionGate === marker) ownedWebSessionGate = null;
    if (observedWebSessionGate === marker) observedWebSessionGate = null;
    if (reversibleWebSessionRevocation?.marker === marker) {
      reversibleWebSessionRevocation = null;
    }
  });
  webSessionQuarantineTail = mutation.catch(() => undefined);
  await mutation;
  return remote.status === "REVOKED"
    ? { status: "REVOKED", revocation: remote.revocation }
    : { status: "STALE_QUARANTINE_CLEARED" };
}

/**
 * Leitura tipada fail-closed. Qualquer conteúdo desconhecido ou falha de
 * storage exige revogação; somente ausência confirmada representa CLEAR.
 */
export async function getWebSessionGateState(): Promise<WebSessionGateState> {
  if (Platform.OS !== "web") return { state: "CLEAR" };
  await webSessionQuarantineTail;
  try {
    const storage = webLocalStorage();
    if (!storage) return { state: "REVOKE_REQUIRED" };
    const marker = storage.getItem(WEB_SESSION_QUARANTINE_KEY);
    observedWebSessionGate = marker;
    if (marker === null) return { state: "CLEAR" };
    const expectedUserId = parseWebAdmissionExpectedUserId(marker);
    if (expectedUserId !== null) {
      return { state: "ADMISSION", expectedUserId };
    }
    const revocation = parseWebRevocation(marker);
    if (revocation !== null) {
      return {
        state: "REVOKE_REQUIRED",
        expectedUserId: revocation.expectedUserId,
        ...(revocation.sessionInstance
          ? { sessionInstance: revocation.sessionInstance }
          : {}),
      };
    }
    return { state: "REVOKE_REQUIRED" };
  } catch {
    return { state: "REVOKE_REQUIRED" };
  }
}

/** Compatibilidade booleana conservadora para consumidores em migração. */
export async function isWebSessionQuarantined(): Promise<boolean> {
  return (await getWebSessionGateState()).state !== "CLEAR";
}

// --- User Info (cache local) ---

export async function setUserInfo(user: User): Promise<void> {
  const mutation = userInfoMutationTail.then(() =>
    AsyncStorage.setItem(USER_INFO_KEY, JSON.stringify(user)),
  );
  userInfoMutationTail = mutation.catch(() => undefined);
  await waitForActiveWebSessionWorkflow(mutation);
}

/**
 * Identidade local persistida — não é prova de sessão. Serve só para o
 * boot/login saber que já existe um cookie/token comprometido quando o
 * `/me` está indisponível (cold start), em vez de devolver o formulário vazio.
 */
export async function getPersistedUserId(): Promise<number | null> {
  try {
    await userInfoMutationTail;
    const raw = await AsyncStorage.getItem(USER_INFO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === "number" &&
      Number.isSafeInteger(parsed.id) &&
      parsed.id > 0
      ? parsed.id
      : null;
  } catch {
    return null;
  }
}

export async function clearUserInfo(): Promise<void> {
  const mutation = userInfoMutationTail.then(() =>
    AsyncStorage.removeItem(USER_INFO_KEY),
  );
  userInfoMutationTail = mutation.catch(() => undefined);
  await waitForActiveWebSessionWorkflow(mutation);
}
