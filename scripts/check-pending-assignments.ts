import { getDb } from "../server/db";
import { shiftAssignmentsV2 } from "../drizzle/schema";
import { eq } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const pending = await db
    .select()
    .from(shiftAssignmentsV2)
    .where(eq(shiftAssignmentsV2.isActive, true));

  console.log(`\n📋 Pendências no banco: ${pending.length}\n`);

  if (pending.length > 0) {
    console.log(JSON.stringify(pending, null, 2));
  } else {
    console.log("❌ Nenhuma pendência encontrada no banco!");
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Erro ao verificar pendências:", error);
  process.exit(1);
});
