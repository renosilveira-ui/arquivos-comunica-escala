import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const TEST_SERVER_URL =
  process.env.CORE_SCHEMA_REPRO_MIGRATION_TEST_SERVER_URL;
const DATABASE_PREFIX = "escala_core_schema_repro_";

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

async function schemaSnapshot(database: Connection): Promise<string> {
  const [tables] = await database.query<RowDataPacket[]>(`
    SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME
  `);
  const [columns] = await database.query<RowDataPacket[]>(`
    SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE,
      IS_NULLABLE, COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME,
      COLLATION_NAME, GENERATION_EXPRESSION
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);
  const [indexes] = await database.query<RowDataPacket[]>(`
    SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
      COLLATION, SUB_PART, INDEX_TYPE, IS_VISIBLE
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  `);
  const [foreignKeyColumns] = await database.query<RowDataPacket[]>(`
    SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION,
      POSITION_IN_UNIQUE_CONSTRAINT, REFERENCED_TABLE_SCHEMA,
      REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
  `);
  const [foreignKeys] = await database.query<RowDataPacket[]>(`
    SELECT TABLE_NAME, CONSTRAINT_NAME, UNIQUE_CONSTRAINT_SCHEMA,
      UNIQUE_CONSTRAINT_NAME, MATCH_OPTION, UPDATE_RULE, DELETE_RULE
    FROM information_schema.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, CONSTRAINT_NAME
  `);
  const [checks] = await database.query<RowDataPacket[]>(`
    SELECT constraints.TABLE_NAME, constraints.CONSTRAINT_NAME,
      checks.CHECK_CLAUSE
    FROM information_schema.TABLE_CONSTRAINTS AS constraints
    INNER JOIN information_schema.CHECK_CONSTRAINTS AS checks
      ON checks.CONSTRAINT_SCHEMA = constraints.CONSTRAINT_SCHEMA
      AND checks.CONSTRAINT_NAME = constraints.CONSTRAINT_NAME
    WHERE constraints.CONSTRAINT_SCHEMA = DATABASE()
      AND constraints.CONSTRAINT_TYPE = 'CHECK'
    ORDER BY constraints.TABLE_NAME, constraints.CONSTRAINT_NAME
  `);
  return JSON.stringify([
    tables,
    columns,
    indexes,
    foreignKeyColumns,
    foreignKeys,
    checks,
  ]);
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
          id INT NOT NULL AUTO_INCREMENT,
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

  async function expectPreflightRejectionWithoutSchemaChange(
    database: Connection,
  ): Promise<void> {
    const before = await schemaSnapshot(database);
    await expect(database.query(migration)).rejects.toMatchObject({
      code: "ER_NO_SUCH_TABLE",
      message: expect.stringContaining(
        "core_schema_reproducibility_contract_mismatch",
      ),
    });
    expect(await schemaSnapshot(database)).toBe(before);
  }

  it("instala os contratos ausentes e reaplica sem alterar dados", async () => {
    await withSchema(async (database) => {
      await database.query("INSERT INTO institutions (id) VALUES (1)");
      await database.query(
        "INSERT INTO shift_instances (institution_id, label) VALUES (1, 'legado')",
      );

      await database.query(migration);
      const afterFirstRun = await schemaSnapshot(database);
      await database.query(migration);
      expect(await schemaSnapshot(database)).toBe(afterFirstRun);

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
      await expectPreflightRejectionWithoutSchemaChange(database);
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

      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa institutions.id unsigned antes do primeiro DDL", async () => {
    await withSchema(async (database) => {
      await database.query(`
        ALTER TABLE institutions
        MODIFY COLUMN id INT UNSIGNED NOT NULL AUTO_INCREMENT
      `);
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa PRIMARY composta mesmo quando id é a primeira coluna", async () => {
    await withSchema(async (database) => {
      await database.query(`
        ALTER TABLE institutions
        ADD COLUMN shard_id INT NOT NULL DEFAULT 1,
        DROP PRIMARY KEY,
        ADD PRIMARY KEY (id, shard_id)
      `);
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa engine incompatível antes do primeiro DDL", async () => {
    await withSchema(async (database) => {
      await database.query("ALTER TABLE shift_instances ENGINE=MyISAM");
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa collation divergente nas colunas de modalidade", async () => {
    await withSchema(async (database) => {
      await database.query(`
        ALTER TABLE shift_instances
          ADD COLUMN modality ENUM('PLANTAO','SOBREAVISO')
            CHARACTER SET latin1 COLLATE latin1_swedish_ci
            NOT NULL DEFAULT 'PLANTAO',
          ADD COLUMN coverage_type ENUM('URGENCIA_EMERGENCIA','ELETIVAS') NULL,
          ADD COLUMN payment_model ENUM(
            'FIXO','FIXO_PRODUTIVIDADE_TETO',
            'FIXO_PRODUTIVIDADE_SEM_TETO','PRODUTIVIDADE_PURA'
          ) NOT NULL DEFAULT 'FIXO',
          ADD COLUMN productivity_cap_brl DECIMAL(12,2) NULL
      `);
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa ENUMs com caixa divergente antes do primeiro DDL", async () => {
    await withSchema(async (database) => {
      await database.query(`
        ALTER TABLE shift_instances
          ADD COLUMN modality ENUM('plantao','sobreaviso')
            NOT NULL DEFAULT 'plantao',
          ADD COLUMN coverage_type ENUM('urgencia_emergencia','eletivas') NULL,
          ADD COLUMN payment_model ENUM(
            'fixo','fixo_produtividade_teto',
            'fixo_produtividade_sem_teto','produtividade_pura'
          ) NOT NULL DEFAULT 'fixo',
          ADD COLUMN productivity_cap_brl DECIMAL(12,2) NULL
      `);
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa índice de modalidade homônimo com ordem incompatível", async () => {
    await withSchema(async (database) => {
      await database.query(`
        ALTER TABLE shift_instances
          ADD COLUMN modality ENUM('PLANTAO','SOBREAVISO')
            NOT NULL DEFAULT 'PLANTAO',
          ADD COLUMN coverage_type ENUM('URGENCIA_EMERGENCIA','ELETIVAS') NULL,
          ADD COLUMN payment_model ENUM(
            'FIXO','FIXO_PRODUTIVIDADE_TETO',
            'FIXO_PRODUTIVIDADE_SEM_TETO','PRODUTIVIDADE_PURA'
          ) NOT NULL DEFAULT 'FIXO',
          ADD COLUMN productivity_cap_brl DECIMAL(12,2) NULL,
          ADD INDEX idx_shift_instances_modality (modality, institution_id)
      `);
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa índice de modalidade invisível antes do primeiro DDL", async () => {
    await withSchema(async (database) => {
      await database.query(`
        ALTER TABLE shift_instances
          ADD COLUMN modality ENUM('PLANTAO','SOBREAVISO')
            NOT NULL DEFAULT 'PLANTAO',
          ADD COLUMN coverage_type ENUM('URGENCIA_EMERGENCIA','ELETIVAS') NULL,
          ADD COLUMN payment_model ENUM(
            'FIXO','FIXO_PRODUTIVIDADE_TETO',
            'FIXO_PRODUTIVIDADE_SEM_TETO','PRODUTIVIDADE_PURA'
          ) NOT NULL DEFAULT 'FIXO',
          ADD COLUMN productivity_cap_brl DECIMAL(12,2) NULL,
          ADD INDEX idx_shift_instances_modality (institution_id, modality)
      `);
      await database.query(
        "ALTER TABLE shift_instances ALTER INDEX idx_shift_instances_modality INVISIBLE",
      );
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa FK homônima em outra tabela antes do primeiro DDL", async () => {
    await withSchema(async (database) => {
      await database.query(`
        CREATE TABLE conflicting_fk_owner (
          id INT NOT NULL AUTO_INCREMENT,
          institution_id INT NOT NULL,
          PRIMARY KEY (id),
          CONSTRAINT fk_institution_config_institution
            FOREIGN KEY (institution_id) REFERENCES institutions(id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa FK existente com ação incompatível antes de alterar turnos", async () => {
    await withSchema(async (database) => {
      await database.query(`
        CREATE TABLE institution_config (
          id INT NOT NULL AUTO_INCREMENT,
          institution_id INT NOT NULL,
          edit_window_days INT NOT NULL DEFAULT 3,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY institution_config_institution_id_unique (institution_id),
          KEY idx_institution_config_institution_id (institution_id, id),
          CONSTRAINT fk_institution_config_institution
            FOREIGN KEY (institution_id) REFERENCES institutions(id)
            ON DELETE RESTRICT
        ) ENGINE=InnoDB
      `);
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });

  it("recusa CHECK extra em institution_config antes de alterar turnos", async () => {
    await withSchema(async (database) => {
      await database.query(`
        CREATE TABLE institution_config (
          id INT NOT NULL AUTO_INCREMENT,
          institution_id INT NOT NULL,
          edit_window_days INT NOT NULL DEFAULT 3,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY institution_config_institution_id_unique (institution_id),
          KEY idx_institution_config_institution_id (institution_id, id),
          CONSTRAINT fk_institution_config_institution
            FOREIGN KEY (institution_id) REFERENCES institutions(id)
            ON DELETE CASCADE,
          CONSTRAINT unexpected_edit_window_check
            CHECK (edit_window_days >= 0)
        ) ENGINE=InnoDB
      `);
      await expectPreflightRejectionWithoutSchemaChange(database);
    });
  });
});
