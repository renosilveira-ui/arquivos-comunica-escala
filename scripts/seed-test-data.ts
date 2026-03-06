 * Seed de Dados de Teste para Workflow de Vagas
 * 
 * Cria 4 profissionais com roles diferentes e casos de teste:
 * - Dr. João Silva (GESTOR_PLUS) - poder total
 * - Dra. Maria Santos (GESTOR_MEDICO) - jurisdição Centro Cirúrgico
 * - Dr. Pedro Costa (USER) - profissional comum
 * - Dra. Ana Lima (USER) - profissional comum (para testar FORBIDDEN)
 * 
 * Casos de teste:
 * 1. Turno VAGO (amanhã 7h-13h) - para testar assumeVacancy
 * 2. Turno OCUPADO (hoje 13h-19h, Dr. Pedro) - para testar conflito
 * 3. Turno PENDENTE (amanhã 19h-7h, Dr. Pedro aguardando aprovação)
 * 4. Turno RETROATIVO (ontem 7h-13h) - para testar janela temporal
 * 5. Setor com 20 profissionais - para testar limite
 */

import { getDb } from "./db";
import {
  institutions,
  hospitals,
  sectors,
  professionals,
  professionalAccess,
  managerScope,
  shiftInstances,
  shiftAssignmentsV2,
} from "../drizzle/schema";
import { eq } from "drizzle-orm";

export async function seedTestData() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  console.log("🌱 Iniciando seed de dados de teste...");

  // 0. Limpar dados de teste anteriores
  console.log("🧹 Limpando dados de teste anteriores...");
  
  // Deletar assignments primeiro (foreign keys)
  await db.execute("DELETE FROM shift_assignments_v2 WHERE professional_id IN (SELECT id FROM professionals WHERE name IN ('Dr. João Silva', 'Dra. Maria Santos', 'Dr. Pedro Costa', 'Dra. Ana Lima'))");
  
  // Deletar turnos de teste
  await db.execute("DELETE FROM shift_instances WHERE label LIKE '%VAGO%' OR label LIKE '%OCUPADO%' OR label LIKE '%PENDENTE%' OR label LIKE '%Retroativo%' OR label LIKE '%UTI%'");
  
  // Deletar permissões de acesso
  await db.execute("DELETE FROM professional_access WHERE professional_id IN (SELECT id FROM professionals WHERE name IN ('Dr. João Silva', 'Dra. Maria Santos', 'Dr. Pedro Costa', 'Dra. Ana Lima'))");
  
  // Deletar manager_scope
  await db.execute("DELETE FROM manager_scope WHERE manager_professional_id IN (SELECT id FROM professionals WHERE name IN ('Dr. João Silva', 'Dra. Maria Santos', 'Dr. Pedro Costa', 'Dra. Ana Lima'))");
  
  // Deletar profissionais de teste
  await db.execute("DELETE FROM professionals WHERE name IN ('Dr. João Silva', 'Dra. Maria Santos', 'Dr. Pedro Costa', 'Dra. Ana Lima')");
  
  console.log("✅ Dados de teste anteriores limpos!");

  // 1. Buscar instituição e hospital existentes
  const [institution] = await db.select().from(institutions).limit(1);
  if (!institution) {
    throw new Error("Nenhuma instituição encontrada. Execute seed-institutions.ts primeiro.");
  }

  const [hospital] = await db
    .select()
    .from(hospitals)
    .where(eq(hospitals.institutionId, institution.id))
    .limit(1);
  if (!hospital) {
    throw new Error("Nenhum hospital encontrado. Execute seed-institutions.ts primeiro.");
  }

  // 2. Buscar setor Centro Cirúrgico
  const [sector] = await db
    .select()
    .from(sectors)
    .where(eq(sectors.name, "Centro Cirúrgico"))
    .limit(1);
  if (!sector) {
    throw new Error("Setor Centro Cirúrgico não encontrado.");
  }

  console.log(`✅ Instituição: ${institution.name}`);
  console.log(`✅ Hospital: ${hospital.name}`);
  console.log(`✅ Setor: ${sector.name}`);

  // 3. Criar users primeiro (necessário para foreign key)
  console.log("\n👤 Criando users...");
  
  const { users } = await import("../drizzle/schema");

  // Verificar se users já existem
  const existingUsers = await db.select().from(users).limit(4);
  
  let user1Id, user2Id, user3Id, user4Id;
  
  if (existingUsers.length >= 4) {
    user1Id = existingUsers[0].id;
    user2Id = existingUsers[1].id;
    user3Id = existingUsers[2].id;
    user4Id = existingUsers[3].id;