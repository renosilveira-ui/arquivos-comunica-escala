import { describe, it, expect, beforeAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../server/db";
import { monthlyRosters, professionals, shiftInstances } from "../drizzle/schema";
import { appRouter } from "../server/routers";
import { dayKeyBrt, yearMonthBrt } from "../server/local-time";

/**
 * `shiftInstances.listVacancies` agora:
 *   - retorna modality / coverageType / paymentModel / productivityCapBrl;
 *   - filtra por modality e coverageType nas opções do input.
 *
 * Os shifts canônicos do seed (após PR #62) cobrem todos os modelos:
 *   - "Plantão Manhã (VAGO)"   → PLANTAO + URGENCIA_EMERGENCIA + FIXO_PRODUTIVIDADE_SEM_TETO
 *   - "Plantão Retroativo …"   → PLANTAO + URGENCIA_EMERGENCIA + FIXO_PRODUTIVIDADE_TETO + 2500.00
 *   - "Plantão Noite (PENDENTE)" → não deve aparecer aqui; já tem candidatura
 */

describe("shiftInstances.listVacancies — modality output + filter", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let userId: number;
  let seedVacancyDates: string[];

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

    const visibleSeedShifts = await db
      .select({
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        startAt: shiftInstances.startAt,
      })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, 1),
          inArray(shiftInstances.label, [
            "Plantão Manhã (VAGO)",
            "Plantão Retroativo (5 dias atrás)",
            "Plantão Noite (PENDENTE)",
          ]),
        ),
      );
    const rosterKeys = new Map(
      visibleSeedShifts.map((shift) => {
        const yearMonth = yearMonthBrt(shift.startAt);
        return [
          `${shift.institutionId}:${shift.hospitalId}:${yearMonth}`,
          {
            institutionId: shift.institutionId,
            hospitalId: shift.hospitalId,
            yearMonth,
            status: "PUBLISHED" as const,
          },
        ];
      }),
    );
    if (rosterKeys.size > 0) {
      await db
        .insert(monthlyRosters)
        .values([...rosterKeys.values()])
        .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    }
    seedVacancyDates = [...new Set(visibleSeedShifts.map((shift) => dayKeyBrt(shift.startAt)))];
  });

  function caller() {
    return appRouter.createCaller({
      user: { id: userId, role: "doctor", name: "Pedro", email: "pedro@test.local" },
      institutionId: 1, // primeira institution do seed
      allowedInstitutionIds: [1],
    } as any);
  }

  async function listSeedVacancies(filters: {
    modality?: "PLANTAO" | "SOBREAVISO";
    coverageType?: "URGENCIA_EMERGENCIA" | "ELETIVAS";
  } = {}) {
    const pages = await Promise.all(seedVacancyDates.map((date) =>
      caller().shiftInstances.listVacancies({ date, ...filters }),
    ));
    return pages.flat();
  }

  it("retorna modality / coverageType / paymentModel / productivityCapBrl no payload", async () => {
    const rows = await listSeedVacancies();

    // Pelo menos o "Plantão Manhã (VAGO)" deve aparecer (status VAGO).
    const manha = rows.find((r) => r.label === "Plantão Manhã (VAGO)");
    expect(manha).toBeDefined();
    expect(manha!.modality).toBe("PLANTAO");
    expect(manha!.coverageType).toBe("URGENCIA_EMERGENCIA");
    expect(manha!.paymentModel).toBe("FIXO_PRODUTIVIDADE_SEM_TETO");
    expect(manha!.productivityCapBrl).toBeNull();
  });

  it("o shift retroativo carrega productivityCapBrl como string '2500.00'", async () => {
    const rows = await listSeedVacancies();
    const retro = rows.find((r) => r.label === "Plantão Retroativo (5 dias atrás)");
    expect(retro).toBeDefined();
    expect(retro!.paymentModel).toBe("FIXO_PRODUTIVIDADE_TETO");
    expect(retro!.productivityCapBrl).toBe("2500.00");
  });

  it("não retorna plantões pendentes como vagas em aberto", async () => {
    const rows = await listSeedVacancies();
    expect(rows.every((r) => r.status === "VAGO")).toBe(true);
    expect(rows.find((r) => r.label === "Plantão Noite (PENDENTE)")).toBeUndefined();
  });

  it("filtro modality=SOBREAVISO retorna apenas sobreavisos", async () => {
    const rows = await listSeedVacancies({ modality: "SOBREAVISO" });
    for (const r of rows) {
      expect(r.modality).toBe("SOBREAVISO");
      expect(r.status).toBe("VAGO");
    }
  });

  it("filtro coverageType=ELETIVAS exclui urgência/emergência e sobreavisos", async () => {
    const rows = await listSeedVacancies({ coverageType: "ELETIVAS" });
    for (const r of rows) {
      expect(r.coverageType).toBe("ELETIVAS");
      expect(r.modality).toBe("PLANTAO");
    }
  });

  it("filtros são compostos (modality=PLANTAO + coverageType=URGENCIA_EMERGENCIA)", async () => {
    const rows = await listSeedVacancies({
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
