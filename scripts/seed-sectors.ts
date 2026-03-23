/**
 * Script para popular os setores hospitalares
 * Sincronizado com HospitalAlert (23 setores)
 */

import { getDb } from "./db";
import { sectors, hospitals } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// NOTA: Execute seed-institutions.ts primeiro para criar hospital padrão

async function getSectorsData(hospitalId: number, institutionId: number) {
  return [
  // Internação (13 setores)
  { name: "UTI Térreo", category: "internacao" as const, color: "#DC2626", minStaffCount: 4 },
  { name: "UTI 1º Andar", category: "internacao" as const, color: "#DC2626", minStaffCount: 4 },
  { name: "UTI 2º Andar", category: "internacao" as const, color: "#DC2626", minStaffCount: 4 },
  { name: "Enfermaria Térreo", category: "internacao" as const, color: "#2563EB", minStaffCount: 3 },
  { name: "Enfermaria 1º Andar", category: "internacao" as const, color: "#2563EB", minStaffCount: 3 },
  { name: "Enfermaria 2º Andar", category: "internacao" as const, color: "#2563EB", minStaffCount: 3 },
  { name: "Pediatria Térreo", category: "internacao" as const, color: "#EC4899", minStaffCount: 3 },
  { name: "Pediatria 1º Andar", category: "internacao" as const, color: "#EC4899", minStaffCount: 3 },
  { name: "Maternidade Térreo", category: "internacao" as const, color: "#EC4899", minStaffCount: 3 },
  { name: "Maternidade 1º Andar", category: "internacao" as const, color: "#EC4899", minStaffCount: 3 },
  { name: "Isolamento Térreo", category: "internacao" as const, color: "#EAB308", minStaffCount: 2 },
  { name: "Isolamento 1º Andar", category: "internacao" as const, color: "#EAB308", minStaffCount: 2 },
  { name: "Isolamento 2º Andar", category: "internacao" as const, color: "#EAB308", minStaffCount: 2 },
  
  // Cirúrgico (2 setores)
  { name: "Centro Cirúrgico", category: "cirurgico" as const, color: "#EA580C", minStaffCount: 5 },
  { name: "Recuperação Pós-Anestésica", category: "cirurgico" as const, color: "#EA580C", minStaffCount: 3 },
  
  // Serviços (8 setores)
  { name: "Emergência", category: "servico" as const, color: "#DC2626", minStaffCount: 5 },
  { name: "Pronto Socorro", category: "servico" as const, color: "#DC2626", minStaffCount: 4 },
  { name: "Ambulatório", category: "servico" as const, color: "#16A34A", minStaffCount: 2 },
  { name: "Radiologia", category: "servico" as const, color: "#16A34A", minStaffCount: 2 },
  { name: "Laboratório", category: "servico" as const, color: "#16A34A", minStaffCount: 2 },
  { name: "Farmácia", category: "servico" as const, color: "#16A34A", minStaffCount: 2 },
  { name: "Recepção", category: "servico" as const, color: "#16A34A", minStaffCount: 2 },
  { name: "Administração", category: "servico" as const, color: "#16A34A", minStaffCount: 1 },
  ].map((sector) => ({ ...sector, hospitalId, institutionId }));
}

async function seed() {
  console.log("🌱 Populando setores hospitalares...");
  
  const db = await getDb();
  if (!db) {
    console.error("❌ Banco de dados não disponível");
    throw new Error("Database not available");
  }
  
  try {
    // Buscar hospital padrão
    const allHospitals = await db.select().from(hospitals);
    if (allHospitals.length === 0) {
      console.error("❌ Nenhum hospital encontrado. Execute seed-institutions.ts primeiro.");
      throw new Error("No hospitals found. Run seed-institutions.ts first.");
    }
    
    for (const hospital of allHospitals) {
      console.log(`📍 Processando hospital ID: ${hospital.id} (${hospital.name})`);

      const existingSectors = await db
        .select()
        .from(sectors)
        .where(eq(sectors.hospitalId, hospital.id));

      if (existingSectors.length > 0) {
        console.log(`⏭️  ${existingSectors.length} setores já existem para ${hospital.name}. Pulando.`);
        continue;
      }

      const sectorsData = await getSectorsData(hospital.id, hospital.institutionId);
      await db.insert(sectors).values(sectorsData);
      console.log(`✅ ${sectorsData.length} setores cadastrados para ${hospital.name}`);
    }

    const allSectors = await db.select().from(sectors);
    console.log(`\n📋 Total de setores cadastrados: ${allSectors.length}`);
    
  } catch (error) {
    console.error("❌ Erro ao popular setores:", error);
    throw error;
  }
}

seed()
  .then(() => {
    console.log("\n✅ Seed concluído!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Erro no seed:", error);
    process.exit(1);
  });
