import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const TEST_SERVER_URL =
  process.env.CORE_SCHEMA_REPRO_MIGRATION_TEST_SERVER_URL;
const DATABASE_PREFIX = "escala_core_schema_repro_";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const drizzleKitPath = resolve(
  repositoryRoot,
  "node_modules/drizzle-kit/bin.cjs",
);

type TestServer = {
  host: string;
  port: number;
  user: string;
  password: string;
};

function parseTestServer(raw: string | undefined): TestServer | null {
  if (!raw) return null;
  const url = new URL(raw);
  if (
    url.protocol !== "mysql:" ||
    !new Set(["127.0.0.1", "localhost", "::1"]).has(
      url.hostname.toLowerCase(),
    ) ||
    url.pathname !== "/mysql" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "CORE_SCHEMA_REPRO_MIGRATION_TEST_SERVER_URL deve apontar somente para mysql:// local e o schema mysql.",
    );
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function databaseName(): string {
  return `${DATABASE_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

function quoteIdentifier(identifier: string): string {
  if (!/^escala_core_schema_repro_[a-f0-9]{32}$/.test(identifier)) {
    throw new Error("Nome de schema descartável inválido.");
  }
  return `\`${identifier}\``;
}

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-09-core-schema-reproducibility.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseTestServer(TEST_SERVER_URL);
const describeWithMysql = server ? describe : describe.skip;

function databaseUrlFor(schema: string): string {
  if (!server) throw new Error("Servidor MySQL local não configurado.");
  const host = server.host.includes(":") ? `[${server.host}]` : server.host;
  return `mysql://${encodeURIComponent(server.user)}:${encodeURIComponent(server.password)}@${host}:${server.port}/${schema}`;
}

function runFreshSchemaPush(schema: string) {
  const result = spawnSync(
    process.execPath,
    [drizzleKitPath, "push", "--force"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrlFor(schema),
        DATABASE_SSL: "false",
        NODE_ENV: "test",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .replace(/mysql:\/\/[^:\s/]+:[^@\s/]+@/giu, "mysql://***:***@")
      .trim()
      .slice(-4_000);
    throw new Error(
      `drizzle-kit push falhou no schema descartável de reprodutibilidade (status ${String(result.status)}, sinal ${String(result.signal)})${diagnostic ? `\n${diagnostic}` : ""}`,
    );
  }
}

describeWithMysql("reprodutibilidade central em MySQL isolado", () => {
  let admin: Connection;
  const createdSchemas = new Set<string>();

  beforeAll(async () => {
    if (!server) throw new Error("Servidor MySQL local não configurado.");
    admin = await mysql.createConnection({ ...server, database: "mysql" });
  });

  afterAll(async () => {
    try {
      for (const schema of createdSchemas) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(schema)}`);
      }
    } finally {
      await admin?.end();
    }
  });

  async function withSchema(
    run: (database: Connection) => Promise<void>,
  ): Promise<void> {
    if (!server) throw new Error("Servidor MySQL local não configurado.");
    const schema = databaseName();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(schema)}`);
    createdSchemas.add(schema);
    const database = await mysql.createConnection({
      ...server,
      database: schema,
      multipleStatements: true,
    });
    try {
      await database.query(`
        CREATE TABLE institutions (
          id INT NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB;
        CREATE TABLE shift_instances (
          id INT NOT NULL AUTO_INCREMENT,
          institution_id INT NOT NULL,
          label VARCHAR(100) NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB;
      `);
      await run(database);
    } finally {
      await database.end();
    }
  }

  it("instala os contratos ausentes e reaplica sem alterar dados", async () => {
    await withSchema(async (database) => {
      await database.query("INSERT INTO institutions (id) VALUES (1)");
      await database.query(
        "INSERT INTO shift_instances (institution_id, label) VALUES (1, 'legado')",
      );

      await database.query(migration);
      await database.query(migration);

      const [shiftRows] = await database.query<RowDataPacket[]>(`
        SELECT label, modality, coverage_type, payment_model,
          productivity_cap_brl
        FROM shift_instances
      `);
      expect(shiftRows).toEqual([
        {
          label: "legado",
          modality: "PLANTAO",
          coverage_type: null,
          payment_model: "FIXO",
          productivity_cap_brl: null,
        },
      ]);

      await database.query(
        "INSERT INTO institution_config (institution_id) VALUES (1)",
      );
      const [configRows] = await database.query<RowDataPacket[]>(`
        SELECT institution_id, edit_window_days
        FROM institution_config
      `);
      expect(configRows).toEqual([{ institution_id: 1, edit_window_days: 3 }]);

      const [modalityIndex] = await database.query<RowDataPacket[]>(`
        SELECT NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'shift_instances'
          AND INDEX_NAME = 'idx_shift_instances_modality'
        ORDER BY SEQ_IN_INDEX
      `);
      expect(modalityIndex.map((row) => row.COLUMN_NAME)).toEqual([
        "institution_id",
        "modality",
      ]);

      await database.query("DELETE FROM institutions WHERE id = 1");
      const [afterCascade] = await database.query<RowDataPacket[]>(
        "SELECT id FROM institution_config",
      );
      expect(afterCascade).toEqual([]);
    });
  });

  it("recusa modalidade parcial antes de criar qualquer outro objeto", async () => {
    await withSchema(async (database) => {
      await database.query(
        "ALTER TABLE shift_instances ADD COLUMN modality VARCHAR(20) NULL",
      );

      await expect(database.query(migration)).rejects.toMatchObject({
        code: "ER_NO_SUCH_TABLE",
        message: expect.stringContaining(
          "core_schema_reproducibility_contract_mismatch",
        ),
      });

      const [newColumns] = await database.query<RowDataPacket[]>(`
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'shift_instances'
          AND COLUMN_NAME IN (
            'coverage_type', 'payment_model', 'productivity_cap_brl'
          )
      `);
      expect(newColumns).toEqual([]);
      const [configTable] = await database.query<RowDataPacket[]>(`
        SELECT TABLE_NAME
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'institution_config'
      `);
      expect(configTable).toEqual([]);
    });
  });

  it("recusa institution_config parcial antes de alterar os turnos", async () => {
    await withSchema(async (database) => {
      await database.query(`
        CREATE TABLE institution_config (
          id INT NOT NULL AUTO_INCREMENT,
          institution_id INT NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB
      `);

      await expect(database.query(migration)).rejects.toMatchObject({
        code: "ER_NO_SUCH_TABLE",
        message: expect.stringContaining(
          "core_schema_reproducibility_contract_mismatch",
        ),
      });

      const [modalityColumns] = await database.query<RowDataPacket[]>(`
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'shift_instances'
          AND COLUMN_NAME IN (
            'modality', 'coverage_type', 'payment_model', 'productivity_cap_brl'
          )
      `);
      expect(modalityColumns).toEqual([]);
    });
  });

  it("aceita o schema que o Drizzle instala hoje, sem reinstalar nada", async () => {
    // Os outros casos partem de uma `shift_instances` mínima e exercitam só o
    // ramo "contrato ausente". Uma instalação real chega pelo `drizzle-kit
    // push` com as colunas de modalidade e a institution_config já presentes,
    // ou seja pelo ramo em que o preflight compara o manifesto com a forma
    // que o catálogo devolve — e é exatamente aí que um literal transcrito do
    // DDL, em vez de lido do INFORMATION_SCHEMA, derruba a comparação e faz a
    // migration abortar em banco saudável.
    const schema = databaseName();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(schema)}`);
    createdSchemas.add(schema);
    runFreshSchemaPush(schema);
    const database = await mysql.createConnection({
      ...server!,
      database: schema,
      multipleStatements: true,
    });
    try {
      await database.query(migration);
      await database.query(migration);

      const [modality] = await database.query<RowDataPacket[]>(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'shift_instances'
          AND COLUMN_NAME IN (
            'modality', 'coverage_type', 'payment_model',
            'productivity_cap_brl'
          )
      `);
      expect(Number(modality[0]?.total)).toBe(4);
      const [config] = await database.query<RowDataPacket[]>(`
        SELECT COUNT(*) AS total
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'institution_config'
      `);
      expect(Number(config[0]?.total)).toBe(5);
    } finally {
      await database.end();
    }
  }, 120_000);
});
