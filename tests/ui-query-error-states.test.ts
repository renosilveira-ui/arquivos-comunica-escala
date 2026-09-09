import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function expectBefore(text: string, first: string, second: string): void {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  expect(firstIndex, `${first} deve existir`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `${second} deve existir`).toBeGreaterThanOrEqual(0);
  expect(
    firstIndex,
    `${first} deve ser avaliado antes de ${second}`,
  ).toBeLessThan(secondIndex);
}

describe("estados operacionais de erro não se apresentam como vazios", () => {
  it("separa falha da auditoria de ausência real de movimentações", () => {
    const screen = source("app/audit-log.tsx");

    expect(screen).toContain("resolveOperationalListState");
    expectBefore(screen, 'queryState === "ERROR"', "filteredRows.length === 0");
    expect(screen).toContain("QueryErrorState");
  });

  it("separa falha de instituições de vínculo realmente vazio", () => {
    const screen = source("app/select-institution.tsx");

    expect(screen).toContain("resolveOperationalListState");
    expectBefore(
      screen,
      'institutionsState === "ERROR"',
      "Nenhuma instituição ativa",
    );
  });

  it("separa falha de candidatos de plantão sem elegíveis", () => {
    const screen = source("app/nominate-replacement.tsx");

    expect(screen).toContain("resolveOperationalListState");
    expectBefore(
      screen,
      'candidatesState === "ERROR"',
      "Nenhum profissional disponível",
    );
  });

  it("não converte falha do detalhe em escala inexistente", () => {
    const screen = source("app/shift-details.tsx");

    expectBefore(screen, "apiShiftIsError", "Escala não encontrada");
    expectBefore(
      screen,
      "assignableProfessionalsIsError",
      "Nenhum profissional habilitado",
    );
  });

  it("não monta formulário de edição sem carregar o plantão", () => {
    const screen = source("app/edit-shift.tsx");
    const queryErrorState = source("components/ui/QueryErrorState.tsx");

    expectBefore(
      screen,
      "shiftIsError || !shiftData",
      "Setor não identificado",
    );
    expect(screen).toContain("QueryErrorState");
    expect(screen).toContain('"Voltar à Agenda"');
    expect(queryErrorState).toContain('retryLabel = "Tentar novamente"');
    expect(queryErrorState).toContain("{retryLabel}");
  });

  it("admin distingue falha, resposta vazia e resposta obsoleta", () => {
    const screen = source("app/(tabs)/admin.tsx");

    expect(screen).toContain("usersRequestSequence");
    expectBefore(screen, "usersError ?", "filtered.length === 0");
    expectBefore(screen, "!usersResolved ?", "filtered.length === 0");
  });
});
