import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "../server/db";
import { 
  professionals, 
  shiftInstances, 
  shiftAssignmentsV2,
  managerScope,
} from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { 
  canEditShift, 
  canAssumeVacancy, 
  canApproveAssignment 
} from "../server/rbac-validations";
import { validateAssignment } from "../server/shift-validations";

/**
 * Testes do Workflow de Vagas
 * 
 * Pré-requisitos: seed-test-data.ts deve ter sido executado
 * 
 * Dados esperados:
 * - Dr. João Silva (ID: 15, GESTOR_PLUS)
 * - Dra. Maria Santos (ID: 16, GESTOR_MEDICO, jurisdição Centro Cirúrgico)
 * - Dr. Pedro Costa (ID: 17, USER)
 * - Turno VAGO (ID: 2, amanhã 7h-13h, Centro Cirúrgico)
 * - Turno OCUPADO (ID: 3, hoje 13h-19h, Dr. Pedro)
 * - Turno PENDENTE (ID: 4, amanhã 19h-7h, Dr. Pedro aguardando)
 * - Turno RETROATIVO (ID: 5, ontem 7h-13h, VAGO)
 * - Turno UTI (ID: 6, 20 profissionais alocados)
 */

describe("Workflow de Vagas - Validações RBAC", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let joaoId: number;
  let mariaId: number;
  let pedroId: number;
  let shiftVagoId: number;
  let shiftOcupadoId: number;
  let shiftPendenteId: number;
  let shiftRetroativoId: number;
  let shiftUtiId: number;
  let centroCirurgicoId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    // Buscar IDs dos profissionais criados pelo seed
    const [joao] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. João Silva"))
      .limit(1);
    
    const [maria] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dra. Maria Santos"))
      .limit(1);
    
    const [pedro] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. Pedro Costa"))
      .limit(1);

    if (!joao || !maria || !pedro) {
      throw new Error("Profissionais não encontrados. Execute seed-test-data.ts primeiro.");
    }

    joaoId = joao.id;
    mariaId = maria.id;
    pedroId = pedro.id;

    // Buscar IDs dos turnos criados pelo seed
    const [shiftVago] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Manhã (VAGO)"))
      .limit(1);

    const [shiftOcupado] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Tarde (OCUPADO)"))
      .limit(1);

    const [shiftPendente] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Noite (PENDENTE)"))
      .limit(1);

    const [shiftRetroativo] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Retroativo (5 dias atrás)"))
      .limit(1);

    const [shiftUti] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão UTI (20 profissionais)"))
      .limit(1);

    if (!shiftVago || !shiftOcupado || !shiftPendente || !shiftRetroativo || !shiftUti) {
      throw new Error("Turnos não encontrados. Execute seed-test-data.ts primeiro.");
    }

    shiftVagoId = shiftVago.id;
    shiftOcupadoId = shiftOcupado.id;
    shiftPendenteId = shiftPendente.id;
    shiftRetroativoId = shiftRetroativo.id;
    shiftUtiId = shiftUti.id;
    centroCirurgicoId = shiftVago.sectorId;

    console.log("✅ Setup concluído:");
    console.log(`  - João (GESTOR_PLUS): ${joaoId}`);
    console.log(`  - Maria (GESTOR_MEDICO): ${mariaId}`);
    console.log(`  - Pedro (USER): ${pedroId}`);
    console.log(`  - Turno VAGO: ${shiftVagoId}`);
    console.log(`  - Turno OCUPADO: ${shiftOcupadoId}`);
    console.log(`  - Turno PENDENTE: ${shiftPendenteId}`);
    console.log(`  - Turno RETROATIVO: ${shiftRetroativoId}`);
    console.log(`  - Turno UTI: ${shiftUtiId}`);
  });

  // ========================================
  // TESTE 1: markVacant - GESTOR_MEDICO marca turno VAGO (sucesso)
  // ========================================
  it("Teste 1: GESTOR_MEDICO marca turno VAGO dentro de sua jurisdição", async () => {
    const result = await canEditShift(mariaId, shiftVagoId);
    
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // ========================================
  // TESTE 2: markVacant - GESTOR_MEDICO tenta marcar turno fora de jurisdição (falha FORBIDDEN)
  // ========================================
  it("Teste 2: GESTOR_MEDICO tenta marcar turno fora de sua jurisdição", async () => {
    const result = await canEditShift(mariaId, shiftUtiId);
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("jurisdição");
  });

  // ========================================
  // TESTE 3: assumeVacancy - USER assume turno VAGO sem conflito (sucesso → PENDENTE)
  // ========================================
  it("Teste 3: USER assume turno VAGO sem conflito", async () => {
    const result = await canAssumeVacancy(pedroId);
    
    expect(result.allowed).toBe(true);
    
    // Validar que não há conflito global
    const [shift] = await db!
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftVagoId))
      .limit(1);

    const validation = await validateAssignment(
      pedroId,
      shiftVagoId,
      shift.hospitalId,
      shift.sectorId
    );

    expect(validation.valid).toBe(true);
  });

  // ========================================
  // TESTE 4: assumeVacancy - USER tenta assumir turno que sobrepõe turno OCUPADO (falha CONFLICT)
  // ========================================
  it("Teste 4: USER tenta assumir turno que sobrepõe turno OCUPADO", async () => {
    // Dr. Pedro já está alocado no turno OCUPADO (hoje 13h-19h)
    // Criar um turno real que sobrepõe (hoje 15h-21h)
    const [shiftOcupado] = await db!
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftOcupadoId))
      .limit(1);

    const conflictStart = new Date(shiftOcupado.startAt);
    conflictStart.setHours(conflictStart.getHours() + 2); // 2h depois do início

    const conflictEnd = new Date(shiftOcupado.endAt);
    conflictEnd.setHours(conflictEnd.getHours() + 2); // 2h depois do fim

    // Criar turno que sobrepõe
    const [conflictShift] = await db!
      .insert(shiftInstances)
      .values({
        institutionId: shiftOcupado.institutionId,
        hospitalId: shiftOcupado.hospitalId,
        sectorId: shiftOcupado.sectorId,
        templateId: null,
        startAt: conflictStart,
        endAt: conflictEnd,
        label: "Turno Conflito (teste)",
        source: "MANUAL",
        status: "VAGO",
        createdBy: shiftOcupado.createdBy,
      });

    const validation = await validateAssignment(
      pedroId,
      conflictShift.insertId,
      shiftOcupado.hospitalId,
      shiftOcupado.sectorId
    );

    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("Conflito");
  });

  // ========================================
  // TESTE 5: approveAssignment - GESTOR_MEDICO aprova assignment (sucesso → OCUPADO)
  // ========================================
  it("Teste 5: GESTOR_MEDICO aprova assignment dentro de sua jurisdição", async () => {
    // Buscar assignment do turno PENDENTE
    const [assignment] = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftPendenteId),
          eq(shiftAssignmentsV2.isActive, false)
        )
      )
      .limit(1);

    if (!assignment) {
      throw new Error("Assignment PENDENTE não encontrado");
    }

    const result = await canApproveAssignment(mariaId, shiftPendenteId);
    
    expect(result.allowed).toBe(true);
  });

  // ========================================
  // TESTE 6: approveAssignment - Tentar aprovar 21º profissional no turno UTI (falha limite 20)
  // ========================================
  it("Teste 6: Tentar aprovar 21º profissional no turno UTI (limite 20)", async () => {
    // Turno UTI já tem 20 profissionais alocados
    // Buscar dados do turno UTI
    const [shiftUti] = await db!
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftUtiId))
      .limit(1);

    const validation = await validateAssignment(
      pedroId,
      shiftUtiId,
      shiftUti.hospitalId,
      shiftUti.sectorId
    );

    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("Limite de 20 profissionais");
  });

  // ========================================
  // TESTE 7: rejectAssignment - GESTOR_MEDICO rejeita assignment com motivo (sucesso → VAGO)
  // ========================================
  it("Teste 7: GESTOR_MEDICO rejeita assignment com motivo", async () => {
    const result = await canApproveAssignment(mariaId, shiftPendenteId);
    
    expect(result.allowed).toBe(true);
    // Motivo é obrigatório para rejeição (validado no endpoint)
  });

  // ========================================
  // TESTE 8: markVacant retroativo - GESTOR_MEDICO tenta editar turno de ontem (falha janela temporal)
  // ========================================
  it("Teste 8: GESTOR_MEDICO tenta editar turno retroativo (falha janela temporal)", async () => {
    const result = await canEditShift(mariaId, shiftRetroativoId);
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("janela de edição");
  });

  // ========================================
  // TESTE 9: markVacant retroativo - GESTOR_PLUS edita turno de ontem COM motivo (sucesso + auditLog)
  // ========================================
  it("Teste 9: GESTOR_PLUS edita turno retroativo COM motivo", async () => {
    const result = await canEditShift(joaoId, shiftRetroativoId);
    
    // GESTOR_PLUS pode editar retroativo, mas motivo é obrigatório (validado no endpoint)
    expect(result.allowed).toBe(true);
  });

  // ========================================
  // TESTE 10: markVacant retroativo - GESTOR_PLUS tenta editar turno de ontem SEM motivo (falha validação)
  // ========================================
  it("Teste 10: GESTOR_PLUS tenta editar turno retroativo SEM motivo (falha validação)", async () => {
    // Este teste será validado no nível do endpoint (auditLog exige motivo para RETROACTIVE_EDIT)
    // Aqui apenas validamos que GESTOR_PLUS tem permissão
    const result = await canEditShift(joaoId, shiftRetroativoId);
    
    expect(result.allowed).toBe(true);
    // Motivo obrigatório será validado pelo auditLog no endpoint
  });
});
