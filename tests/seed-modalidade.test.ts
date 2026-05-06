import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { shiftInstances } from "../drizzle/schema";

/**
 * Garante que o seed de teste (`scripts/seed-test-data.ts`) popula
 * os campos de modalidade nos 5 shifts canônicos. Se alguém adicionar
 * um shift novo sem preencher os campos, o default do DB cobre — mas
 * os shifts citados aqui são consumidos por outros suites
 * (rbac-approval, shift-workflow) que cada vez mais vão depender de
 * filtragem por modalidade. Quebrar este teste = aviso para revisar
 * os outros antes de mergear.
 */

describe("Seed test data — modalidade preenchida", () => {
  let db: Awaited<ReturnType<typeof getDb>>;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");
  });

  it("Plantão Manhã (VAGO) é PLANTAO + URGENCIA_EMERGENCIA + FIXO_PRODUTIVIDADE_SEM_TETO", async () => {
    const [row] = await db!
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Manhã (VAGO)"))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.modality).toBe("PLANTAO");
    expect(row.coverageType).toBe("URGENCIA_EMERGENCIA");
    expect(row.paymentModel).toBe("FIXO_PRODUTIVIDADE_SEM_TETO");
    expect(row.productivityCapBrl).toBeNull();
  });

  it("Plantão Tarde (OCUPADO) é PLANTAO + ELETIVAS + FIXO", async () => {
    const [row] = await db!
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Tarde (OCUPADO)"))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.modality).toBe("PLANTAO");
    expect(row.coverageType).toBe("ELETIVAS");
    expect(row.paymentModel).toBe("FIXO");
  });

  it("Plantão Noite (PENDENTE) é SOBREAVISO + PRODUTIVIDADE_PURA, sem coverage", async () => {
    const [row] = await db!
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Noite (PENDENTE)"))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.modality).toBe("SOBREAVISO");
    expect(row.coverageType).toBeNull();
    expect(row.paymentModel).toBe("PRODUTIVIDADE_PURA");
  });

  it("Plantão Retroativo é o único com productivityCapBrl preenchido (FIXO_PRODUTIVIDADE_TETO 2500.00)", async () => {
    const [row] = await db!
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Retroativo (5 dias atrás)"))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.paymentModel).toBe("FIXO_PRODUTIVIDADE_TETO");
    expect(row.productivityCapBrl).toBe("2500.00");
  });
});
