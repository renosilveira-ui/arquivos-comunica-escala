/**
 * Corrige a qualificação médica de um profissional no banco (staging/prod).
 *
 * Uso:
 *   DATABASE_URL='mysql://...' DATABASE_SSL=insecure \
 *     pnpm tsx scripts/fix-professional-qualification.ts \
 *       --name "Ananda Arruda" \
 *       --profile MEDICO_GENERALISTA \
 *       --apply
 *
 * Sem --apply: apenas mostra o que seria alterado (dry-run).
 */

import "dotenv/config";
import { and, eq, isNull, like, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
import {
  medicalSpecialties,
  professionals,
  users,
} from "../drizzle/schema";
import { resolveSslConfig } from "../server/_core/db-ssl";
import {
  OPERATIONAL_PROFILES,
  type OperationalProfileCode,
} from "../lib/medical-specialties";

function parseArgs(argv: string[]) {
  let name: string | undefined;
  let email: string | undefined;
  let profile: OperationalProfileCode = "MEDICO_GENERALISTA";
  let apply = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--name") name = argv[++i];
    else if (arg === "--email") email = argv[++i];
    else if (arg === "--profile") profile = argv[++i] as OperationalProfileCode;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }

  if (!name && !email) {
    throw new Error("Informe --name ou --email");
  }
  if (!OPERATIONAL_PROFILES.some((item) => item.code === profile)) {
    throw new Error(`Perfil operacional inválido: ${profile}`);
  }

  return { name, email, profile, apply };
}

async function main() {
  const { name, email, profile, apply } = parseArgs(process.argv);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Erro: DATABASE_URL não definida.");
    process.exit(1);
  }

  const profileLabel =
    OPERATIONAL_PROFILES.find((item) => item.code === profile)?.name ??
    profile;

  const url = new URL(databaseUrl);
  const ssl = resolveSslConfig();
  const pool = mysql.createPool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ...(ssl ? { ssl } : {}),
  });
  const db = drizzle(pool);

  const conditions = [isNull(users.deletedAt)];
  if (email) {
    conditions.push(eq(users.email, email.toLowerCase().trim()));
  } else if (name) {
    const needle = `%${name.trim()}%`;
    conditions.push(
      or(like(users.name, needle), like(professionals.name, needle))!,
    );
  }

  const rows = await db
    .select({
      userId: users.id,
      userName: users.name,
      email: users.email,
      professionalId: professionals.id,
      specialty: professionals.specialty,
      medicalSpecialtyId: professionals.medicalSpecialtyId,
      medicalSpecialtyCode: medicalSpecialties.code,
      operationalProfileCode: professionals.operationalProfileCode,
    })
    .from(users)
    .innerJoin(professionals, eq(professionals.userId, users.id))
    .leftJoin(
      medicalSpecialties,
      eq(medicalSpecialties.id, professionals.medicalSpecialtyId),
    )
    .where(and(...conditions));

  if (rows.length === 0) {
    console.error("Nenhum profissional encontrado com os critérios informados.");
    pool.end();
    process.exit(1);
  }

  if (rows.length > 1) {
    console.error("Mais de um registro encontrado — refine --name ou use --email:");
    for (const row of rows) {
      console.error(
        `  #${row.userId} ${row.userName} <${row.email}> specialty=${row.medicalSpecialtyCode ?? "—"} profile=${row.operationalProfileCode ?? "—"}`,
      );
    }
    pool.end();
    process.exit(1);
  }

  const row = rows[0]!;
  console.log("[fix-qualification] registro atual:");
  console.log(
    JSON.stringify(
      {
        userId: row.userId,
        name: row.userName,
        email: row.email,
        professionalId: row.professionalId,
        specialty: row.specialty,
        medicalSpecialtyCode: row.medicalSpecialtyCode,
        operationalProfileCode: row.operationalProfileCode,
      },
      null,
      2,
    ),
  );

  const alreadyGeneralist =
    row.medicalSpecialtyId === null &&
    row.operationalProfileCode === profile;
  if (alreadyGeneralist) {
    console.log("[fix-qualification] já está como generalista — nada a fazer.");
    pool.end();
    return;
  }

  if (!apply) {
    console.log(
      `[fix-qualification] dry-run: definiria medical_specialty_id=NULL, operational_profile_code=${profile}, specialty='${profileLabel}'`,
    );
    console.log("[fix-qualification] repita com --apply para gravar.");
    pool.end();
    return;
  }

  const result = await db
    .update(professionals)
    .set({
      medicalSpecialtyId: null,
      operationalProfileCode: profile,
      specialty: profileLabel,
    })
    .where(eq(professionals.id, row.professionalId));

  const affected = Number(
    (result as { affectedRows?: number } | null)?.affectedRows ?? 0,
  );
  if (affected !== 1) {
    console.error(`[fix-qualification] update afetou ${affected} linha(s), esperado 1.`);
    pool.end();
    process.exit(1);
  }

  console.log("[fix-qualification] qualificação atualizada com sucesso.");
  pool.end();
}

main().catch((error) => {
  console.error("[fix-qualification] falhou:", error);
  process.exit(1);
});
