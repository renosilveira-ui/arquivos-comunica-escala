import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { professionals, shiftInstances } from "../drizzle/schema";
import { appRouter } from "../server/routers";

/**
 * `shiftInstances.listVacancies` agora:
 *   - retorna modality / coverageType / paymentModel / productivityCapBrl;
 *   - filtra por modality e coverageType nas opções do input.
 *
 * Os shifts canônicos do seed (após PR #62) cobrem todos os modelos:
 *   - "Plantão Manhã (VAGO)"   → PLANTAO + URGENCIA_EMERGENCIA + FIXO_PRODUTIVIDADE_SEM_TETO
 *   - "Plantão Retroativo …"   → PLANTAO + URGENCIA_EMERGENCIA + FIXO_PRODUTIVIDADE_TETO + 2500.00
 *   - "Plantão Noite (PENDENTE)" → SOBREAVISO + PRODUTIVIDADE_PURA (coverage null)
 */

describe("shiftInstances.listVacancies — modality output + filter", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let userId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    // Pedro (USER) tem acesso ao Centro Cirúrgico no seed.
    const [pedro] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. Pedro Costa"))
      .limit(1);
    if (!pedro) throw new Error("Pedro do seed não encontrado");
    userId = pedro.userId!;
  });

  function caller() {
    return appRouter.createCaller({
      user: { id: userId, role: "doctor", name: "Pedro", email: "pedro@test.local" },
      institutionId: 1, // primeira institution do seed
      allowedInstitutionIds: [1],
    } as any);
  }

  it("retorna modality / coverageType / paymentModel / productivityCapBrl no payload", async () => {
    const rows = await caller().shiftInstances.listVacancies({});

    // Pelo menos o "Plantão Manhã (VAGO)" deve aparecer (status VAGO).
    const manha = rows.find((r) => r.label === "Plantão Manhã (VAGO)");
    expect(manha).toBeDefined();
    expect(manha!.modality).toBe("PLANTAO");
    expect(manha!.coverageType).toBe("URGENCIA_EMERGENCIA");
    expect(manha!.paymentModel).toBe("FIXO_PRODUTIVIDADE_SEM_TETO");
    expect(manha!.productivityCapBrl).toBeNull();
  });

  it("o shift retroativo carrega productivityCapBrl como string '2500.00'", async () => {
    const rows = await caller().shiftInstances.listVacancies({});
    const retro = rows.find((r) => r.label === "Plantão Retroativo (5 dias atrás)");
    expect(retro).toBeDefined();
    expect(retro!.paymentModel).toBe("FIXO_PRODUTIVIDADE_TETO");
    expect(retro!.productivityCapBrl).toBe("2500.00");
  });

  it("filtro modality=SOBREAVISO retorna apenas sobreavisos", async () => {
    const rows = await caller().shiftInstances.listVacancies({ modality: "SOBREAVISO" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.modality).toBe("SOBREAVISO");
    }
    // O "Plantão Noite (PENDENTE)" do seed é SOBREAVISO.
    const noite = rows.find((r) => r.label === "Plantão Noite (PENDENTE)");
    expect(noite).toBeDefined();
    expect(noite!.coverageType).toBeNull();
  });

  it("filtro coverageType=ELETIVAS exclui urgência/emergência e sobreavisos", async () => {
    const rows = await caller().shiftInstances.listVacancies({ coverageType: "ELETIVAS" });
    for (const r of rows) {
      expect(r.coverageType).toBe("ELETIVAS");
      expect(r.modality).toBe("PLANTAO");
    }
  });

  it("filtros são compostos (modality=PLANTAO + coverageType=URGENCIA_EMERGENCIA)", async () => {
    const rows = await caller().shiftInstances.listVacancies({
      modality: "PLANTAO",
      coverageType: "URGENCIA_EMERGENCIA",
    });
    for (const r of rows) {
      expect(r.modality).toBe("PLANTAO");
      expect(r.coverageType).toBe("URGENCIA_EMERGENCIA");
    }
    // Manhã e Retroativo são PLANTAO + URGENCIA_EMERGENCIA no seed.
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("Plantão Manhã (VAGO)");
  });
});
