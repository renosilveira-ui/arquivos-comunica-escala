/**
 * Seed admin user for development / first-time setup.
 * Usage: npx tsx server/scripts/seed-admin.ts
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/mysql2";
import { eq } from "drizzle-orm";
import { users, institutions, professionals } from "../../drizzle/schema";

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

  // Ensure a default institution exists (id=1)
  await db
    .insert(institutions)
    .values({ id: 1, name: "Instituto Padrão" })
    .onDuplicateKeyUpdate({ set: { name: "Instituto Padrão" } });

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

  // Resolve admin user id
  const [adminUser] = await db.select().from(users).where(eq(users.email, DEFAULT_EMAIL));
  if (!adminUser) throw new Error("Admin user not found after insert");

  // Ensure professional record exists for admin
  const [existingPro] = await db
    .select()
    .from(professionals)
    .where(eq(professionals.userId, adminUser.id));

  if (!existingPro) {
    await db.insert(professionals).values({
      userId: adminUser.id,
      institutionId: 1,
      name: "Administrador",
      role: "Administrador",
      userRole: "GESTOR_PLUS",
    });
    console.log("Professional record created for admin.");
  } else {
    console.log("Professional record already exists for admin.");
  }

  console.log(`Admin user ready: ${DEFAULT_EMAIL} / ${DEFAULT_PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
