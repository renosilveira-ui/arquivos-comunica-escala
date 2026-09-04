/**
 * Oferta listada é acionável só com `canRespond === true`.
 * Servidor velho sem o boolean: fail-closed se a linha já carrega
 * destinatário (direcionada a outro); oferta aberta continua acionável.
 */
export function listedSwapIsActionable(row: {
  canRespond?: boolean;
  toProfessionalId?: number | string | null;
  toUserId?: number | string | null;
}): boolean {
  if (row.canRespond === true) return true;
  if (row.canRespond === false) return false;
  return row.toProfessionalId == null && row.toUserId == null;
}

/**
 * Semântica de direcionamento: oferta aberta responde o ator listado;
 * direcionada só o destinatário nominal.
 * Isto NÃO concede autoridade clínica. `canRespond` no servidor é
 * `listedOfferIsClinicallyActionable` (direcionamento ∧ professional_access).
 */
export function listedOfferCanRespond(
  toProfessionalId: number | string | null | undefined,
  toUserId: number | string | null | undefined,
  actorProfessionalId: number | null,
  actorUserId: number,
): boolean {
  if (actorProfessionalId == null) return false;
  if (toProfessionalId == null && toUserId == null) return true;
  return (
    Number(toProfessionalId) === actorProfessionalId &&
    Number(toUserId) === actorUserId
  );
}

/**
 * Autoridade operacional de resposta: direcionamento ∧ elegibilidade clínica.
 * `canView` administrativo (manager_scope / GESTOR_PLUS) não entra aqui.
 */
export function listedOfferIsClinicallyActionable(
  toProfessionalId: number | string | null | undefined,
  toUserId: number | string | null | undefined,
  actorProfessionalId: number | null,
  actorUserId: number,
  clinicallyEligible: boolean,
): boolean {
  return (
    clinicallyEligible === true &&
    listedOfferCanRespond(
      toProfessionalId,
      toUserId,
      actorProfessionalId,
      actorUserId,
    )
  );
}
