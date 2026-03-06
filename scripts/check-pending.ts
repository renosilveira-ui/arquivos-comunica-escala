/**
 * Script para verificar pendências no banco de dados
 */

import { getDb } from "../server/db";
import { shiftAssignmentsV2, shiftInstances, professionals } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";

async function checkPending() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const pendingAssignments = await db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
      professionalName: professionals.name,
      shiftLabel: shiftInstances.label,
      shiftStatus: shiftInstances.status,
      isActive: shiftAssignmentsV2.isActive,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
    .innerJoin(professionals, eq(shiftAssignmentsV2.professionalId, professionals.id))
    .where(
      and(
        eq(shiftAssignmentsV2.isActive, false),
        eq(shiftInstances.status, "PENDENTE")
      )
    );

  console.log("\n📋 Pendências no Banco de Dados:");
  console.log("=".repeat(80));
  
  if (pendingAssignments.length === 0) {
    console.log("❌ Nenhuma pendência encontrada!");
    console.log("\n💡 Execute este comando para criar uma pendência:");
    console.log("   pnpm tsx server/seed-test-data.ts");
  } else {
    console.log(`✅ ${pendingAssignments.length} pendência(s) encontrada(s):\n`);
    
    pendingAssignments.forEach((pending, index) => {
      console.log(`${index + 1}. Assignment ID: ${pending.assignmentId}`);
      console.log(`   Profissional: ${pending.professionalName}`);
      console.log(`   Turno: ${pending.shiftLabel}`);
      console.log(`   Status: ${pending.shiftStatus}`);
      console.log(`   is_active: ${pending.isActive ? "true" : "false"}`);
      console.log("");
    });
  }
  
  console.log("=".repeat(80));
  
  process.exit(0);
}

checkPending().catch((error) => {
  console.error("Erro:", error);
  process.exit(1);
});
