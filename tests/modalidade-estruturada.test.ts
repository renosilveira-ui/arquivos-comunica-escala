import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  hospitals,
  institutions,
  professionals,
  professionalInstitutions,
  sectors,
  shiftAuditLog,
  shiftInstances,
  shiftTemplates,
} from "../drizzle/schema";
import { shiftsRouter } from "../server/shifts-crud";

/**
 * Modalidade estruturada (docs/product/escala-ux.md §5).
 *
 * Antes desta frente, `shifts.label` era texto livre ("Plantão",
 * "Sobreaviso") e não dava pra filtrar por modalidade nem cruzar com
 * cálculo financeiro. Esta suíte garante que:
 *
 *   1. shift_instances aceita os 4 campos novos: modality, coverage_type,
 *      payment_model, productivity_cap_brl.
 *   2. Defaults do banco funcionam: rows criadas sem os campos saem com
 *      modality=PLANTAO e payment_model=FIXO.
 *   3. shifts.create persiste valores explícitos quando passados.
 *   4. shifts.update altera os campos individualmente sem afetar os
 *      outros.
 *   5. Combinações inválidas (SOBREAVISO com coverageType) são bloqueadas
 *      com 400.
 */

const FIXTURE_PREFIX = "modalidade-test-";

describe("Modalidade estruturada (shift_instances)", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let userAId: number;
  let proAId: number;
  let proLinkId: number;
  let originalRole: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
  let templateId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const [institution] = await db.select().from(institutions).limit(1);
    const [hospital] = await db
      .select()
      .from(hospitals)
      .where(eq(hospitals.institutionId, institution!.id))
      .limit(1);
    const [sector] = await db
      .select()
      .from(sectors)
      .where(eq(sectors.name, "Centro Cirúrgico"))
      .limit(1);
    institutionId = institution!.id;
    hospitalId = hospital!.id;
    sectorId = sector!.id;

    // Usa João Silva (GESTOR_PLUS no seed) para evitar pisar no role
    // do Pedro (USER), que outros testes (rbac-approval) dependem.
    const [joao] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. João Silva"))
      .limit(1);
    if (!joao) throw new Error("Profissional do seed não encontrado (Dr. João Silva)");
    proAId = joao.id;
    userAId = joao.userId!;

    // Captura o link/role atual para garantir restore em afterAll,
    // mesmo que João já seja GESTOR_PLUS (paranoia: se outro teste
    // mudar antes do nosso, restauramos o que encontramos).
    const [link] = await db
      .select()
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.professionalId, proAId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      )
      .limit(1);
    if (!link) {
      throw new Error("professional_institutions link não encontrado para Dr. João Silva");
    }
    proLinkId = link.id;
    originalRole = link.roleInInstitution as typeof originalRole;
    if (originalRole !== "GESTOR_PLUS") {
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "GESTOR_PLUS" })
        .where(eq(professionalInstitutions.id, proLinkId));
    }

    // Cria/reutiliza um template para o sector. shifts.create exige
    // template — não dá para criar shift sem um.
    const [existingTemplate] = await db
      .select()
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, institutionId),
          eq(shiftTemplates.name, `${FIXTURE_PREFIX}template`),
        ),
      )
      .limit(1);
    if (existingTemplate) {
      templateId = existingTemplate.id;
    } else {
      const [tplRes] = await db.insert(shiftTemplates).values({
        institutionId,
        hospitalId,
        sectorId,
        name: `${FIXTURE_PREFIX}template`,
        startTime: "08:00:00",
        endTime: "14:00:00",
      });
      templateId = (tplRes as any).insertId as number;
    }

    await cleanupShifts();
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupShifts();
    // Cleanup do template também — outros testes não dependem dele.
    await db.delete(shiftTemplates).where(eq(shiftTemplates.id, templateId));
    // Restore role original — evita poluir suíte rbac-approval/
    // shift-workflow que dependem da matriz de papéis do seed.
    if (originalRole && proLinkId) {
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: originalRole })
        .where(eq(professionalInstitutions.id, proLinkId));
    }
  });

  async function cleanupShifts(): Promise<void> {
    if (!db) return;
    // Coleta os IDs dos fixtures deste suite primeiro porque
    // shift_instances tem FKs apontando pra ele de shift_audit_log
    // (escrito por shifts.create/update), shift_assignments_v2,
    // swap_requests etc. Apagamos as referências antes pra não
    // disparar ER_ROW_IS_REFERENCED_2.
    const ids = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          like(shiftInstances.label, `${FIXTURE_PREFIX}template`),
        ),
      );
    if (ids.length === 0) return;
    const idList = ids.map((r) => r.id);
    await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, idList));
    await db.delete(shiftInstances).where(inArray(shiftInstances.id, idList));
  }

  function dateOffset(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + 60 + days); // +60 dias afastado de outras suites
    return d.toISOString().slice(0, 10);
  }

  function caller() {
    return shiftsRouter.createCaller({
      user: { id: userAId, role: "doctor", name: "Pedro", email: "pedro@test.local" },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
  }

  it("aplica defaults do DB quando os campos não são passados (modality=PLANTAO, paymentModel=FIXO)", async () => {
    const created = await caller().create({
      date: dateOffset(0),
      shiftTemplateId: templateId,
    });

    expect(created.modality).toBe("PLANTAO");
    expect(created.paymentModel).toBe("FIXO");
    expect(created.coverageType).toBeNull();
    expect(created.productivityCapBrl).toBeNull();
  });

  it("persiste todos os campos quando passados explicitamente", async () => {
    const created = await caller().create({
      date: dateOffset(1),
      shiftTemplateId: templateId,
      modality: "PLANTAO",
      coverageType: "URGENCIA_EMERGENCIA",
      paymentModel: "FIXO_PRODUTIVIDADE_TETO",
      productivityCapBrl: "1500.00",
    });

    expect(created.modality).toBe("PLANTAO");
    expect(created.coverageType).toBe("URGENCIA_EMERGENCIA");
    expect(created.paymentModel).toBe("FIXO_PRODUTIVIDADE_TETO");
    expect(created.productivityCapBrl).toBe("1500.00");
  });

  it("aceita SOBREAVISO sem coverageType", async () => {
    const created = await caller().create({
      date: dateOffset(2),
      shiftTemplateId: templateId,
      modality: "SOBREAVISO",
      paymentModel: "PRODUTIVIDADE_PURA",
    });

    expect(created.modality).toBe("SOBREAVISO");
    expect(created.coverageType).toBeNull();
    expect(created.paymentModel).toBe("PRODUTIVIDADE_PURA");
  });

  it("rejeita SOBREAVISO + coverageType na criação (BAD_REQUEST)", async () => {
    await expect(
      caller().create({
        date: dateOffset(3),
        shiftTemplateId: templateId,
        modality: "SOBREAVISO",
        coverageType: "URGENCIA_EMERGENCIA",
        paymentModel: "FIXO",
      }),
    ).rejects.toThrow(/SOBREAVISO não admite coverageType/i);
  });

  it("update altera apenas os campos passados; preserva o resto", async () => {
    const created = await caller().create({
      date: dateOffset(4),
      shiftTemplateId: templateId,
      modality: "PLANTAO",
      coverageType: "ELETIVAS",
      paymentModel: "FIXO",
    });

    const updated = await caller().update({
      id: created.id,
      paymentModel: "FIXO_PRODUTIVIDADE_SEM_TETO",
    });

    expect(updated!.modality).toBe("PLANTAO");
    expect(updated!.coverageType).toBe("ELETIVAS");
    expect(updated!.paymentModel).toBe("FIXO_PRODUTIVIDADE_SEM_TETO");
  });

  it("update bloqueia SOBREAVISO + coverageType vindo no patch", async () => {
    // Cria como SOBREAVISO sem coverage; tenta voltar pra SOBREAVISO
    // mas mandando coverageType — deve falhar.
    const created = await caller().create({
      date: dateOffset(5),
      shiftTemplateId: templateId,
      modality: "SOBREAVISO",
      paymentModel: "PRODUTIVIDADE_PURA",
    });

    await expect(
      caller().update({
        id: created.id,
        coverageType: "URGENCIA_EMERGENCIA",
        // modality não passada — assertModalityCoherent usa o existing
      }),
    ).rejects.toThrow(/SOBREAVISO não admite coverageType/i);
  });

  it("update aceita troca SOBREAVISO → PLANTAO com coverage no mesmo patch", async () => {
    // Caso legítimo: usuário decidiu transformar sobreaviso em plantão
    // de eletivas. Patch traz modality=PLANTAO + coverage juntos.
    const created = await caller().create({
      date: dateOffset(6),
      shiftTemplateId: templateId,
      modality: "SOBREAVISO",
      paymentModel: "PRODUTIVIDADE_PURA",
    });

    const updated = await caller().update({
      id: created.id,
      modality: "PLANTAO",
      coverageType: "ELETIVAS",
    });

    expect(updated!.modality).toBe("PLANTAO");
    expect(updated!.coverageType).toBe("ELETIVAS");
  });

  it("auto-null coverageType ao mudar PLANTAO → SOBREAVISO sem passar coverageType no patch", async () => {
    // Sem essa proteção, o invariante "SOBREAVISO ⇒ coverageType IS NULL"
    // seria violado: a row antiga ficaria com modality=SOBREAVISO mas
    // mantendo o coverageType do plantão original.
    const created = await caller().create({
      date: dateOffset(8),
      shiftTemplateId: templateId,
      modality: "PLANTAO",
      coverageType: "URGENCIA_EMERGENCIA",
      paymentModel: "FIXO",
    });
    expect(created.coverageType).toBe("URGENCIA_EMERGENCIA");

    const updated = await caller().update({
      id: created.id,
      modality: "SOBREAVISO",
      // coverageType NÃO passado: o router deve nullificar
    });

    expect(updated!.modality).toBe("SOBREAVISO");
    expect(updated!.coverageType).toBeNull();
  });

  it("rejeita productivityCapBrl em formato inválido (Zod)", async () => {
    await expect(
      caller().create({
        date: dateOffset(7),
        shiftTemplateId: templateId,
        productivityCapBrl: "1500,00", // vírgula em vez de ponto
      }),
    ).rejects.toThrow();
  });
});
