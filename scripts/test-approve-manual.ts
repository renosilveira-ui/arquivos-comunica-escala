/**
 * Script para simular aprovação manual de pendência
 * Simula Dra. Maria (GESTOR_MEDICO) aprovando assignment do Dr. Pedro
 */

import { getDb } from "../server/db";
import { shiftAssignmentsV2, shiftInstances, professionals } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { canApproveAssignment } from "../server/rbac-validations";
import { validateAssignment } from "../server/shift-validations";
import { auditLog } from "../server/audit-log";

async function testApproveManual() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  console.log("🧪 Teste Manual: Aprovar Pendência\n");

  // 1. Buscar Dra. Maria (GESTOR_MEDICO)
  const [maria] = await db
    .select()
    .from(professionals)
    .where(eq(professionals.name, "Dra. Maria Santos"))
    .limit(1);

  if (!maria) throw new Error("Dra. Maria não encontrada");
  console.log(`✅ Gestor: ${maria.name} (ID: ${maria.id}, Role: ${maria.userRole})`);

  // 2. Buscar assignment pendente
  const [assignment] = await db
    .select()
    .from(shiftAssignmentsV2)
    .where(eq(shiftAssignmentsV2.isActive, false))
    .limit(1);

  if (!assignment) throw new Error("Nenhuma pendência encontrada");
  console.log(`✅ Assignment ID: ${assignment.id}`);

  // 3. Buscar shift instance
  const [shiftInstance] = await db
    .select()
    .from(shiftInstances)
    .where(eq(shiftInstances.id, assignment.shiftInstanceId))
    .limit(1);

  if (!shiftInstance) throw new Error("Shift instance não encontrado");
  console.log(`✅ Turno: ${shiftInstance.label} (Status: ${shiftInstance.status})\n`);

  // 4. Validar permissão RBAC
  console.log("🔒 Validando permissão RBAC...");
  const permission = await canApproveAssignment(maria.id, shiftInstance.hospitalId, shiftInstance.sectorId);
  if (!permission.allowed) {
    console.error(`❌ FORBIDDEN: ${permission.reason}`);
    process.exit(1);
  }
  console.log(`✅ Permissão concedida: ${permission.reason}\n`);

  // 5. Validar conflito global
  console.log("🔍 Validando conflito global...");
  const validation = await validateAssignment(
    assignment.professionalId,
    assignment.shiftInstanceId,
    assignment.hospitalId,
    assignment.sectorId
  );
  if (!validation.valid) {
    console.error(`❌ CONFLICT: ${validation.error}`);
    process.exit(1);
  }
  console.log(`✅ Sem conflito global\n`);

  // 6. Aprovar assignment
  console.log("✅ Aprovando assignment...");
  await db
    .update(shiftAssignmentsV2)
    .set({ isActive: true })
    .where(eq(shiftAssignmentsV2.id, assignment.id));

  // 7. Atualizar status do turno para OCUPADO
  await db
    .update(shiftInstances)
    .set({ status: "OCUPADO" })
    .where(eq(shiftInstances.id, shiftInstance.id));

  // 8. Registrar audit log
  await auditLog({
    event: "ASSIGNMENT_APPROVED",
    shiftInstanceId: shiftInstance.id,
    professionalId: maria.id,
    reason: undefined,
    metadata: { assignmentId: assignment.id, approvedBy: maria.name }
  });

  console.log(`✅ Assignment aprovado!`);
  console.log(`✅ Turno mudou para OCUPADO`);
  console.log(`✅ Audit log registrado\n`);

  // 9. Conferir resultado final
  console.log("📊 Estado Final:");
  const [updatedAssignment] = await db
    .select()
    .from(shiftAssignmentsV2)
    .where(eq(shiftAssignmentsV2.id, assignment.id))
    .limit(1);

  const [updatedShift] = await db
    .select()
    .from(shiftInstances)
    .where(eq(shiftInstances.id, shiftInstance.id))
    .limit(1);

  console.log(`- Assignment is_active: ${updatedAssignment?.isActive}`);
  console.log(`- Turno status: ${updatedShift?.status}`);

  process.exit(0);
}

testApproveManual().catch((error) => {
  console.error("\n❌ Erro:", error);
  process.exit(1);
});
