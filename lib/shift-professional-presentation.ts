export function shiftProfessionalNameLines(
  shift: Readonly<{
    professionalNames: readonly string[];
    isMine: boolean;
  }>,
  emptyLabel: string,
): string[] {
  if (shift.isMine && shift.professionalNames.length <= 1) return ["Você"];
  if (shift.professionalNames.length > 0) return [...shift.professionalNames];
  return [emptyLabel];
}
