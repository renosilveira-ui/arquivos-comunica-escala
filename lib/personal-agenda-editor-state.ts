import {
  appSessionEpoch,
  type SessionEpoch,
  type SessionEpochTicket,
} from "./session-epoch";

export interface PersonalAgendaEditorTarget {
  sessionId: string;
  dateKey: string;
  itemId?: number;
}

export interface PersonalAgendaEditorRecord {
  id: number;
  version: number;
}

export interface PersonalAgendaEditorSnapshot {
  targetKey: string;
  itemId: number | null;
  version: number | null;
}

export type PersonalAgendaEditorVersionState =
  "CREATING" | "WAITING" | "READY" | "REMOTE_CHANGED";

export type PersonalAgendaEditorOperation = "SAVE" | "DELETE";

export interface PersonalAgendaEditorAuthority {
  userId: number;
  ticket: SessionEpochTicket;
}

export interface PersonalAgendaEditorOperationController {
  current(): PersonalAgendaEditorOperation | null;
  run<T>(
    operation: PersonalAgendaEditorOperation,
    task: () => Promise<T>,
  ): Promise<{ started: false } | { started: true; value: T }>;
}

export type PersonalAgendaEditorAsyncResult<T> =
  { current: true; value: T } | { current: false };

let editorSessionSequence = 0;

/**
 * Captura a identidade e a geração que abriram o editor. A resposta de uma
 * conta/sessão anterior não tem autoridade para iniciar nova escrita nem
 * repovoar o cache privado depois de logout ou troca de usuário.
 */
export function capturePersonalAgendaEditorAuthority(
  userId: number,
  epoch: SessionEpoch = appSessionEpoch,
): PersonalAgendaEditorAuthority {
  return { userId, ticket: epoch.capture() };
}

export function isPersonalAgendaEditorAuthorityCurrent(
  authority: PersonalAgendaEditorAuthority | null,
  currentUserId: number | null,
  epoch: SessionEpoch = appSessionEpoch,
): boolean {
  return (
    authority !== null &&
    authority.userId === currentUserId &&
    epoch.isCurrent(authority.ticket)
  );
}

/**
 * Revalida a sessão depois de cada espera assíncrona. Isso impede que uma
 * prévia concluída após o fechamento do editor dispare a mutação seguinte.
 */
export async function awaitPersonalAgendaEditorStep<T>(
  operation: Promise<T>,
  isCurrent: () => boolean,
): Promise<PersonalAgendaEditorAsyncResult<T>> {
  const value = await operation;
  return isCurrent() ? { current: true, value } : { current: false };
}

/**
 * Cancela leituras antigas antes de gravar no cache. A autoridade é conferida
 * novamente depois do cancelamento, pois logout/troca de conta podem ocorrer
 * enquanto ele aguarda.
 */
export async function reconcilePersonalAgendaEditorCache(input: {
  cancelInFlight: () => Promise<unknown>;
  isCurrent: () => boolean;
  apply: () => void;
}): Promise<boolean> {
  await input.cancelInFlight();
  if (!input.isCurrent()) return false;
  input.apply();
  return true;
}

/** Identidade efêmera: duas aberturas do mesmo item nunca são a mesma sessão. */
export function createPersonalAgendaEditorTarget(input: {
  dateKey: string;
  itemId?: number;
}): PersonalAgendaEditorTarget {
  editorSessionSequence += 1;
  return {
    ...input,
    sessionId: `personal-agenda-editor:${Date.now().toString(36)}:${editorSessionSequence.toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
  };
}

export function personalAgendaEditorTargetKey(
  target: PersonalAgendaEditorTarget,
): string {
  return target.sessionId;
}

/** Conclusão antiga só fecha exatamente a sessão que a iniciou. */
export function closePersonalAgendaEditorSession(
  current: PersonalAgendaEditorTarget | null,
  completedSessionId: string,
): PersonalAgendaEditorTarget | null {
  return current?.sessionId === completedSessionId ? null : current;
}

/** Resposta de mutação nunca pode povoar o cache de outro item. */
export function selectPersonalAgendaMutationRecord<
  TRecord extends PersonalAgendaEditorRecord,
>(itemId: number, record: TRecord): TRecord | null {
  return record.id === itemId ? record : null;
}

/**
 * Serializa salvar/excluir desde o primeiro toque até o último callback. O
 * estado síncrono fecha a janela anterior ao próximo render do React.
 */
export function createPersonalAgendaEditorOperationController(input: {
  isSessionActive: () => boolean;
  onChange: (operation: PersonalAgendaEditorOperation | null) => void;
}): PersonalAgendaEditorOperationController {
  let active: PersonalAgendaEditorOperation | null = null;
  return {
    current: () => active,
    async run<T>(
      operation: PersonalAgendaEditorOperation,
      task: () => Promise<T>,
    ) {
      if (active !== null) return { started: false };
      active = operation;
      if (input.isSessionActive()) input.onChange(operation);
      try {
        return { started: true, value: await task() };
      } finally {
        active = null;
        if (input.isSessionActive()) input.onChange(null);
      }
    },
  };
}

/** Cache/revalidação são pós-commit: falha não reclassifica a escrita como falha. */
export async function settlePersonalAgendaRefreshes(
  refreshes: readonly Promise<unknown>[],
): Promise<void> {
  await Promise.allSettled(refreshes);
}

/**
 * A consulta desabilitada do React Query ainda pode expor cache anterior.
 * Criação nunca pode consumir esse registro; edição só aceita o id solicitado.
 */
export function selectPersonalAgendaEditorRecord<
  TRecord extends PersonalAgendaEditorRecord,
>(
  target: PersonalAgendaEditorTarget,
  queriedRecord: TRecord | null | undefined,
): TRecord | null {
  if (target.itemId === undefined) return null;
  return queriedRecord?.id === target.itemId ? queriedRecord : null;
}

export function createPersonalAgendaEditorSnapshot(
  target: PersonalAgendaEditorTarget,
  record: PersonalAgendaEditorRecord | null,
): PersonalAgendaEditorSnapshot | null {
  if (target.itemId === undefined) {
    return {
      targetKey: personalAgendaEditorTargetKey(target),
      itemId: null,
      version: null,
    };
  }
  if (!record || record.id !== target.itemId) return null;
  return {
    targetKey: personalAgendaEditorTargetKey(target),
    itemId: record.id,
    version: record.version,
  };
}

export function personalAgendaEditorVersionState(
  target: PersonalAgendaEditorTarget,
  snapshot: PersonalAgendaEditorSnapshot | null,
  latestRecord: PersonalAgendaEditorRecord | null,
): PersonalAgendaEditorVersionState {
  if (target.itemId === undefined) return "CREATING";
  if (
    !snapshot ||
    snapshot.targetKey !== personalAgendaEditorTargetKey(target) ||
    snapshot.itemId !== target.itemId ||
    snapshot.version === null ||
    !latestRecord ||
    latestRecord.id !== target.itemId
  ) {
    return "WAITING";
  }
  return latestRecord.version === snapshot.version ? "READY" : "REMOTE_CHANGED";
}

/**
 * A versão enviada no CAS é sempre a que originou o formulário. A versão mais
 * nova da consulta jamais legitima campos antigos como se fossem atuais.
 */
export function personalAgendaExpectedVersion(
  target: PersonalAgendaEditorTarget,
  snapshot: PersonalAgendaEditorSnapshot | null,
  latestRecord: PersonalAgendaEditorRecord | null,
): number {
  const state = personalAgendaEditorVersionState(
    target,
    snapshot,
    latestRecord,
  );
  if (state === "REMOTE_CHANGED") {
    throw new Error(
      "Este item foi alterado em outro aparelho. Carregue a versão mais recente antes de continuar.",
    );
  }
  if (state !== "READY" || !snapshot || snapshot.version === null) {
    throw new Error("A versão atual do item ainda não está disponível.");
  }
  return snapshot.version;
}
