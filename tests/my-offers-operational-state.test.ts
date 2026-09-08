import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const offers = readFileSync("app/my-offers.tsx", "utf8");

describe("Ofertas próprias: erro, vazio e invalidação", () => {
  it("não afirma lista vazia enquanto a consulta não resolveu", () => {
    expect(offers).toContain("resolveOperationalListState");
    expect(offers).toContain("isPending");
    expect(offers).toContain('contentState === "ERROR"');
    expect(offers).toContain('contentState === "UNRESOLVED"');
    expect(offers).toContain('contentState === "EMPTY"');
    expect(offers).toContain("error={error}");
    expect(offers).not.toMatch(/isLoading \? \(/);
  });

  it("só publica contagem depois de READY ou EMPTY", () => {
    expect(offers).toContain(
      'if (contentState === "READY" || contentState === "EMPTY")',
    );
    expect(offers).not.toContain("if (data !== undefined && !isError)");
  });

  it("cancelar invalida lista, disponíveis e badge na mesma conta", () => {
    const cancelBlock = offers.slice(
      offers.indexOf("trpc.swaps.cancel.useMutation"),
      offers.indexOf("trpc.swaps.approveByOwner.useMutation"),
    );
    expect(cancelBlock).toContain("utils.swaps.list.invalidate()");
    expect(cancelBlock).toContain("utils.swaps.listAvailable.invalidate()");
    expect(cancelBlock).toContain("utils.swaps.countActionable.invalidate()");
  });
});
