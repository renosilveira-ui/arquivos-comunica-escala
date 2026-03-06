import { db } from "../server/_core/db";
import { shiftAssignments } from "../shared/schema";
import { eq } from "drizzle-orm";

async function main() {
  const pending = await db
    .select()
    .from(shiftAssignments)
    .where(eq(shiftAssignments.status, "PENDING"));

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
