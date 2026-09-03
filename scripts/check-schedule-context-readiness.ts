/**
 * Gate somente leitura para a promoção do modelo multissetorial.
 *
 * Deve ser executado depois da migration e antes de publicar o backend que
 * oculta turnos sem contexto. Não imprime nomes, e-mails nem credenciais.
 */
import "dotenv/config";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { resolveSslConfig } from "../server/_core/db-ssl";

export type ScheduleContextReadinessCounts = Readonly<{
  futureUnclassifiedShifts: number;
  invalidShiftTopology: number;
  invalidScheduleContextTopology: number;
  duplicateActiveSectorContexts: number;
  doubleQualifiedProfessionals: number;
  unclassifiedLegacyProfessionals: number;
  ambiguousBroadAccesses: number;
}>;

type CountRow = RowDataPacket & { count: number | string };

export function scheduleContextReadinessFailures(
  counts: ScheduleContextReadinessCounts,
): string[] {
  return Object.entries(counts)
    .filter(([, count]) => count !== 0)
    .map(([name, count]) => `${name}=${count}`);
}

function connectionOptions() {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL é obrigatória");
  const url = new URL(raw);
  if (url.protocol !== "mysql:" || url.hash) {
    throw new Error("DATABASE_URL deve ser mysql:// e não pode ter fragmento");
  }
  const sslMode = url.searchParams.get("ssl-mode")?.toUpperCase() ?? null;
  if (
    ![...url.searchParams.keys()].every((key) => key === "ssl-mode") ||
    (sslMode !== null && sslMode !== "REQUIRED")
  ) {
    throw new Error("Somente ssl-mode=REQUIRED é aceito na DATABASE_URL");
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("DATABASE_URL deve informar o banco");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl:
      sslMode === "REQUIRED"
        ? { rejectUnauthorized: true }
        : resolveSslConfig(process.env),
  };
}

async function scalar(
  connection: Awaited<ReturnType<typeof mysql.createConnection>>,
  statement: string,
): Promise<number> {
  const [rows] = await connection.query<CountRow[]>(statement);
  return Number(rows[0]?.count ?? 0);
}

export async function readScheduleContextReadiness(): Promise<ScheduleContextReadinessCounts> {
  const connection = await mysql.createConnection(connectionOptions());
  try {
    return {
      futureUnclassifiedShifts: await scalar(
        connection,
        `SELECT COUNT(*) AS count
           FROM shift_instances
          WHERE schedule_context_id IS NULL
            AND end_at >= UTC_TIMESTAMP()`,
      ),
      invalidShiftTopology: await scalar(
        connection,
        `SELECT COUNT(*) AS count
           FROM shift_instances AS shift_instance
           LEFT JOIN schedule_contexts AS context
             ON context.id = shift_instance.schedule_context_id
            AND context.institution_id = shift_instance.institution_id
            AND context.hospital_id = shift_instance.hospital_id
            AND context.sector_id = shift_instance.sector_id
            AND context.active = TRUE
          WHERE shift_instance.schedule_context_id IS NOT NULL
            AND context.id IS NULL`,
      ),
      invalidScheduleContextTopology: await scalar(
        connection,
        `SELECT COUNT(*) AS count
           FROM schedule_contexts AS context
           LEFT JOIN hospitals AS hospital
             ON hospital.id = context.hospital_id
            AND hospital.institution_id = context.institution_id
           LEFT JOIN sectors AS sector
             ON sector.id = context.sector_id
            AND sector.institution_id = context.institution_id
            AND sector.hospital_id = context.hospital_id
          WHERE hospital.id IS NULL OR sector.id IS NULL`,
      ),
      duplicateActiveSectorContexts: await scalar(
        connection,
        `SELECT COUNT(*) AS count
           FROM (
             SELECT context.institution_id, context.hospital_id, context.sector_id
               FROM schedule_contexts AS context
              WHERE context.active = TRUE
              GROUP BY context.institution_id, context.hospital_id, context.sector_id
             HAVING COUNT(*) > 1
           ) AS duplicate_active_sector_contexts`,
      ),
      doubleQualifiedProfessionals: await scalar(
        connection,
        `SELECT COUNT(*) AS count
           FROM professionals
          WHERE medical_specialty_id IS NOT NULL
            AND operational_profile_code IS NOT NULL`,
      ),
      unclassifiedLegacyProfessionals: await scalar(
        connection,
        `SELECT COUNT(*) AS count
           FROM professionals AS professional
           INNER JOIN professional_institutions AS membership
             ON membership.professional_id = professional.id
            AND membership.user_id = professional.user_id
            AND membership.active = TRUE
           INNER JOIN users AS user
             ON user.id = professional.user_id
            AND user.approval_status = 'APPROVED'
            AND user.deleted_at IS NULL
          WHERE professional.specialty IS NOT NULL
            AND TRIM(professional.specialty) <> ''
            AND professional.medical_specialty_id IS NULL
            AND professional.operational_profile_code IS NULL`,
      ),
      ambiguousBroadAccesses: await scalar(
        connection,
        `SELECT COUNT(*) AS count
           FROM (
             SELECT access.id
               FROM professional_access AS access
               INNER JOIN professionals AS professional
                 ON professional.id = access.professional_id
               INNER JOIN schedule_contexts AS context
                 ON context.institution_id = access.institution_id
                AND context.hospital_id = access.hospital_id
                AND context.active = TRUE
                AND (
                  (context.medical_specialty_id IS NOT NULL
                    AND context.medical_specialty_id = professional.medical_specialty_id)
                  OR
                  (context.operational_profile_code IS NOT NULL
                    AND context.operational_profile_code = professional.operational_profile_code)
                )
              WHERE access.sector_id IS NULL
                AND access.can_access = TRUE
              GROUP BY access.id
             HAVING COUNT(DISTINCT context.sector_id) > 1
           ) AS ambiguous_access`,
      ),
    };
  } finally {
    await connection.end();
  }
}

async function main(): Promise<void> {
  const counts = await readScheduleContextReadiness();
  const failures = scheduleContextReadinessFailures(counts);
  console.log(JSON.stringify(counts, null, 2));
  if (failures.length > 0) {
    throw new Error(
      `Readiness multissetorial bloqueada: ${failures.join(", ")}`,
    );
  }
  console.log("Readiness multissetorial aprovada.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Falha desconhecida no readiness",
    );
    process.exitCode = 1;
  });
}
