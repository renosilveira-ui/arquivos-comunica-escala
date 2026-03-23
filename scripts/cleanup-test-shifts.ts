import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "./db";

const TEST_LABELS = [
  "Plantão Manhã (VAGO)",
  "Plantão Tarde (OCUPADO)",
  "Plantão Noite (PENDENTE)",
  "Plantão Retroativo (5 dias atrás)",
  "Plantão UTI (20 profissionais)",
  "Turno Conflito (teste)",
] as const;

const isApply = process.argv.includes("--apply");

async function main() {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const [targetRows] = await db.execute<any>(
    sql`SELECT id, label, start_at
        FROM shift_instances
        WHERE label IN (${sql.join(TEST_LABELS.map((label) => sql`${label}`), sql`, `)})
           OR label LIKE 'E2E Test - %'
        ORDER BY start_at ASC`
  );

  const targets = Array.isArray(targetRows) ? targetRows : [];
  const shiftIds = targets.map((r: any) => Number(r.id)).filter(Number.isFinite);

  console.log(`[cleanup-test-shifts] found ${targets.length} shift(s)`);
  for (const row of targets) {
    console.log(` - ${row.id} | ${row.label} | ${row.start_at}`);
  }

  if (!isApply) {
    console.log("[cleanup-test-shifts] dry-run mode (pass --apply to delete)");
    return;
  }

  if (shiftIds.length === 0) {
    console.log("[cleanup-test-shifts] nothing to delete");
    return;
  }

  await db.execute(
    sql`DELETE FROM shift_assignments_v2 WHERE shift_instance_id IN (${sql.join(shiftIds.map((id) => sql`${id}`), sql`, `)})`
  );
  await db.execute(
    sql`DELETE FROM shift_audit_log WHERE shift_instance_id IN (${sql.join(shiftIds.map((id) => sql`${id}`), sql`, `)})`
  );
  await db.execute(
    sql`DELETE FROM shift_instances WHERE id IN (${sql.join(shiftIds.map((id) => sql`${id}`), sql`, `)})`
  );

  console.log(`[cleanup-test-shifts] deleted ${shiftIds.length} shift(s) + dependencies`);
}

main().catch((err) => {
  console.error("[cleanup-test-shifts] error:", err?.stack || err?.message || err);
  process.exit(1);
});

