// lib/query-persist-policy.ts — O QUE do cache de consultas pode ir para o
// disco. Sem importar React Native: testável em Node.
//
// Contexto (23/08): o staging roda no plano free do Render e dorme após
// 15 min sem tráfego; acordar leva 30–60 s. Até aqui o app mostrava tela
// preta com spinner esse tempo todo, mesmo com usuário, instituição e a
// agenda da última abertura já conhecidos. Persistir as consultas de
// abertura deixa a Agenda pintar na hora com o último estado conhecido e
// revalidar em segundo plano (stale-while-revalidate).
//
// Só entram consultas de LEITURA de abertura de tela, e só quando tiveram
// sucesso. Nada de mutações, nada de fila de aprovação do gestor com
// decisão (listPending é recarregada sempre), nada de dados de outro
// usuário: a chave no disco inclui usuário + instituição (ver
// lib/query-persist.ts).

import type { Query } from "@tanstack/react-query";

/** Procedures tRPC cujo resultado pode ser restaurado na abertura do app. */
export const PERSISTED_PROCEDURES: ReadonlySet<string> = new Set([
  "professionals.listMyInstitutions",
  "professionals.getMyCapabilities",
  "professionals.getByUserId",
  "professionals.getManagerScope",
  "shifts.getNextShift",
  "shifts.listAgenda",
  "shifts.listByPeriod",
  "confirmations.getPending",
  "swaps.listAvailable",
  "hospitals.list",
  "sectors.list",
]);

/** Idade máxima de um cache restaurado: depois disso é descartado. */
export const PERSISTED_QUERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Caminho da procedure a partir da queryKey do tRPC v11
 * (`[["shifts","listAgenda"], { input, type: "query" }]`).
 */
export function procedurePathOf(queryKey: readonly unknown[]): string | null {
  const head = queryKey[0];
  if (!Array.isArray(head) || head.length === 0) return null;
  if (!head.every((segment) => typeof segment === "string")) return null;
  return (head as string[]).join(".");
}

export function shouldPersistQuery(query: Pick<Query, "queryKey" | "state">): boolean {
  if (query.state.status !== "success") return false;
  const path = procedurePathOf(query.queryKey);
  return path !== null && PERSISTED_PROCEDURES.has(path);
}
