import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { professionals, shiftInstances, shiftAssignmentsV2 } from "../drizzle/schema";
import { appRouter } from "../server/routers";

/**
 * `shiftAssignments.listPending` agora carrega modalidade do shift
 * subjacente e aceita os mesmos filtros modality / coverageType que
 * listVacancies (PR #66). Permite que a tela de Solicitações
 * (manager view) filtre por modalidade no piloto.
 *
 * O seed (PR #62) cria um assignment PENDENTE no "Plantão Noite
 * (PENDENTE)" — que é SOBREAVISO + PRODUTIVIDADE_PURA.
 */

describe("shiftAssignments.listPending — modality output + filter", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let userId: number; // Maria Santos — GESTOR_MEDICO no seed

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const [maria] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dra. Maria Santos"))
      .limit(1);
    if (!maria) throw new Error("Dra. Maria Santos do seed não encontrada");
    userId = maria.userId!;

    // Sanity: garante que existe pelo menos um assignment PENDENTE
    // tied ao Plantão Noite (PENDENTE).
    const [shiftPendente] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Noite (PENDENTE)"))
      .limit(1);
    if (!shiftPendente) throw new Error("Shift PENDENTE do seed não encontrado");

    const existing = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftPendente.id))
      .limit(1);
    if (existing.length === 0) {
      // Defensivo — se outro suite limpou, recria o assignment.
      const [pedro] = await db
        .select()
        .from(professionals)
        .where(eq(professionals.name, "Dr. Pedro Costa"))
        .limit(1);
      if (pedro) {
        await db.insert(shiftAssignmentsV2).values({
          shiftInstanceId: shiftPendente.id,
          institutionId: shiftPendente.institutionId,
          hospitalId: shiftPendente.hospitalId,
          sectorId: shiftPendente.sectorId,
          professionalId: pedro.id,
          assignmentType: "ON_DUTY",
          status: "PENDENTE",
          isActive: true,
        });
      }
    }
  });

  function caller() {
    return appRouter.createCaller({
      user: { id: userId, role: "doctor", name: "Maria", email: "maria@test.local" },
      institutionId: 1,
      allowedInstitutionIds: [1],
    } as any);
  }

  it("retorna modalidade do shift subjacente em cada row", async () => {
    const rows = await caller().shiftAssignments.listPending({});

    const noite = rows.find((r) => r.shiftLabel === "Plantão Noite (PENDENTE)");
    expect(noite).toBeDefined();
    expect(noite!.modality).toBe("SOBREAVISO");
    expect(noite!.coverageType).toBeNull();
    expect(noite!.paymentModel).toBe("PRODUTIVIDADE_PURA");
  });

  it("filtro modality=SOBREAVISO retorna apenas pendências de sobreaviso", async () => {
    const rows = await caller().shiftAssignments.listPending({ modality: "SOBREAVISO" });
    for (const r of rows) {
      expect(r.modality).toBe("SOBREAVISO");
    }
  });

  it("filtro modality=PLANTAO exclui sobreavisos", async () => {
    const rows = await caller().shiftAssignments.listPending({ modality: "PLANTAO" });
    for (const r of rows) {
      expect(r.modality).toBe("PLANTAO");
    }
    const noite = rows.find((r) => r.shiftLabel === "Plantão Noite (PENDENTE)");
    expect(noite).toBeUndefined();
  });
});
