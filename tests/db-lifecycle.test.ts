import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../server/db";

describe("lifecycle do pool de banco", () => {
  it("closeDb invalida o cache e getDb abre um pool utilizável", async () => {
    const first = await getDb();
    expect(first).toBeTruthy();
    await first!.execute(sql`SELECT 1`);

    await closeDb();

    const reopened = await getDb();
    expect(reopened).toBeTruthy();
    expect(reopened).not.toBe(first);
    await expect(reopened!.execute(sql`SELECT 1`)).resolves.toBeTruthy();
  });
});
