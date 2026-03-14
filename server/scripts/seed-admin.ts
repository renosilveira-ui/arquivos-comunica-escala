/**
 * Seed admin user for development / first-time setup.
 * Usage: npx tsx server/scripts/seed-admin.ts
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/mysql2";
import { users } from "../../drizzle/schema";

const DEFAULT_EMAIL = "admin@escalas.local";
const DEFAULT_PASSWORD = "admin123";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL not set");
    process.exit(1);
  }

  const db = drizzle(databaseUrl);
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  await db
    .insert(users)
    .values({
      name: "Administrador",
      email: DEFAULT_EMAIL,
      passwordHash,
      role: "admin",
      loginMethod: "email",
    })
    .onDuplicateKeyUpdate({ set: { passwordHash, role: "admin" } });

  console.log(`Admin user ready: ${DEFAULT_EMAIL} / ${DEFAULT_PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
