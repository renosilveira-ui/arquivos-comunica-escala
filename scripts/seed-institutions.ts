/**
 * Script para popular instituições e hospitais padrão
 * Necessário antes de popular setores
 */

import { getDb } from "./db";
import { institutions, hospitals } from "../drizzle/schema";

async function seed() {
  console.log("🌱 Populando instituições e hospitais...");
  
  const db = await getDb();
  if (!db) {
    console.error("❌ Banco de dados não disponível");
    throw new Error("Database not available");
  }
  
  try {
    // Verificar se já existem instituições
    const existingInstitutions = await db.select().from(institutions);
    
    if (existingInstitutions.length > 0) {
      console.log(`✅ ${existingInstitutions.length} instituições já cadastradas. Pulando seed.`);
      return;
    }
    
    // Inserir instituição padrão
    const [institution] = await db.insert(institutions).values({
      name: "Hospital Santa Cruz",
    });
    
    console.log(`✅ Instituição criada: Hospital Santa Cruz (ID: ${institution.insertId})`);
    
    // Inserir hospital padrão
    const [hospital] = await db.insert(hospitals).values({
      institutionId: institution.insertId,
      name: "Hospital Santa Cruz - Unidade Principal",
      address: "Rua Principal, 123 - São Paulo, SP",
    });
    
    console.log(`✅ Hospital criado: Hospital Santa Cruz - Unidade Principal (ID: ${hospital.insertId})`);
    
    // Retornar IDs para uso posterior
    return {
      institutionId: institution.insertId,
      hospitalId: hospital.insertId,
    };
    
  } catch (error) {
    console.error("❌ Erro ao popular instituições:", error);
    throw error;
  }
}

seed()
  .then((result) => {
    console.log("\n✅ Seed de instituições concluído!");
    if (result) {
      console.log(`Institution ID: ${result.institutionId}`);
      console.log(`Hospital ID: ${result.hospitalId}`);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Erro no seed:", error);
    process.exit(1);
  });
