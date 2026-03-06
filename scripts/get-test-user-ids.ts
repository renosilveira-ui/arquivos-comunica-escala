/**
 * Script para consultar IDs dos profissionais de teste
 */

import { getDb } from "../server/db";
import { professionals } from "../drizzle/schema";
import { inArray } from "drizzle-orm";

async function getTestUserIds() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const testProfessionals = await db
    .select()
    .from(professionals)
    .where(
      inArray(professionals.name, [
        "Dr. João Silva",
        "Dra. Maria Santos",
        "Dr. Pedro Costa",
        "Dra. Ana Lima",
      ])
    );

  console.log("\n📋 Profissionais de Teste:");
  console.log("=".repeat(80));
  
  testProfessionals.forEach((prof) => {
    console.log(`${prof.name.padEnd(20)} | user_id: ${String(prof.userId).padEnd(8)} | role: ${prof.userRole}`);
  });
  
  console.log("=".repeat(80));
  console.log("\n🔗 URLs de Teste:");
  console.log("=".repeat(80));
  
  const baseUrl = "https://8081-i9qy13u7pdk6hjzny55mc-38f70283.us2.manus.computer";
  
  testProfessionals.forEach((prof) => {
    const roleEmoji = {
      GESTOR_PLUS: "👑",
      GESTOR_MEDICO: "👨‍⚕️",
      USER: "👤",
    }[prof.userRole] || "❓";
    
    console.log(`${roleEmoji} ${prof.name}:`);
    console.log(`   ${baseUrl}?testUserId=${prof.userId}\n`);
  });
  
  console.log("=".repeat(80));
  
  process.exit(0);
}

getTestUserIds().catch((error) => {
  console.error("Erro:", error);
  process.exit(1);
});
