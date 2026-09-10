/**
 * Marca um schema MySQL local como alvo descartável da suíte padrão.
 *
 * A primeira preparação só é aceita depois do schema Drizzle existir e
 * enquanto nenhuma tabela contiver dados. Depois disso, o mesmo marcador
 * torna a preparação idempotente sem transformar apenas o nome do banco em
 * autorização destrutiva.
 */
import "dotenv/config";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql, { type Connection } from "mysql2/promise";

import {
  assertConnectedDatabaseName,
  assertDisposableTestTargetMarker,
  DISPOSABLE_TEST_TARGET_MARKER_SELECT,
  DISPOSABLE_TEST_TARGET_MARKER_TABLE,
  DISPOSABLE_TEST_TARGET_REQUIRED_TABLES,
  validateStandardTestDestructiveTarget,
  type DestructiveTargetEnvironment,
  type ValidatedStandardTestDestructiveTarget,
} from "./destructive-target-fence";

type QueryConnection = Pick<Connection, "query" | "end">;

type PrepareStandardTestDatabaseOptions = {
  env?: DestructiveTargetEnvironment;
  openConnection?: (
    target: ValidatedStandardTestDestructiveTarget,
  ) => Promise<QueryConnection>;
};

function rowsFromQuery(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) && Array.isArray(result[0])
    ? (result[0] as Record<string, unknown>[])
    : [];
}

function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

async function defaultOpenConnection(
  target: ValidatedStandardTestDestructiveTarget,
): Promise<QueryConnection> {
  return mysql.createConnection(target.databaseUrl);
}

export async function prepareStandardTestDatabase(
  options: PrepareStandardTestDatabaseOptions = {},
): Promise<ValidatedStandardTestDestructiveTarget> {
  const target = validateStandardTestDestructiveTarget(
    options.env ?? process.env,
  );
  const connection = await (options.openConnection ?? defaultOpenConnection)(
    target,
  );

  try {
    const databaseResult = await connection.query(
      "SELECT DATABASE() AS database_name",
    );
    assertConnectedDatabaseName(
      rowsFromQuery(databaseResult)[0]?.database_name,
      target.databaseName,
      "Connected test database",
    );

    const tablesResult = await connection.query(
      "SELECT TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' " +
        "ORDER BY TABLE_NAME",
    );
    const tableNames = rowsFromQuery(tablesResult).map((row) =>
      String(row.table_name),
    );

    if (
      DISPOSABLE_TEST_TARGET_REQUIRED_TABLES.some(
        (tableName) => !tableNames.includes(tableName),
      )
    ) {
      throw new Error(
        "Disposable test target must contain the application schema before it can be prepared.",
      );
    }
    if (tableNames.includes(DISPOSABLE_TEST_TARGET_MARKER_TABLE)) {
      assertDisposableTestTargetMarker(
        await connection.query(DISPOSABLE_TEST_TARGET_MARKER_SELECT),
        target,
      );
      return target;
    }

    for (const tableName of tableNames) {
      const presenceResult = await connection.query(
        `SELECT EXISTS(SELECT 1 FROM ${quoteMysqlIdentifier(tableName)} LIMIT 1) AS has_rows`,
      );
      if (Number(rowsFromQuery(presenceResult)[0]?.has_rows) !== 0) {
        throw new Error(
          "Disposable test target must be empty before its first preparation.",
        );
      }
    }

    await connection.query(
      `CREATE TABLE ${quoteMysqlIdentifier(DISPOSABLE_TEST_TARGET_MARKER_TABLE)} (` +
        "id TINYINT UNSIGNED NOT NULL PRIMARY KEY, " +
        "database_name VARCHAR(64) NOT NULL, " +
        "marker_hash CHAR(64) NOT NULL, " +
        "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
        "CONSTRAINT chk_disposable_test_target_singleton CHECK (id = 1)) ENGINE=InnoDB",
    );
    await connection.query(
      `INSERT INTO ${quoteMysqlIdentifier(DISPOSABLE_TEST_TARGET_MARKER_TABLE)} ` +
        "(id, database_name, marker_hash) VALUES (1, ?, ?)",
      [target.databaseName, target.markerHash],
    );
    assertDisposableTestTargetMarker(
      await connection.query(DISPOSABLE_TEST_TARGET_MARKER_SELECT),
      target,
    );
    return target;
  } finally {
    await connection.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]))
) {
  void prepareStandardTestDatabase()
    .then((target) => {
      console.log(
        `Disposable test target prepared: ${target.host}:${target.port}/${target.databaseName} (${target.fingerprint})`,
      );
    })
    .catch((error) => {
      const safeMessage =
        error instanceof Error &&
        /^(?:Standard test seed|TEST_DATABASE_|Connected test database|Disposable test target)/.test(
          error.message,
        )
          ? error.message
          : "Disposable test target preparation failed.";
      console.error(safeMessage);
      process.exitCode = 1;
    });
}
