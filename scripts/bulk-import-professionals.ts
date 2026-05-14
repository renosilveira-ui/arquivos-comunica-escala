/**
 * scripts/bulk-import-professionals.ts
 *
 * Bulk-creates `users` + `professionals` + `professional_institutions` rows
 * from a CSV file, generating a temporary password for each new account.
 * Idempotent — re-running with the same CSV updates nothing for users that
 * already exist (matched by email).
 *
 * Usage:
 *
 *   DATABASE_URL='mysql://...' DATABASE_SSL=insecure \
 *     PROFESSIONALS_CSV=data/anestesistas.csv \
 *     pnpm import:professionals
 *
 * INPUT FORMAT — CSV with header row, comma-separated:
 *
 *   name,email
 *   Dr. João Silva,joao.silva@unimedfortaleza.com.br
 *   Dra. Maria Santos,maria.santos@unimedfortaleza.com.br
 *
 * Optional 3rd column `role` (admin | manager | doctor | nurse | tech),
 * defaults to `doctor` if absent.
 *
 * The CSV is expected to live at the path provided in PROFESSIONALS_CSV.
 * Parse is permissive: trims whitespace, skips empty lines, ignores rows
 * where email is missing.
 *
 * OUTPUT — a CSV is written to `data/credentials-<timestamp>.csv` with:
 *
 *   email,name,temporary_password,already_existed
 *   joao.silva@unimed...,Dr. João Silva,Q3xV...,false
 *   ...
 *
 * For users that already existed, `temporary_password` is blank and
 * `already_existed` is `true` — the operator knows not to redistribute.
 *
 * SECURITY:
 *   - Passwords are bcrypt-hashed at rounds=12 before being stored
 *     (matches BCRYPT_ROUNDS in routes/auth.ts).
 *   - Plain-text passwords are written ONLY to the output CSV, never
 *     printed to stdout. The output file is gitignored under data/.
 *   - The operator is expected to delete the credentials CSV after
 *     distribution and to instruct users to rotate the password on
 *     first login.
 */

import "dotenv/config";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
import { and, eq } from "drizzle-orm";
import {
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  users,
} from "../drizzle/schema";
import { resolveSslConfig } from "../server/_core/db-ssl";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TARGET_INSTITUTION_NAME =
  "Cooperativa dos Médicos de Fortaleza - Unimed";

const VALID_ROLES = ["admin", "manager", "doctor", "nurse", "tech"] as const;
type ValidRole = (typeof VALID_ROLES)[number];

const BCRYPT_ROUNDS = 12;
const PASSWORD_LENGTH = 16;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CsvRow {
  name: string;
  email: string;
  role: ValidRole;
}

interface ImportResult {
  email: string;
  name: string;
  temporaryPassword: string | null;
  alreadyExisted: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generatePassword(length: number): string {
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
    password = (password + bytes.toString("hex")).slice(0, length);
  }
  return password;
}

function parseCsv(content: string): CsvRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];

  const header = lines[0]!.split(",").map((c) => c.trim().toLowerCase());
  const nameIdx = header.indexOf("name");
  const emailIdx = header.indexOf("email");
  const roleIdx = header.indexOf("role");
  if (nameIdx === -1 || emailIdx === -1) {
    throw new Error(
      "CSV header must contain at least `name` and `email` columns. " +
        `Got: ${header.join(", ")}`,
    );
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",").map((c) => c.trim());
    const name = cells[nameIdx];
    const email = cells[emailIdx]?.toLowerCase();
    if (!name || !email) {
      console.warn(
        `[skip] line ${i + 1}: missing name or email — ${lines[i]}`,
      );
      continue;
    }
    let role: ValidRole = "doctor";
    if (roleIdx >= 0 && cells[roleIdx]) {
      const candidate = cells[roleIdx]!.toLowerCase() as ValidRole;
      if (VALID_ROLES.includes(candidate)) {
        role = candidate;
      } else {
        console.warn(
          `[skip] line ${i + 1}: invalid role "${cells[roleIdx]}" — using "doctor"`,
        );
      }
    }
    rows.push({ name, email, role });
  }
  return rows;
}

function buildPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Pass via env, e.g.\n" +
        "  DATABASE_URL='mysql://...' DATABASE_SSL=insecure \\\n" +
        "  PROFESSIONALS_CSV=data/anestesistas.csv \\\n" +
        "  pnpm import:professionals",
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

function mapRoleToProRole(
  role: ValidRole,
): "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS" {
  if (role === "admin") return "GESTOR_PLUS";
  if (role === "manager") return "GESTOR_MEDICO";
  return "USER";
}

function mapRoleToLabel(role: ValidRole): string {
  const labels: Record<ValidRole, string> = {
    admin: "Administrador",
    manager: "Gestor",
    doctor: "Médico",
    nurse: "Enfermeiro",
    tech: "Técnico de Enfermagem",
  };
  return labels[role];
}

function csvEscape(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const csvPath = process.env.PROFESSIONALS_CSV;
  if (!csvPath) {
    throw new Error(
      "PROFESSIONALS_CSV env var is required (path to the input CSV).",
    );
  }
  const absoluteCsvPath = resolve(process.cwd(), csvPath);
  console.log(`Reading: ${absoluteCsvPath}`);
  const csvContent = readFileSync(absoluteCsvPath, "utf8");
  const csvRows = parseCsv(csvContent);
  if (csvRows.length === 0) {
    console.log("No rows to import. Exiting.");
    return;
  }
  console.log(`Parsed ${csvRows.length} row(s).\n`);

  const pool = buildPool();
  const db = drizzle(pool);

  // Resolve target institution (must already exist; created by seed-staging.ts).
  const [inst] = await db
    .select()
    .from(institutions)
    .where(eq(institutions.name, TARGET_INSTITUTION_NAME))
    .limit(1);
  if (!inst) {
    throw new Error(
      `Target institution not found: "${TARGET_INSTITUTION_NAME}". ` +
        "Run `pnpm seed:staging` first.",
    );
  }
  const institutionId = inst.id;
  const sectorRows = await db
    .select({
      id: sectors.id,
      hospitalId: sectors.hospitalId,
    })
    .from(sectors)
    .where(eq(sectors.institutionId, institutionId));
  console.log(
    `Target institution: ${TARGET_INSTITUTION_NAME} (id=${institutionId})\n`,
  );

  const results: ImportResult[] = [];

  for (const row of csvRows) {
    const result: ImportResult = {
      email: row.email,
      name: row.name,
      temporaryPassword: null,
      alreadyExisted: false,
      error: null,
    };

    try {
      // 1. Check if user already exists.
      const [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.email, row.email))
        .limit(1);

      let userId: number;
      if (existingUser) {
        userId = existingUser.id;
        result.alreadyExisted = true;
        console.log(
          `· ${row.email} — already exists (id=${userId}), skipping password reset.`,
        );
      } else {
        const password = generatePassword(PASSWORD_LENGTH);
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const [insertResult] = await db.insert(users).values({
          name: row.name,
          email: row.email,
          passwordHash,
          role: row.role,
          loginMethod: "email",
        });
        userId = (insertResult as { insertId: number }).insertId;
        result.temporaryPassword = password;
        console.log(`+ ${row.email} — created user id=${userId}`);
      }

      // 2. Ensure professional record exists.
      const [existingPro] = await db
        .select()
        .from(professionals)
        .where(eq(professionals.userId, userId))
        .limit(1);

      let professionalId: number;
      if (existingPro) {
        professionalId = existingPro.id;
      } else {
        const [insertResult] = await db.insert(professionals).values({
          userId,
          name: row.name,
          role: mapRoleToLabel(row.role),
          userRole: mapRoleToProRole(row.role),
        });
        professionalId = (insertResult as { insertId: number }).insertId;
      }

      // 3. Ensure professional ↔ institution link exists.
      const [existingLink] = await db
        .select()
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.professionalId, professionalId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        )
        .limit(1);

      if (!existingLink) {
        await db.insert(professionalInstitutions).values({
          professionalId,
          userId,
          institutionId,
          roleInInstitution: mapRoleToProRole(row.role),
          isPrimary: true,
          active: true,
        });
      }

      // 4. Ensure the professional can be allocated in current sectors.
      // The assignment endpoint enforces professional_access; without these
      // rows newly imported doctors exist but cannot be placed on a shift.
      for (const sector of sectorRows) {
        const [existingAccess] = await db
          .select({ id: professionalAccess.id, canAccess: professionalAccess.canAccess })
          .from(professionalAccess)
          .where(
            and(
              eq(professionalAccess.professionalId, professionalId),
              eq(professionalAccess.institutionId, institutionId),
              eq(professionalAccess.hospitalId, sector.hospitalId),
              eq(professionalAccess.sectorId, sector.id),
            ),
          )
          .limit(1);

        if (!existingAccess) {
          await db.insert(professionalAccess).values({
            professionalId,
            institutionId,
            hospitalId: sector.hospitalId,
            sectorId: sector.id,
            canAccess: true,
          });
        } else if (!existingAccess.canAccess) {
          await db
            .update(professionalAccess)
            .set({ canAccess: true })
            .where(eq(professionalAccess.id, existingAccess.id));
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`! ${row.email} — error: ${result.error}`);
    }

    results.push(result);
  }

  await pool.end();

  // -------------------------------------------------------------------------
  // Write output CSV
  // -------------------------------------------------------------------------
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const outDir = resolve(process.cwd(), "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `credentials-${timestamp}.csv`);

  const header = "email,name,temporary_password,already_existed,error";
  const body = results
    .map((r) =>
      [
        csvEscape(r.email),
        csvEscape(r.name),
        csvEscape(r.temporaryPassword ?? ""),
        r.alreadyExisted ? "true" : "false",
        csvEscape(r.error ?? ""),
      ].join(","),
    )
    .join("\n");
  writeFileSync(outPath, `${header}\n${body}\n`, "utf8");

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const created = results.filter((r) => r.temporaryPassword).length;
  const existed = results.filter((r) => r.alreadyExisted).length;
  const errored = results.filter((r) => r.error).length;

  console.log("\n=================================================");
  console.log("Import complete.");
  console.log(`  Created:        ${created}`);
  console.log(`  Already existed: ${existed}`);
  console.log(`  Errors:          ${errored}`);
  console.log(`  Output:          ${outPath}`);
  console.log("=================================================");
  console.log(
    "\nDistribute the credentials CSV via your chosen channel and " +
      "DELETE the file after distribution.",
  );
  console.log(
    "Instruct each user to change their password on first login.",
  );
}

main().catch((err) => {
  console.error("Bulk import failed:", err);
  process.exit(1);
});
