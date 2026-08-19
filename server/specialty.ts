// server/specialty.ts — separação por serviço/especialidade.
//
// Regra única, tolerante a legado: a restrição só se aplica quando o
// PLANTÃO e o PROFISSIONAL têm especialidade definida. NULL de qualquer
// lado = sem restrição (contas/turnos antigos seguem funcionando).
// Comparação case-insensitive com trim para tolerar variações de
// digitação entre Escala e Comunica+.

import { TRPCError } from "@trpc/server";

function norm(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().toLowerCase();
  return t.length ? t : null;
}

export function specialtiesConflict(
  shiftSpecialty: string | null | undefined,
  professionalSpecialty: string | null | undefined,
): boolean {
  const a = norm(shiftSpecialty);
  const b = norm(professionalSpecialty);
  return !!a && !!b && a !== b;
}

export function assertSpecialtyCompatible(
  shiftSpecialty: string | null | undefined,
  professionalSpecialty: string | null | undefined,
): void {
  if (specialtiesConflict(shiftSpecialty, professionalSpecialty)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Plantão do serviço de ${shiftSpecialty} — disponível apenas para profissionais dessa especialidade`,
    });
  }
}
