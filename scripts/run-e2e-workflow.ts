/**
 * E2E Workflow Test Runner
 * 
 * Executa fluxo completo USER → GESTOR sem SQL manual
 * Usage: pnpm e2e:workflow
 */

import { getDb } from "../server/db.js";
import { appRouter } from "../server/routers.js";
import {
  shiftInstances,
  shiftAssignmentsV2,
  shiftAuditLog,
  professionals,
  institutions,
  hospitals,
  sectors,
  managerScope,
} from "../drizzle/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { getOrCreateShiftInstanceId, GET_OR_CREATE_SHIFT_VERSION } from "../server/helpers/getOrCreateShiftInstanceId.js";

const USER_ID = 30003;
const GESTOR_ID = 30001;

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    log(`❌ FAIL: ${message}`, "red");
    throw new Error(`Assertion failed: ${message}`);
  }
  log(`✅ PASS: ${message}`, "green");
}

function isConflictError(err: any): boolean {
  const msg = (err?.message || "").toLowerCase();
  const code = err?.data?.code || err?.shape?.data?.code;
  return (
    code === "CONFLICT" ||
    msg.includes("conflito") ||
    msg.includes("overlap") ||
    msg.includes("já está alocado") ||
    msg.includes("already allocated")
  );
}

async function createCaller(userId: number) {
  return appRouter.createCaller({
    user: { id: userId } as any,
    req: {} as any,
    res: {} as any,
  });
}

async function main() {
  log("\n🧪 Starting E2E Workflow Test", "cyan");
  log("=".repeat(60), "cyan");

  try {
    const db = await getDb();
    
    if (!db) {
      throw new Error("Database connection failed");
    }
    
    log("\n📋 PASSO A: Preparar cenário", "blue");

    const [institution] = await db.select().from(institutions).limit(1);
    const [hospital] = await db.select().from(hospitals).limit(1);
    const [sector] = await db.select().from(sectors).limit(1);

    assert(!!institution, "Institution exists");
    assert(!!hospital, "Hospital exists");
    assert(!!sector, "Sector exists");

    const [userProfessional] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, USER_ID))
      .limit(1);

    const [gestorProfessional] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, GESTOR_ID))
      .limit(1);

    assert(!!userProfessional, "USER professional exists");
    assert(!!gestorProfessional, "GESTOR professional exists");

    // Limpar turnos PENDENTE e assignments de testes anteriores
    const testShifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(sql`label LIKE 'E2E Test%'`);
    
    const testShiftIds = testShifts.map(s => s.id);
    
    if (testShiftIds.length > 0) {
      // Deletar assignments dos turnos de teste
      await db
        .delete(shiftAssignmentsV2)
        .where(sql`shift_instance_id IN (${sql.join(testShiftIds, sql`, `)})`);
      
      // Resetar status dos turnos para VAGO
      await db
        .update(shiftInstances)
        .set({ status: "VAGO" })
        .where(sql`label LIKE 'E2E Test%'`);
      
      log("  🧽 Cleaned assignments and PENDENTE shifts from previous tests");
    }

    // Criar manager_scope para o GESTOR_MEDICO ANTES de criar vagas
    const existingScope = await db
      .select()
      .from(managerScope)
      .where(
        and(
          eq(managerScope.managerProfessionalId, gestorProfessional.id),
          eq(managerScope.sectorId, sector.id)
        )
      )
      .limit(1);

    if (!existingScope[0]) {
      await db.insert(managerScope).values({
        managerProfessionalId: gestorProfessional.id,
        hospitalId: hospital.id,
        sectorId: sector.id, // Permissão sector-level (setor específico)
        active: true,
        createdAt: new Date(),
      });
      log(`  ✅ Created manager_scope for GESTOR (professionalId: ${gestorProfessional.id}, sectorId: ${sector.id})`);
    } else {
      log(`  ⏭️  Manager_scope already exists for GESTOR`);
    }

    // DEBUG: Imprimir IDs para validar alinhamento
    log("\n🔍 DEBUG: Seed IDs", "cyan");
    log(`  seedSectorId: ${sector.id}`, "cyan");
    log(`  seedHospitalId: ${hospital.id}`, "cyan");
    log(`  managerScopeSectorId: ${sector.id}`, "cyan");
    log(`  gestorProfessionalId: ${gestorProfessional.id}`, "cyan");

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const shifts = [
      { label: "E2E Test - Manhã", startHour: 7, endHour: 13 },
      { label: "E2E Test - Tarde", startHour: 13, endHour: 19 },
    ];

    const createdShiftIds: number[] = [];

    for (const shift of shifts) {
      const startAt = new Date(today);
      startAt.setHours(shift.startHour, 0, 0, 0);

      const endAt = new Date(today);
      endAt.setHours(shift.endHour, 0, 0, 0);

      const existing = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.label, shift.label))
        .limit(1);

      if (existing[0]) {
        log(`  ⏭️  Shift "${shift.label}" already exists (ID: ${existing[0].id})`);
        createdShiftIds.push(existing[0].id);
        continue;
      }

      await db.insert(shiftInstances).values({
        institutionId: institution.id,
        hospitalId: hospital.id,
        sectorId: sector.id,
        label: shift.label,
        status: "VAGO",
        startAt,
        endAt,
        createdBy: GESTOR_ID,
        createdAt: new Date(),
      });

      const [created] = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.label, shift.label))
        .limit(1);

      log(`  ✅ Created shift "${shift.label}" (ID: ${created.id})`);
      createdShiftIds.push(created.id);
    }

    assert(createdShiftIds.length === 2, "2 VAGO shifts created");

    log("\n📋 PASSO B: USER assume vaga", "blue");

    const userCaller = await createCaller(USER_ID);
    const shiftToAssume = createdShiftIds[0];

    log(`  Assuming shift ID: ${shiftToAssume}`);

    const assumeResult = await userCaller.shiftAssignments.assumeVacancy({
      shiftInstanceId: shiftToAssume,
    });

    assert(!!assumeResult, "assumeVacancy returned result");

    const [shiftAfterAssume] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftToAssume))
      .limit(1);

    assert(
      shiftAfterAssume.status === "PENDENTE",
      "Shift status is PENDENTE after assume"
    );

    const auditVacancyRequested = await db
      .select()
      .from(shiftAuditLog)
      .where(
        and(
          eq(shiftAuditLog.shiftInstanceId, shiftToAssume),
          eq(shiftAuditLog.event, "VACANCY_REQUESTED")
        )
      )
      .limit(1);

    assert(
      auditVacancyRequested.length > 0,
      "Audit log contains VACANCY_REQUESTED"
    );

    log("\n📋 PASSO C: GESTOR vê pendência", "blue");

    const gestorCaller = await createCaller(GESTOR_ID);

    const pendingList = await gestorCaller.shiftAssignments.listPending();

    assert(pendingList.length > 0, "GESTOR sees pending assignments");

    const pendingAssignment = pendingList.find(
      (p: any) => p.shiftInstanceId === shiftToAssume
    );

    assert(!!pendingAssignment, "Pending assignment found in list");

    log("\n📋 PASSO D: GESTOR aprova", "blue");

    await gestorCaller.shiftInstances.approveAssignment({
      assignmentId: (pendingAssignment as any).assignmentId,
      professionalId: gestorProfessional.id, // Quem está aprovando (GESTOR)
    });

    const [shiftAfterApprove] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftToAssume))
      .limit(1);

    assert(
      shiftAfterApprove.status === "OCUPADO",
      "Shift status is OCUPADO after approve"
    );

    const auditApproved = await db
      .select()
      .from(shiftAuditLog)
      .where(
        and(
          eq(shiftAuditLog.shiftInstanceId, shiftToAssume),
          eq(shiftAuditLog.event, "ASSIGNMENT_APPROVED")
        )
      )
      .limit(1);

    assert(auditApproved.length > 0, "Audit log contains ASSIGNMENT_APPROVED");

    log("\n📋 PASSO E: Teste de rejeição", "blue");

    const shiftToReject = createdShiftIds[1];

    const assumeResult2 = await userCaller.shiftAssignments.assumeVacancy({
      shiftInstanceId: shiftToReject,
    });

    assert(!!assumeResult2, "Second assumeVacancy returned result");

    await gestorCaller.shiftInstances.rejectAssignment({
      assignmentId: assumeResult2.assignmentId,
      professionalId: gestorProfessional.id, // Quem está rejeitando (GESTOR)
      reason: "Teste de rejeição E2E",
    });

    const [shiftAfterReject] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftToReject))
      .limit(1);

    assert(
      shiftAfterReject.status === "VAGO",
      "Shift status is VAGO after reject"
    );

    const auditRejected = await db
      .select()
      .from(shiftAuditLog)
      .where(
        and(
          eq(shiftAuditLog.shiftInstanceId, shiftToReject),
          eq(shiftAuditLog.event, "ASSIGNMENT_REJECTED")
        )
      )
      .limit(1);

    assert(
      auditRejected.length > 0,
      "Audit log contains ASSIGNMENT_REJECTED"
    );

    log("\n📍 PASSO F: Teste de conflito global", "blue");

    // Criar 2 turnos no mesmo horário em hospitais diferentes
    const conflictStartAt = new Date();
    conflictStartAt.setHours(14, 0, 0, 0); // 14h
    const conflictEndAt = new Date();
    conflictEndAt.setHours(18, 0, 0, 0); // 18h

    // Buscar segundo hospital/setor para conflito
    const [conflictHospital] = await db
      .select()
      .from(hospitals)
      .where(eq(hospitals.institutionId, institution.id))
      .limit(1);

    const [conflictSector] = await db
      .select()
      .from(sectors)
      .where(eq(sectors.hospitalId, conflictHospital.id))
      .limit(1);

    // Usar getOrCreateShiftInstanceId para criar turnos de forma determinística
    const { conflictShiftAId, conflictShiftBId } = await db.transaction(async (tx: any) => {
      const conflictShiftAId = await getOrCreateShiftInstanceId(tx, {
        institutionId: institution.id,
        hospitalId: hospital.id,
        sectorId: sector.id,
        startAt: conflictStartAt,
        endAt: conflictEndAt,
        label: "E2E Test - Conflito A",
        createdBy: GESTOR_ID,
      });

      const conflictShiftBId = await getOrCreateShiftInstanceId(tx, {
        institutionId: institution.id,
        hospitalId: conflictHospital.id,
        sectorId: conflictSector.id,
        startAt: conflictStartAt,
        endAt: conflictEndAt,
        label: "E2E Test - Conflito B",
        createdBy: GESTOR_ID,
      });

      return { conflictShiftAId, conflictShiftBId };
    });

    log(`  Shift A (Hospital ${hospital.id}): ${conflictShiftAId}`);
    log(`  Shift B (Hospital ${conflictHospital.id}): ${conflictShiftBId}`);
    log(`  ✅ Turnos criados com lookup determinístico (repetível)`, "cyan");

    // USER assume vaga A
    const conflictAssumeA = await userCaller.shiftAssignments.assumeVacancy({
      shiftInstanceId: conflictShiftAId,
    });

    assert(!!conflictAssumeA, "USER assumed shift A");

    // GESTOR aprova vaga A
    await gestorCaller.shiftInstances.approveAssignment({
      assignmentId: conflictAssumeA.assignmentId,
      professionalId: gestorProfessional.id,
    });

    const [conflictShiftAAfterApprove] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, conflictShiftAId))
      .limit(1);

    assert(
      conflictShiftAAfterApprove.status === "OCUPADO",
      "Shift A is OCUPADO after approve"
    );

    // Tentar USER assumir vaga B no mesmo horário (deve falhar)
    let conflictBlocked = false;
    try {
      await userCaller.shiftAssignments.assumeVacancy({
        shiftInstanceId: conflictShiftBId,
      });
      log(
        "  ⚠️  Sistema permitiu assumeVacancy em conflito; validando bloqueio no approve...",
        "cyan"
      );
    } catch (err: any) {
      if (isConflictError(err)) {
        conflictBlocked = true;
        log(
          "  ✅ Conflito global bloqueado no assumeVacancy",
          "green"
        );
      } else {
        throw new Error(
          `Erro ao assumir vaga B não parece CONFLICT: ${err?.message || err}`
        );
      }
    }

    if (!conflictBlocked) {
      // Se criou PENDENTE, tentar aprovar (deve falhar)
      const conflictAssumeB = await userCaller.shiftAssignments.assumeVacancy({
        shiftInstanceId: conflictShiftBId,
      });

      try {
        await gestorCaller.shiftInstances.approveAssignment({
          assignmentId: conflictAssumeB.assignmentId,
          professionalId: gestorProfessional.id,
        });
        throw new Error(
          "approveAssignment da vaga B deveria ter falhado por conflito global"
        );
      } catch (err: any) {
        assert(
          isConflictError(err),
          `approveAssignment da vaga B falhou com CONFLICT: ${err?.message}`
        );
        log(
          "  ✅ Conflito global bloqueado no approveAssignment",
          "green"
        );
      }
    }

    // Validar que vaga A continua OCUPADO e vaga B não virou OCUPADO
    const [finalShiftA] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, conflictShiftAId))
      .limit(1);

    const [finalShiftB] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.id, conflictShiftBId))
      .limit(1);

    assert(
      finalShiftA.status === "OCUPADO",
      "Shift A continues OCUPADO after conflict test"
    );
    assert(
      finalShiftB.status !== "OCUPADO",
      "Shift B did not become OCUPADO (conflict blocked)"
    );

    log("\n" + "=".repeat(60), "cyan");
    log("🎉 ALL TESTS PASSED!", "green");
    log("=".repeat(60), "cyan");

    process.exit(0);
  } catch (error: any) {
    log("\n" + "=".repeat(60), "red");
    log(`❌ TEST FAILED: ${error.message}`, "red");
    log("=".repeat(60), "red");

    if (error.stack) {
      console.error(error.stack);
    }

    process.exit(1);
  }
}

main();
