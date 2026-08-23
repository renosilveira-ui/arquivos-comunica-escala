// tests/query-persist-policy.test.ts — o que do cache do react-query pode
// ir para o disco (abertura do app a partir do cache, 23/08).

import { describe, expect, it } from "vitest";
import {
  PERSISTED_PROCEDURES,
  PERSISTED_QUERY_MAX_AGE_MS,
  procedurePathOf,
  shouldPersistQuery,
} from "../lib/query-persist-policy";

const successful = (queryKey: readonly unknown[]) => ({ queryKey, state: { status: "success" as const } });

describe("política de persistência do cache de consultas", () => {
  it("extrai o caminho da procedure da queryKey do tRPC v11", () => {
    expect(procedurePathOf([["shifts", "listAgenda"], { input: { weeks: 2 }, type: "query" }])).toBe("shifts.listAgenda");
    expect(procedurePathOf([["professionals", "listMyInstitutions"], { type: "query" }])).toBe("professionals.listMyInstitutions");
    expect(procedurePathOf(["qualquer-coisa"])).toBeNull();
    expect(procedurePathOf([[]])).toBeNull();
    expect(procedurePathOf([[1, 2]])).toBeNull();
    expect(procedurePathOf([])).toBeNull();
  });

  it("persiste só consultas de abertura de tela que tiveram sucesso", () => {
    expect(shouldPersistQuery(successful([["shifts", "listAgenda"], { type: "query" }]))).toBe(true);
    expect(shouldPersistQuery(successful([["shifts", "getNextShift"], { type: "query" }]))).toBe(true);
    expect(shouldPersistQuery(successful([["professionals", "listMyInstitutions"], { type: "query" }]))).toBe(true);
    // Erro/pending nunca vão para o disco.
    expect(shouldPersistQuery({ queryKey: [["shifts", "listAgenda"]], state: { status: "error" } } as any)).toBe(false);
    expect(shouldPersistQuery({ queryKey: [["shifts", "listAgenda"]], state: { status: "pending" } } as any)).toBe(false);
  });

  it("não persiste fila de decisão do gestor, mutações nem procedures fora da lista", () => {
    expect(shouldPersistQuery(successful([["shiftAssignments", "listPending"], { type: "query" }]))).toBe(false);
    expect(shouldPersistQuery(successful([["confirmations", "registerPushToken"], { type: "mutation" }]))).toBe(false);
    expect(shouldPersistQuery(successful([["admin", "listUsers"], { type: "query" }]))).toBe(false);
    expect(PERSISTED_PROCEDURES.has("shiftAssignments.listPending")).toBe(false);
  });

  it("cache restaurado expira em 24 h", () => {
    expect(PERSISTED_QUERY_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
