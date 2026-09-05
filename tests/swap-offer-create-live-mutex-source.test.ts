import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("createSwapOffer — mutex LIVE no fonte", () => {
  it("FOR UPDATE de mês e turno ocorrem antes do SELECT de existência, e esse SELECT não é locking", () => {
    const src = readFileSync("server/swap-offer-create.ts", "utf8");
    const txStart = src.indexOf("return db.transaction(async (tx) => {");
    expect(txStart).toBeGreaterThan(-1);
    const txBody = src.slice(txStart);

    const monthLock = txBody.indexOf("assertPublishedSwapMonthsForUpdate");
    const shiftLock = txBody.indexOf("lockSwapShiftsForUpdate");
    const existence = txBody.indexOf(
      'inArray(swapRequests.status, ["PENDING", "ACCEPTED"])',
    );
    const insert = txBody.indexOf("tx.insert(swapRequests)");

    expect(monthLock).toBeGreaterThan(-1);
    expect(shiftLock).toBeGreaterThan(monthLock);
    expect(existence).toBeGreaterThan(shiftLock);
    expect(insert).toBeGreaterThan(existence);

    const existenceBlock = txBody.slice(existence, insert);
    expect(existenceBlock).not.toMatch(/\.for\(\s*["']update["']\s*\)/);

    expect(src).toContain("REPEATABLE READ");
    expect(src).toContain("Não reordenar sem prova de concorrência MySQL");
    expect(src).not.toMatch(
      /db\.transaction\([\s\S]{0,80}ASSIGNMENT_WRITE_TRANSACTION_CONFIG/,
    );
  });
});
