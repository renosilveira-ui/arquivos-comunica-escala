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
 * Semântica de `canRespond` em listAvailable: oferta aberta responde quem
 * a lista mostrou; direcionada só o destinatário nominal.
 * O SQL de visibilidade (plantonista vs gestor) já filtrou a linha.
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
