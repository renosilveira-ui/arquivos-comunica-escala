/**
 * Prova local e efêmera da migration manual da readiness fence V1.
 *
 * Não lê DATABASE_URL. O alvo é sempre um schema novo, com nome aleatório,
 * em MySQL loopback e exige opt-in explícito. Em falha, o schema é preservado
 * para inspeção; em sucesso, ele é removido pelo mesmo alvo validado.
 *
 * Uso deliberado:
 * NODE_ENV=test READINESS_FENCE_V1_PROOF_ALLOW_DESTRUCTIVE=1 \
 * READINESS_FENCE_V1_PROOF_SERVER_URL='mysql://root:root@127.0.0.1:3306/' \
 * pnpm exec tsx scripts/prove-readiness-fence-v1-migration.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql, { type Connection } from "mysql2/promise";
import {
  READINESS_FENCE_V1_SOURCE_COLUMNS,
  applyReadinessFenceV1Migration,
} from "./apply-readiness-fence-v1-migration";

export const READINESS_FENCE_V1_PROOF_DATABASE_PREFIX = "escalas_rdf_v1_proof_";
const ALLOWED_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const PROOF_DATABASE_NAME = new RegExp(
  `^${READINESS_FENCE_V1_PROOF_DATABASE_PREFIX}[a-f0-9]{32}$`,
);

type Environment = Record<string, string | undefined>;

export type ReadinessFenceV1ProofEnvironment = Readonly<{
  serverUrl: string;
  databaseUrl: string;
  databaseName: string;
}>;

function decodeUrlComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`READINESS_FENCE_V1_PROOF ${label} inválido`);
  }
}

function canonicalMysqlUrl(
  parts: Readonly<{
    host: string;
    port: string;
    username: string;
    password: string;
    databaseName?: string;
  }>,
): string {
  const credentials =
    parts.username || parts.password
      ? `${encodeURIComponent(parts.username)}:${encodeURIComponent(parts.password)}@`
      : "";
  const database = parts.databaseName
    ? `/${encodeURIComponent(parts.databaseName)}`
    : "/";
  return `mysql://${credentials}${parts.host}:${parts.port}${database}`;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error("READINESS_FENCE_V1_PROOF_IDENTIFIER_INVALID");
  }
  return `\`${identifier}\``;
}

export function isReadinessFenceV1ProofDatabaseName(name: string): boolean {
  return PROOF_DATABASE_NAME.test(name);
}

/**
 * Rejeita antes de abrir qualquer conexão quando o processo não está no
 * ambiente de prova local. Não há fallback para DATABASE_URL.
 */
export function validateReadinessFenceV1ProofEnvironment(
  env: Environment = process.env,
  randomId: string = randomUUID(),
): ReadinessFenceV1ProofEnvironment {
  if (env.NODE_ENV !== "test") {
    throw new Error("READINESS_FENCE_V1_PROOF exige NODE_ENV=test");
  }
  if (env.READINESS_FENCE_V1_PROOF_ALLOW_DESTRUCTIVE !== "1") {
    throw new Error(
      "READINESS_FENCE_V1_PROOF exige READINESS_FENCE_V1_PROOF_ALLOW_DESTRUCTIVE=1",
    );
  }
  const rawServerUrl = env.READINESS_FENCE_V1_PROOF_SERVER_URL?.trim();
  if (!rawServerUrl) {
    throw new Error(
      "READINESS_FENCE_V1_PROOF_SERVER_URL é obrigatória e não usa DATABASE_URL",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawServerUrl);
  } catch {
    throw new Error("READINESS_FENCE_V1_PROOF_SERVER_URL inválida");
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error("READINESS_FENCE_V1_PROOF_SERVER_URL deve usar mysql://");
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "READINESS_FENCE_V1_PROOF_SERVER_URL não aceita opções nem fragmento",
    );
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      "READINESS_FENCE_V1_PROOF_SERVER_URL não pode apontar para schema existente",
    );
  }
  const parsedHost = parsed.hostname.toLowerCase();
  if (!ALLOWED_LOCAL_HOSTS.has(parsedHost)) {
    throw new Error(
      "READINESS_FENCE_V1_PROOF_SERVER_URL deve usar localhost ou 127.0.0.1",
    );
  }
  const portNumber = Number(parsed.port || "3306");
  if (
    !Number.isSafeInteger(portNumber) ||
    portNumber <= 0 ||
    portNumber > 65_535
  ) {
    throw new Error("READINESS_FENCE_V1_PROOF_SERVER_URL porta inválida");
  }
  if (!/^[0-9a-f-]{36}$/i.test(randomId)) {
    throw new Error("READINESS_FENCE_V1_PROOF_RANDOM_ID_INVALID");
  }

  const host = parsedHost === "localhost" ? "127.0.0.1" : parsedHost;
  const port = String(portNumber);
  const username = decodeUrlComponent(parsed.username, "usuário");
  const password = decodeUrlComponent(parsed.password, "senha");
  const databaseName = `${READINESS_FENCE_V1_PROOF_DATABASE_PREFIX}${randomId
    .replaceAll("-", "")
    .toLowerCase()}`;
  if (
    databaseName.length > 64 ||
    !isReadinessFenceV1ProofDatabaseName(databaseName)
  ) {
    throw new Error("READINESS_FENCE_V1_PROOF_DATABASE_NAME_INVALID");
  }

  return Object.freeze({
    serverUrl: canonicalMysqlUrl({ host, port, username, password }),
    databaseUrl: canonicalMysqlUrl({
      host,
      port,
      username,
      password,
      databaseName,
    }),
    databaseName,
  });
}

const INTEGER_COLUMNS = new Set([
  "id",
  "institution_id",
  "hospital_id",
  "sector_id",
  "schedule_context_id",
  "shift_instance_id",
  "professional_id",
  "user_id",
  "manager_professional_id",
  "priority",
  "version",
]);
const BOOLEAN_COLUMNS = new Set(["active", "is_active", "can_access"]);
const TIME_COLUMNS = new Set(["start_time", "end_time"]);
const DATETIME_COLUMNS = new Set(["start_at", "end_at", "deleted_at"]);

function proofColumnDefinition(columnName: string): string {
  if (columnName === "id") return "`id` INT NOT NULL";
  if (INTEGER_COLUMNS.has(columnName)) return `\`${columnName}\` INT NULL`;
  if (BOOLEAN_COLUMNS.has(columnName)) return `\`${columnName}\` TINYINT NULL`;
  if (TIME_COLUMNS.has(columnName)) return `\`${columnName}\` TIME NULL`;
  if (DATETIME_COLUMNS.has(columnName))
    return `\`${columnName}\` DATETIME NULL`;
  if (columnName === "productivity_cap_brl") {
    return "`productivity_cap_brl` DECIMAL(12,2) NULL";
  }
  return `\`${columnName}\` VARCHAR(255) NULL`;
}

async function createMinimalSourceSchema(
  connection: Connection,
): Promise<void> {
  for (const [tableName, columns] of Object.entries(
    READINESS_FENCE_V1_SOURCE_COLUMNS,
  )) {
    const definitions = [
      ...columns.map(proofColumnDefinition),
      "PRIMARY KEY (`id`)",
    ];
    await connection.query(
      `CREATE TABLE ${quoteIdentifier(tableName)} (\n  ${definitions.join(",\n  ")}\n) ENGINE=InnoDB`,
    );
  }
}

async function readRevision(
  connection: Connection,
  expectedRevision: number,
): Promise<void> {
  const [rows] = await connection.query(
    "SELECT revision FROM institution_readiness_fences WHERE institution_id = 1",
  );
  const revision = Number(
    (rows as readonly { revision?: number | string }[])[0]?.revision,
  );
  if (revision !== expectedRevision) {
    throw new Error(
      `READINESS_FENCE_V1_PROOF_REVISION_EXPECTED_${expectedRevision}_GOT_${revision}`,
    );
  }
}

async function assertTriggerCoverage(connection: Connection): Promise<void> {
  const [rows] = await connection.query(
    [
      "SELECT COUNT(*) AS triggerCount",
      "FROM INFORMATION_SCHEMA.TRIGGERS",
      "WHERE TRIGGER_SCHEMA = DATABASE()",
      "  AND TRIGGER_NAME LIKE 'trg_rdf_%'",
    ].join("\n"),
  );
  const triggerCount = Number(
    (rows as readonly { triggerCount?: number | string }[])[0]?.triggerCount,
  );
  if (triggerCount !== 40) {
    throw new Error(
      `READINESS_FENCE_V1_PROOF_TRIGGER_COUNT_EXPECTED_40_GOT_${triggerCount}`,
    );
  }
}

async function assertExactInstallationMarker(
  connection: Connection,
): Promise<void> {
  const [rows] = await connection.query(
    "SELECT COUNT(*) AS markerCount FROM institution_readiness_fence_installations",
  );
  const markerCount = Number(
    (rows as readonly { markerCount?: number | string }[])[0]?.markerCount,
  );
  if (markerCount !== 1) {
    throw new Error(
      `READINESS_FENCE_V1_PROOF_MARKER_COUNT_EXPECTED_1_GOT_${markerCount}`,
    );
  }
}

async function proveRevisionTriggers(connection: Connection): Promise<void> {
  await connection.query(
    "INSERT INTO users (id, email, approval_status, deleted_at) VALUES (10, 'proof-before@example.test', 'APPROVED', NULL)",
  );
  await connection.query(
    "INSERT INTO professionals (id, user_id) VALUES (20, 10)",
  );

  await connection.query(
    "INSERT INTO institutions (id, is_active) VALUES (1, 1)",
  );
  await readRevision(connection, 1);
  await connection.query(
    "INSERT INTO hospitals (id, institution_id) VALUES (2, 1)",
  );
  await readRevision(connection, 2);
  await connection.query(
    "INSERT INTO sectors (id, institution_id, hospital_id) VALUES (3, 1, 2)",
  );
  await readRevision(connection, 3);
  await connection.query(
    "INSERT INTO schedule_contexts (id, institution_id, hospital_id, sector_id, active) VALUES (4, 1, 2, 3, 1)",
  );
  await readRevision(connection, 4);
  await connection.query(
    "INSERT INTO shift_templates (id, institution_id, hospital_id, sector_id) VALUES (5, 1, 2, 3)",
  );
  await readRevision(connection, 5);
  await connection.query(
    "INSERT INTO shift_instances (id, institution_id, hospital_id, sector_id, schedule_context_id) VALUES (6, 1, 2, 3, 4)",
  );
  await readRevision(connection, 6);
  await connection.query(
    "INSERT INTO shift_assignments_v2 (id, institution_id, hospital_id, sector_id, shift_instance_id, professional_id) VALUES (7, 1, 2, 3, 6, 20)",
  );
  await readRevision(connection, 7);
  await connection.query(
    "INSERT INTO professional_institutions (id, institution_id, professional_id, user_id, active) VALUES (8, 1, 20, 10, 1)",
  );
  await readRevision(connection, 8);
  await connection.query(
    "INSERT INTO professional_access (id, institution_id, professional_id, hospital_id, sector_id, can_access) VALUES (9, 1, 20, 2, 3, 1)",
  );
  await readRevision(connection, 9);
  await connection.query(
    "INSERT INTO manager_scope (id, institution_id, manager_professional_id, hospital_id, sector_id, active) VALUES (10, 1, 20, 2, 3, 1)",
  );
  await readRevision(connection, 10);
  await connection.query(
    "INSERT INTO monthly_rosters (id, institution_id, hospital_id) VALUES (11, 1, 2)",
  );
  await readRevision(connection, 11);
  await connection.query(
    "INSERT INTO push_tokens (id, user_id) VALUES (12, 10)",
  );
  await readRevision(connection, 12);
  await connection.query(
    "UPDATE schedule_contexts SET active = 0 WHERE id = 4",
  );
  await readRevision(connection, 13);
  await connection.query(
    "UPDATE users SET email = 'proof-after@example.test' WHERE id = 10",
  );
  await readRevision(connection, 14);
  await connection.query("DELETE FROM push_tokens WHERE id = 12");
  await readRevision(connection, 15);

  await connection.query("DELETE FROM institutions WHERE id = 1");
  const [fenceRows] = await connection.query(
    "SELECT institution_id FROM institution_readiness_fences WHERE institution_id = 1",
  );
  if ((fenceRows as readonly unknown[]).length !== 0) {
    throw new Error("READINESS_FENCE_V1_PROOF_CASCADE_DELETE_FAILED");
  }
}

/**
 * Cria a fixture mínima, aplica a migration duas vezes e comprova revisões
 * reais. Não é incluída no test runner padrão; é uma prova explícita de MySQL.
 */
export async function runReadinessFenceV1MigrationProof(
  env: Environment = process.env,
): Promise<Readonly<{ databaseName: string; finalRevision: number }>> {
  const proof = validateReadinessFenceV1ProofEnvironment(env);
  const serverConnection = await mysql.createConnection(proof.serverUrl);
  let schemaCreated = false;
  let proofCompleted = false;

  try {
    await serverConnection.query(
      `CREATE DATABASE ${quoteIdentifier(proof.databaseName)}`,
    );
    schemaCreated = true;
    const connection = await mysql.createConnection(proof.databaseUrl);
    try {
      await createMinimalSourceSchema(connection);
      await applyReadinessFenceV1Migration({
        explicitApproval: true,
        databaseUrl: proof.databaseUrl,
        allowInsecureLoopbackForTest: true,
      });
      await applyReadinessFenceV1Migration({
        explicitApproval: true,
        databaseUrl: proof.databaseUrl,
        allowInsecureLoopbackForTest: true,
      });
      await assertTriggerCoverage(connection);
      await assertExactInstallationMarker(connection);
      await proveRevisionTriggers(connection);
      proofCompleted = true;
      return Object.freeze({
        databaseName: proof.databaseName,
        finalRevision: 15,
      });
    } finally {
      await connection.end();
    }
  } finally {
    try {
      if (schemaCreated && proofCompleted) {
        await serverConnection.query(
          `DROP DATABASE ${quoteIdentifier(proof.databaseName)}`,
        );
      }
    } finally {
      await serverConnection.end();
    }
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]))
) {
  runReadinessFenceV1MigrationProof()
    .then(({ databaseName, finalRevision }) => {
      console.log(
        `Readiness fence V1 comprovada em schema efêmero ${databaseName} (revisão ${finalRevision}).`,
      );
    })
    .catch((error) => {
      console.error(
        "Falha na prova local da readiness fence V1:",
        error instanceof Error ? error.message : "erro desconhecido",
      );
      process.exitCode = 1;
    });
}
