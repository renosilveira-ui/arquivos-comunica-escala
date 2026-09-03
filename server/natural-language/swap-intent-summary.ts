// server/natural-language/swap-intent-summary.ts — resumo humano da
// intenção resolvida.
//
// Formatter compartilhado: a mesma função serve a tela de confirmação do
// comando de voz e, no futuro, a mensagem de confirmação de um canal de
// texto. Sem PII além do necessário para a pessoa reconhecer a operação —
// nome do colega, sim; e-mail, telefone e identificadores internos, não.

import { formatDayKeyHuman } from "./swap-intent-date";
import type { ResolvedShiftRef, ResolvedSwapIntent } from "./swap-intent-types";

export type SwapIntentSummary = {
  /** "Troca solicitada" / "Cessão solicitada". */
  title: string;
  /** Bloco multilinha pronto para exibição. */
  body: string;
  /** Frase única para confirmação em linha ("… Confirmar?"). */
  confirmation: string;
};

function describeShift(shift: ResolvedShiftRef): string {
  return `${formatDayKeyHuman(shift.dayKey)} · ${shift.timeRange}\n${shift.sectorName} · ${shift.label}`;
}

export function formatSwapIntentSummary(
  resolved: ResolvedSwapIntent,
): SwapIntentSummary {
  const firstName = resolved.targetProfessional.name.split(" ")[0];
  const own = describeShift(resolved.ownShift);

  if (resolved.kind === "SWAP") {
    return {
      title: "Troca solicitada",
      body: [
        "Seu plantão:",
        own,
        `Plantão de ${resolved.targetProfessional.name}:`,
        describeShift(resolved.targetShift),
      ].join("\n"),
      confirmation:
        `Trocar seu plantão de ${formatDayKeyHuman(resolved.ownShift.dayKey)} ` +
        `(${resolved.ownShift.label}, ${resolved.ownShift.timeRange}) pelo plantão de ` +
        `${resolved.targetProfessional.name} de ${formatDayKeyHuman(resolved.targetShift.dayKey)} ` +
        `(${resolved.targetShift.label}, ${resolved.targetShift.timeRange}). ` +
        `${firstName} receberá a oferta para aceitar. Confirmar?`,
    };
  }

  return {
    title: "Cessão solicitada",
    body: [
      "Seu plantão:",
      own,
      "Para:",
      resolved.targetProfessional.name,
    ].join("\n"),
    confirmation:
      `Passar seu plantão de ${formatDayKeyHuman(resolved.ownShift.dayKey)} ` +
      `(${resolved.ownShift.label}, ${resolved.ownShift.timeRange}) para ` +
      `${resolved.targetProfessional.name}. ` +
      `${firstName} receberá a oferta para aceitar. Confirmar?`,
  };
}
