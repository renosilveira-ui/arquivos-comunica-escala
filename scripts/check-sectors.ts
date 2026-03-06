import { getDb } from "./db";
import { sectors } from "../drizzle/schema";

async function checkSectors() {
  const db = await getDb();
  if (!db) {
    console.error("❌ Database not available");
    process.exit(1);
  }

  const allSectors = await db.select().from(sectors);
  console.log(`\n📋 Setores cadastrados: ${allSectors.length}\n`);
  
  allSectors.forEach((s, i) => {
    console.log(`${i + 1}. ${s.name} (${s.category}) - ${s.color}`);
  });
  
  console.log("\n✅ Verificação concluída!");
  process.exit(0);
}

checkSectors();
