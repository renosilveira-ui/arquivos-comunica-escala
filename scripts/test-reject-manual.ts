/**
 * Script para simular rejeição manual de pendência
 * 1. Criar nova pendência (Dr. Pedro assume turno VAGO)
 * 2. Dra. Maria rejeita
 * 3. Conferir turno volta para VAGO
 */

import { getDb } from "../server/db";
import { shiftAssignmentsV2, shiftInstances, professionals } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { canApproveAssignment } from "../server/rbac-validations";
import { auditLog } from "../server/audit-log";

async function testRejectManual() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  console.log("🧪 Teste Manual: Rejeitar Pendência\n");

  // 1. Buscar Dra. Maria (GESTOR_MEDICO)
  const [maria] = await db
    .select()
    .from(professionals)
    .where(eq(professionals.name, "Dra. Maria Santos"))
    .limit(1);

  if (!maria) throw new Error("Dra. Maria não encontrada");
  console.log(`✅ Gestor: ${maria.name} (ID: ${maria.id})`);

  // 2. Buscar Dr. Pedro
  const [pedro] = await db
    .select()
    .from(professionals)
    .where(eq(professionals.name, "Dr. Pedro Costa"))
    .limit(1);

  if (!pedro) throw new Error("Dr. Pedro não encontrado");
  console.log(`✅ Profissional: ${pedro.name} (ID: ${pedro.id})`);

  // 3. Buscar turno VAGO
  const [vagoShift] = await db
    .select()
    .from(shiftInstances)
    .where(eq(shiftInstances.status, "VAGO"))
    .limit(1);

  if (!vagoShift) throw new Error("Nenhum turno VAGO encontrado");
  console.log(`✅ Turno VAGO: ${vagoShift.label} (ID: ${vagoShift.id})\n`);

  // 4. Criar pendência (Dr. Pedro assume turno VAGO)
  console.log("📝 Criando pendência...");
  const [newAssignment] = await db
    .insert(shiftAssignmentsV2)
    .values({
      shiftInstanceId: vagoShift.id,
      institutionId: vagoShift.institutionId,
      hospitalId: vagoShift.hospitalId,
      sectorId: vagoShift.sectorId,
      professionalId: pedro.id,
      assignmentType: "ON_DUTY",
      isActive: false, // Pendente
      createdBy: pedro.userId,
    })
    .$returningId();

  // Atualizar status do turno para PENDENTE
  await db
    .update(shiftInstances)
    .set({ status: "PENDENTE" })
    .where(eq(shiftInstances.id, vagoShift.id));

  console.log(`✅ Pendência criada (Assignment ID: ${newAssignment.id})`);
  console.log(`✅ Turno mudou para PENDENTE\n`);

  // 5. Validar permissão RBAC
  console.log("🔒 Validando permissão RBAC...");
  const permission = await canApproveAssignment(maria.id, vagoShift.hospitalId, vagoShift.sectorId);
  if (!permission.allowed) {
    console.error(`❌ FORBIDDEN: ${permission.reason}`);
    process.exit(1);
  }
  console.log(`✅ Permissão concedida\n`);

  // 6. Rejeitar assignment
  console.log("❌ Rejeitando assignment...");
  await db
    .delete(shiftAssignmentsV2)
    .where(eq(shiftAssignmentsV2.id, newAssignment.id));

  // 7. Atualizar status do turno para VAGO
  await db
    .update(shiftInstances)
    .set({ status: "VAGO" })
    .where(eq(shiftInstances.id, vagoShift.id));

  // 8. Registrar audit log
  await auditLog({
    event: "ASSIGNMENT_REJECTED",
    shiftInstanceId: vagoShift.id,
    professionalId: maria.id,
    reason: "Profissional não atende requisitos",
    metadata: { assignmentId: newAssignment.id, rejectedBy: maria.name }
  });

  console.log(`✅ Assignment rejeitado!`);
  console.log(`✅ Turno voltou para VAGO`);
  console.log(`✅ Audit log registrado\n`);

  // 9. Conferir resultado final
  console.log("📊 Estado Final:");
  const [finalShift] = await db
    .select()
    .from(shiftInstances)
    .where(eq(shiftInstances.id, vagoShift.id))
    .limit(1);

  const deletedAssignment = await db
    .select()
    .from(shiftAssignmentsV2)
    .where(eq(shiftAssignmentsV2.id, newAssignment.id))
    .limit(1);

  console.log(`- Turno status: ${finalShift?.status}`);
  console.log(`- Assignment deletado: ${deletedAssignment.length === 0 ? "Sim" : "Não"}`);

  process.exit(0);
}

testRejectManual().catch((error) => {
  console.error("\n❌ Erro:", error);
  process.exit(1);
});
