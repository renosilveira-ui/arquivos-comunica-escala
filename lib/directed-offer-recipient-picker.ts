/**
 * Projeção de UI para oferta direcionada de cessão/repasse.
 *
 * Não é autoridade de escrita. O servidor revalida em `createSwapOffer`.
 * SWAP não usa este seletor: o destinatário é o ocupante do plantão de
 * contrapartida.
 *
 * A query `swaps.listEligibleRecipients` devolve um objeto
 * `{ recipients, unresolvedHomonymGroups }`, nunca um array nu.
 */

export const UNRESOLVED_HOMONYM_CODE = "UNRESOLVED_HOMONYM" as const;

export type EligibleOfferRecipientView = {
  professionalId: number;
  displayName: string;
  qualification?: string;
};

export type UnresolvedOfferHomonymGroupView = {
  code: string;
  displayName: string;
  qualification: string | null;
  count: number;
  reason: string;
};

export type EligibleOfferRecipientListView = {
  recipients: EligibleOfferRecipientView[];
  unresolvedHomonymGroups: UnresolvedOfferHomonymGroupView[];
};

export type DirectedOfferAudience =
  | { kind: "open" }
  | { kind: "directed"; professionalId: number };

export const directedOfferRecipientCopy = {
  sectionTitle: "Destinatário",
  openLabel: "Oferta aberta",
  openHint: "Qualquer profissional elegível pode aceitar.",
  loading: "Carregando destinatários…",
  unresolved: "Aguarde a lista de destinatários.",
  errorTitle: "Não foi possível carregar os destinatários",
  emptySelectable:
    "Nenhum profissional elegível para direcionar. Você ainda pode fazer uma oferta aberta.",
  unresolvedHeading: "Não é possível direcionar para estes nomes",
  staleDirected:
    "Este profissional não pode ser escolhido. Selecione alguém da lista ou faça uma oferta aberta.",
  waitingList:
    "Aguarde a lista de destinatários ou escolha a oferta aberta.",
} as const;

export function directedOfferRecipientLabel(
  recipient: EligibleOfferRecipientView,
): string {
  const name = recipient.displayName.trim();
  const qualification = recipient.qualification?.trim();
  if (qualification) return `${name} — ${qualification}`;
  return name;
}

export function unresolvedHomonymGroupLabel(
  group: UnresolvedOfferHomonymGroupView,
): string {
  const name = group.displayName.trim();
  const qualification = group.qualification?.trim();
  if (qualification) return `${name} — ${qualification}`;
  return name;
}

/**
 * Fail-closed: array nu, objeto incompleto ou campo estranho não vira lista.
 * professionalId em grupo irresolvido é ignorado — nunca vira opção.
 */
export function parseEligibleOfferRecipientList(
  data: unknown,
): EligibleOfferRecipientListView | null {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (
    !Array.isArray(record.recipients) ||
    !Array.isArray(record.unresolvedHomonymGroups)
  ) {
    return null;
  }

  const recipients: EligibleOfferRecipientView[] = [];
  for (const row of record.recipients) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const professionalId = Number(item.professionalId);
    const displayName =
      typeof item.displayName === "string" ? item.displayName.trim() : "";
    if (!Number.isSafeInteger(professionalId) || professionalId <= 0) continue;
    if (!displayName) continue;
    const qualification =
      typeof item.qualification === "string" && item.qualification.trim()
        ? item.qualification.trim()
        : undefined;
    recipients.push(
      qualification
        ? { professionalId, displayName, qualification }
        : { professionalId, displayName },
    );
  }

  const unresolvedHomonymGroups: UnresolvedOfferHomonymGroupView[] = [];
  for (const row of record.unresolvedHomonymGroups) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const displayName =
      typeof item.displayName === "string" ? item.displayName.trim() : "";
    if (!displayName) continue;
    const qualification =
      typeof item.qualification === "string"
        ? item.qualification
        : item.qualification === null
          ? null
          : null;
    const count = Number(item.count);
    unresolvedHomonymGroups.push({
      code:
        typeof item.code === "string" && item.code
          ? item.code
          : UNRESOLVED_HOMONYM_CODE,
      displayName,
      qualification,
      count: Number.isSafeInteger(count) && count > 0 ? count : 0,
      reason: typeof item.reason === "string" ? item.reason : "",
    });
  }

  return { recipients, unresolvedHomonymGroups };
}

export function isSelectableDirectedRecipient(
  professionalId: number,
  list: EligibleOfferRecipientListView | null | undefined,
): boolean {
  return (list?.recipients ?? []).some(
    (row) => row.professionalId === professionalId,
  );
}

export type DirectedOfferWriteResolution =
  | { ok: true; toProfessionalId?: number }
  | { ok: false; message: string };

export function resolveDirectedOfferWrite(
  operation: "SWAP" | "TRANSFER" | "CESSAO",
  audience: DirectedOfferAudience,
  list: EligibleOfferRecipientListView | null | undefined,
): DirectedOfferWriteResolution {
  if (operation === "SWAP") {
    return { ok: true };
  }
  if (audience.kind === "open") {
    return { ok: true };
  }
  if (!list) {
    return { ok: false, message: directedOfferRecipientCopy.waitingList };
  }
  if (!isSelectableDirectedRecipient(audience.professionalId, list)) {
    return { ok: false, message: directedOfferRecipientCopy.staleDirected };
  }
  return { ok: true, toProfessionalId: audience.professionalId };
}
