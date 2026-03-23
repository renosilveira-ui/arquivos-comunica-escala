import "dotenv/config";
import { lt } from "drizzle-orm";
import { getDb } from "../server/db";
import { auditTrail } from "../drizzle/schema";

async function run() {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const retentionDays = Math.min(
    Math.max(Number(process.env.LGPD_AUDIT_RETENTION_DAYS || 365), 1),
    3650,
  );
  const dryRun = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const oldRows = await db
    .select({ id: auditTrail.id })
    .from(auditTrail)
    .where(lt(auditTrail.createdAt, cutoff));

  const candidates = oldRows.length;
  let deleted = 0;

  if (!dryRun && candidates > 0) {
    const result = await db
      .delete(auditTrail)
      .where(lt(auditTrail.createdAt, cutoff));
    deleted = Number((result as any)?.[0]?.affectedRows ?? candidates);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        retentionDays,
        cutoff: cutoff.toISOString(),
        candidates,
        deleted,
      },
      null,
      2,
    ),
  );
}

run().catch((err) => {
  console.error("[lgpd-retention-cleanup] error:", err);
  process.exit(1);
});
