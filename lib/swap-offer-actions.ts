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
