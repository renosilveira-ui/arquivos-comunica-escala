import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "../server/db";
import { professionals, shiftInstances, shiftAssignmentsV2, users, managerScope } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";

/**
 * Testes RBAC para approveAssignment e rejectAssignment
 * 
 * Cenários:
 * 1. USER comum tenta aprovar → deve falhar (FORBIDDEN)
 * 2. GESTOR_MEDICO fora do escopo tenta aprovar → deve falhar (FORBIDDEN)
 * 3. GESTOR_MEDICO dentro do escopo aprova → sucesso (200 OK)
 * 4. GESTOR_PLUS aprova sempre → sucesso (200 OK)
 */

describe("RBAC - Aprovação de Alocações", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let userComumId: number;
  let gestorMedicoId: number;
  let gestorPlusId: number;
  let pendingAssignmentId: number;
  let shiftInstanceId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    // Buscar profissionais do seed
    const [userComum] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. Pedro Costa"));

    const [gestorMedico] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dra. Maria Santos"));

    const [gestorPlus] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. João Silva"));

    if (!userComum || !gestorMedico || !gestorPlus) {
      throw new Error("Profissionais do seed não encontrados. Execute seed-test-data.ts primeiro.");
    }

    userComumId = userComum.id;
    gestorMedicoId = gestorMedico.id;
    gestorPlusId = gestorPlus.id;

    // Buscar assignment pendente do seed
    const [pendingAssignment] = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.isActive, false));

    if (!pendingAssignment) {
      throw new Error("Nenhum assignment pendente encontrado. Execute seed-test-data.ts primeiro.");
    }

    pendingAssignmentId = pendingAssignment.id;
    shiftInstanceId = pendingAssignment.shiftInstanceId;

    console.log("\n=== RBAC Test Setup ===");
    console.log(`USER comum: ${userComum.name} (ID: ${userComumId})`);
    console.log(`GESTOR_MEDICO: ${gestorMedico.name} (ID: ${gestorMedicoId})`);
    console.log(`GESTOR_PLUS: ${gestorPlus.name} (ID: ${gestorPlusId})`);
    console.log(`Pending Assignment ID: ${pendingAssignmentId}`);
    console.log(`Shift Instance ID: ${shiftInstanceId}`);
  });

  it("Teste 1: USER comum tenta aprovar → 403 FORBIDDEN", async () => {
    if (!db) throw new Error("Database not available");

    const { canApproveAssignment } = await import("../server/rbac-validations");

    const permission = await canApproveAssignment(userComumId, shiftInstanceId);

    expect(permission.allowed).toBe(false);
    expect(permission.reason).toContain("gestores");
    
    console.log("\n✅ Teste 1 PASSOU: USER comum bloqueado");
    console.log(`   Motivo: ${permission.reason}`);
  });

  it("Teste 2: GESTOR_MEDICO fora do escopo tenta aprovar → 403 FORBIDDEN", async () => {
    if (!db) throw new Error("Database not available");

    // Buscar turno de outro setor (não Centro Cirúrgico)
    const [outOfScopeShift] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, "Plantão Manhã (hoje)"));

    if (!outOfScopeShift) {
      console.log("⚠️  Teste 2 PULADO: Turno fora do escopo não encontrado");
      return;
    }

    const { canApproveAssignment } = await import("../server/rbac-validations");

    const permission = await canApproveAssignment(gestorMedicoId, outOfScopeShift.id);

    expect(permission.allowed).toBe(false);
    expect(permission.reason).toContain("jurisdição");

    console.log("\n✅ Teste 2 PASSOU: GESTOR_MEDICO bloqueado fora do escopo");
    console.log(`   Motivo: ${permission.reason}`);
  });

  it("Teste 3: GESTOR_MEDICO dentro do escopo aprova → 200 OK", async () => {
    if (!db) throw new Error("Database not available");

    const { canApproveAssignment } = await import("../server/rbac-validations");

    const permission = await canApproveAssignment(gestorMedicoId, shiftInstanceId);

    expect(permission.allowed).toBe(true);

    console.log("\n✅ Teste 3 PASSOU: GESTOR_MEDICO aprovado dentro do escopo");
  });

  it("Teste 4: GESTOR_PLUS aprova sempre → 200 OK", async () => {
    if (!db) throw new Error("Database not available");

    const { canApproveAssignment } = await import("../server/rbac-validations");

    const permission = await canApproveAssignment(gestorPlusId, shiftInstanceId);

    expect(permission.allowed).toBe(true);

    console.log("\n✅ Teste 4 PASSOU: GESTOR_PLUS aprovado (poder total)");
  });
});
