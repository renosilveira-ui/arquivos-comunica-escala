/**
 * scripts/seed-staging.ts
 *
 * One-shot seed for the staging environment. Idempotent — re-running does
 * not duplicate rows, only inserts what does not exist yet.
 *
 * Usage (with env vars provided externally):
 *
 *   DATABASE_URL='mysql://...' DATABASE_SSL=insecure \
 *     pnpm exec tsx scripts/seed-staging.ts
 *
 * The script:
 *   1. Creates 1 institution: "Cooperativa dos Médicos de Fortaleza - Unimed"
 *   2. Creates 1 hospital under it: "Hospital Regional Unimed"
 *   3. Creates 3 sectors: Centro Cirúrgico, Sala de Recuperação, Setor de Imagem
 *   4. Creates the admin user (renosilveira@gmail.com) with a randomly
 *      generated 16-char password printed ONCE to stdout (not stored, not
 *      logged elsewhere — operator must save it immediately)
 *   5. Creates the matching `professionals` record (GESTOR_PLUS)
 *   6. Links the admin to the institution via `professional_institutions`
 *   7. Grants `manager_scope` over each of the 3 sectors
 *
 * If the admin user already exists, the password is NOT regenerated — the
 * operator can rotate via the app UI or by deleting the user row first.
 */

import "dotenv/config";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
import { and, eq } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  professionalInstitutions,
  professionals,
  sectors,
  users,
} from "../drizzle/schema";
import { resolveSslConfig } from "../server/_core/db-ssl";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INSTITUTION = {
  name: "Cooperativa dos Médicos de Fortaleza - Unimed",
  legalName: "Cooperativa dos Médicos de Fortaleza - Unimed",
  tradeName: "Unimed Fortaleza",
  // CNPJ placeholder for staging — replace with the real value when going to
  // production. The unique constraint is satisfied; nothing in the app
  // validates the check digit yet.
  cnpj: "00000000000099",
} as const;

const HOSPITAL_NAME = "Hospital Regional Unimed";

const SECTORS: Array<{
  name: string;
  category: "internacao" | "cirurgico" | "servico";
  color: string;
}> = [
  { name: "Centro Cirúrgico", category: "cirurgico", color: "#2563EB" },
  { name: "Sala de Recuperação", category: "cirurgico", color: "#16A34A" },
  { name: "Setor de Imagem", category: "servico", color: "#A855F7" },
];

const ADMIN = {
  email: "renosilveira@gmail.com",
  name: "Reno Silveira",
} as const;

const BCRYPT_ROUNDS = 12;
const PASSWORD_LENGTH = 16;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generatePassword(length: number): string {
  // Charset omits ambiguous characters (0/O, 1/l/I) for human re-typability.
  const charset =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
  const bytes = randomBytes(length * 2);
  let password = "";
  const limit = charset.length * Math.floor(256 / charset.length);
  for (let i = 0; i < bytes.length && password.length < length; i++) {
    if (bytes[i]! < limit) {
      password += charset[bytes[i]! % charset.length];
    }
  }
  if (password.length < length) {
    // Fallback (extremely rare): pad with deterministic char from buffer.
    password = (password + bytes.toString("hex")).slice(0, length);
  }
  return password;
}

function buildPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Pass it via env, e.g.\n" +
        "  DATABASE_URL='mysql://...' DATABASE_SSL=insecure pnpm exec tsx scripts/seed-staging.ts",
    );
  }
  const ssl = resolveSslConfig(process.env);
  if (ssl) {
    const u = new URL(url);
    return mysql.createPool({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
      ssl,
    });
  }
  return mysql.createPool(url);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pool = buildPool();
  const db = drizzle(pool);

  console.log("Seeding staging — Hospital Regional Unimed (Fortaleza)\n");

  // 1. Institution -----------------------------------------------------------
  const existingInst = await db
    .select()
    .from(institutions)
    .where(eq(institutions.name, INSTITUTION.name))
    .limit(1);
  let institutionId: number;
  if (existingInst[0]) {
    institutionId = existingInst[0].id;
    console.log(`✓ Institution exists (id=${institutionId})`);
  } else {
    const [insertResult] = await db.insert(institutions).values({
      name: INSTITUTION.name,
      cnpj: INSTITUTION.cnpj,
      legalName: INSTITUTION.legalName,
      tradeName: INSTITUTION.tradeName,
      isActive: true,
    });
    institutionId = (insertResult as { insertId: number }).insertId;
    console.log(`✓ Institution created (id=${institutionId})`);
  }

  // 2. Hospital --------------------------------------------------------------
  const existingHosp = await db
    .select()
    .from(hospitals)
    .where(
      and(
        eq(hospitals.institutionId, institutionId),
        eq(hospitals.name, HOSPITAL_NAME),
      ),
    )
    .limit(1);
  let hospitalId: number;
  if (existingHosp[0]) {
    hospitalId = existingHosp[0].id;
    console.log(`✓ Hospital exists (id=${hospitalId})`);
  } else {
    const [insertResult] = await db.insert(hospitals).values({
      institutionId,
      name: HOSPITAL_NAME,
    });
    hospitalId = (insertResult as { insertId: number }).insertId;
    console.log(`✓ Hospital created (id=${hospitalId})`);
  }

  // 3. Sectors ---------------------------------------------------------------
  const sectorIds: number[] = [];
  for (const s of SECTORS) {
    const existing = await db
      .select()
      .from(sectors)
      .where(
        and(eq(sectors.hospitalId, hospitalId), eq(sectors.name, s.name)),
      )
      .limit(1);
    if (existing[0]) {
      sectorIds.push(existing[0].id);
      console.log(`✓ Sector "${s.name}" exists (id=${existing[0].id})`);
      continue;
    }
    const [insertResult] = await db.insert(sectors).values({
      institutionId,
      hospitalId,
      name: s.name,
      category: s.category,
      color: s.color,
    });
    const id = (insertResult as { insertId: number }).insertId;
    sectorIds.push(id);
    console.log(`✓ Sector "${s.name}" created (id=${id})`);
  }

  // 4. Admin user ------------------------------------------------------------
  let adminUserId: number;
  let plainPassword: string | null = null;
  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, ADMIN.email))
    .limit(1);
  if (existingUser[0]) {
    adminUserId = existingUser[0].id;
    console.log(
      `✓ Admin user exists (id=${adminUserId}) — password unchanged. ` +
        "To rotate, delete the user row and re-run this script.",
    );
  } else {
    plainPassword = generatePassword(PASSWORD_LENGTH);
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
    const [insertResult] = await db.insert(users).values({
      name: ADMIN.name,
      email: ADMIN.email,
      passwordHash,
      role: "admin",
      loginMethod: "email",
    });
    adminUserId = (insertResult as { insertId: number }).insertId;
    console.log(`✓ Admin user created (id=${adminUserId})`);
  }

  // 5. Professional record ---------------------------------------------------
  let professionalId: number;
  const existingPro = await db
    .select()
    .from(professionals)
    .where(eq(professionals.userId, adminUserId))
    .limit(1);
  if (existingPro[0]) {
    professionalId = existingPro[0].id;
    console.log(`✓ Professional record exists (id=${professionalId})`);
  } else {
    const [insertResult] = await db.insert(professionals).values({
      userId: adminUserId,
      name: ADMIN.name,
      role: "Administrador",
      userRole: "GESTOR_PLUS",
    });
    professionalId = (insertResult as { insertId: number }).insertId;
    console.log(`✓ Professional record created (id=${professionalId})`);
  }

  // 6. Professional ↔ Institution link --------------------------------------
  const existingLink = await db
    .select()
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.professionalId, professionalId),
        eq(professionalInstitutions.institutionId, institutionId),
      ),
    )
    .limit(1);
  if (existingLink[0]) {
    console.log(
      `✓ Professional-Institution link exists (id=${existingLink[0].id})`,
    );
  } else {
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId: adminUserId,
      institutionId,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });
    console.log("✓ Professional-Institution link created (GESTOR_PLUS)");
  }

  // 7. Manager scope (admin manages every sector) ---------------------------
  for (let i = 0; i < SECTORS.length; i++) {
    const sectorId = sectorIds[i]!;
    const sectorName = SECTORS[i]!.name;
    const existingScope = await db
      .select()
      .from(managerScope)
      .where(
        and(
          eq(managerScope.managerProfessionalId, professionalId),
          eq(managerScope.sectorId, sectorId),
        ),
      )
      .limit(1);
    if (existingScope[0]) {
      console.log(`✓ Manager scope on "${sectorName}" exists`);
      continue;
    }
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: professionalId,
      hospitalId,
      sectorId,
      active: true,
    });
    console.log(`✓ Manager scope on "${sectorName}" granted`);
  }

  // -------------------------------------------------------------------------
  console.log("\n✅ Seed complete.\n");

  if (plainPassword) {
    const banner = "=".repeat(72);
    console.log(banner);
    console.log("ADMIN PASSWORD (save NOW — will not be shown again):");
    console.log(`  ${plainPassword}`);
    console.log(banner);
    console.log(`Login:  https://escalas-staging-web.onrender.com`);
    console.log(`Email:  ${ADMIN.email}`);
    console.log(
      "After first login, rotate this password via the app's profile " +
        "settings.",
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
