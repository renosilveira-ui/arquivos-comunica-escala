export const MAX_AGENDA_DAY_TICKS = 3;

/** A oferta é anexada depois dos plantões e fica oculta a partir do 4º traço. */
export function agendaOverflowIncludesOffer(
  shiftCount: number,
  hasOffer: boolean,
): boolean {
  return hasOffer && shiftCount >= MAX_AGENDA_DAY_TICKS;
}
