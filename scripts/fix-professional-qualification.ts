/**
 * Corrige a qualificação médica de um profissional no banco (staging/prod).
 *
 * Uso (especialidade CFM):
 *   DATABASE_URL='mysql://...' DATABASE_SSL=insecure \
 *     pnpm tsx scripts/fix-professional-qualification.ts \
 *       --name "Ananda Arruda" \
 *       --specialty CLINICA_MEDICA \
 *       --apply
 *
 * Uso (perfil operacional):
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
  MEDICAL_SPECIALTIES,
  OPERATIONAL_PROFILES,
  isMedicalSpecialtyCode,
  isOperationalProfileCode,
  type MedicalSpecialtyCode,
  type OperationalProfileCode,
} from "../lib/medical-specialties";

type TargetQualification =
  | {
      kind: "MEDICAL_SPECIALTY";
      code: MedicalSpecialtyCode;
      label: string;
    }
  | {
      kind: "OPERATIONAL_PROFILE";
      code: OperationalProfileCode;
      label: string;
    };

function parseArgs(argv: string[]) {
  let name: string | undefined;
  let email: string | undefined;
  let specialty: MedicalSpecialtyCode | undefined;
  let profile: OperationalProfileCode | undefined;
  let apply = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--name") name = argv[++i];
    else if (arg === "--email") email = argv[++i];
    else if (arg === "--specialty") {
      const code = argv[++i];
      if (!code || !isMedicalSpecialtyCode(code)) {
        throw new Error(`Especialidade inválida: ${code ?? "(vazio)"}`);
      }
      specialty = code;
    } else if (arg === "--profile") {
      const code = argv[++i];
      if (!code || !isOperationalProfileCode(code)) {
        throw new Error(`Perfil operacional inválido: ${code ?? "(vazio)"}`);
      }
      profile = code;
    } else throw new Error(`Argumento desconhecido: ${arg}`);
  }

  if (!name && !email) {
    throw new Error("Informe --name ou --email");
  }
  if (specialty && profile) {
    throw new Error("Informe apenas --specialty ou --profile, não ambos");
  }
  if (!specialty && !profile) {
    specialty = "CLINICA_MEDICA";
  }

  const target: TargetQualification = specialty
    ? {
        kind: "MEDICAL_SPECIALTY",
        code: specialty,
        label:
          MEDICAL_SPECIALTIES.find((item) => item.code === specialty)?.name ??
          specialty,
      }
    : {
        kind: "OPERATIONAL_PROFILE",
        code: profile!,
        label:
          OPERATIONAL_PROFILES.find((item) => item.code === profile)?.name ??
          profile!,
      };

  return { name, email, target, apply };
}

async function main() {
  const { name, email, target, apply } = parseArgs(process.argv);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Erro: DATABASE_URL não definida.");
    process.exit(1);
  }

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

  let targetMedicalSpecialtyId: number | null = null;
  let targetOperationalProfileCode: OperationalProfileCode | null = null;
  let targetLabel = target.label;

  if (target.kind === "MEDICAL_SPECIALTY") {
    const [specialtyRow] = await db
      .select({ id: medicalSpecialties.id })
      .from(medicalSpecialties)
      .where(
        and(
          eq(medicalSpecialties.code, target.code),
          eq(medicalSpecialties.active, true),
        ),
      )
      .limit(1);
    if (!specialtyRow) {
      console.error(
        `[fix-qualification] especialidade ${target.code} não encontrada no catálogo.`,
      );
      pool.end();
      process.exit(1);
    }
    targetMedicalSpecialtyId = specialtyRow.id;
  } else {
    targetOperationalProfileCode = target.code;
  }

  const alreadyMatches =
    row.medicalSpecialtyId === targetMedicalSpecialtyId &&
    row.operationalProfileCode === targetOperationalProfileCode;
  if (alreadyMatches) {
    console.log(
      `[fix-qualification] já está como ${targetLabel} — nada a fazer.`,
    );
    pool.end();
    return;
  }

  if (!apply) {
    console.log(
      `[fix-qualification] dry-run: definiria medical_specialty_id=${targetMedicalSpecialtyId ?? "NULL"}, operational_profile_code=${targetOperationalProfileCode ?? "NULL"}, specialty='${targetLabel}'`,
    );
    console.log("[fix-qualification] repita com --apply para gravar.");
    pool.end();
    return;
  }

  const result = await db
    .update(professionals)
    .set({
      medicalSpecialtyId: targetMedicalSpecialtyId,
      operationalProfileCode: targetOperationalProfileCode,
      specialty: targetLabel,
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

  console.log(
    `[fix-qualification] qualificação atualizada para ${targetLabel} com sucesso.`,
  );
  pool.end();
}

main().catch((error) => {
  console.error("[fix-qualification] falhou:", error);
  process.exit(1);
});
