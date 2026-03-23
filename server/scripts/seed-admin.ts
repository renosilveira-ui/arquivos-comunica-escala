/**
 * Seed admin user for development / first-time setup.
 * Usage: npx tsx server/scripts/seed-admin.ts
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/mysql2";
import { and, eq } from "drizzle-orm";
import {
  users,
  institutions,
  professionals,
  professionalInstitutions,
} from "../../drizzle/schema";

const DEFAULT_EMAIL = "admin@escalas.local";
const DEFAULT_PASSWORD = "admin123";
const DEFAULT_INSTITUTION_ID = 1;

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
    .values({
      id: DEFAULT_INSTITUTION_ID,
      name: "Hospital das Clínicas",
      cnpj: "11111111000191",
      legalName: "Hospital das Clínicas S.A.",
      tradeName: "HC",
    })
    .onDuplicateKeyUpdate({
      set: {
        name: "Hospital das Clínicas",
        legalName: "Hospital das Clínicas S.A.",
        tradeName: "HC",
      },
    });

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

  // Ensure global professional record exists for admin
  const [existingPro] = await db
    .select()
    .from(professionals)
    .where(eq(professionals.userId, adminUser.id));

  let professionalId: number;
  if (!existingPro) {
    const [proResult] = await db.insert(professionals).values({
      userId: adminUser.id,
      name: "Administrador",
      role: "Administrador",
      userRole: "GESTOR_PLUS",
    });
    professionalId = (proResult as any).insertId as number;
    console.log("Global professional record created for admin.");
  } else {
    professionalId = existingPro.id;
    console.log("Global professional record already exists for admin.");
  }

  // Ensure canonical tenant link exists
  const [existingLink] = await db
    .select({ id: professionalInstitutions.id })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.professionalId, professionalId),
        eq(professionalInstitutions.institutionId, DEFAULT_INSTITUTION_ID),
      ),
    )
    .limit(1);

  if (!existingLink) {
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId: adminUser.id,
      institutionId: DEFAULT_INSTITUTION_ID,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });
    console.log("Tenant link created for admin.");
  } else {
    console.log("Tenant link already exists for admin.");
  }

  console.log(`Admin user ready: ${DEFAULT_EMAIL} / ${DEFAULT_PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
