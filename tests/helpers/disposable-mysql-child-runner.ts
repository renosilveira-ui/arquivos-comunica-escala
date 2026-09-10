import mysql, {
  type Connection,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";

import {
  assertConnectedDatabaseName,
  assertDisposableTestTargetMarker,
  deriveDisposableChildTestTarget,
  DISPOSABLE_TEST_TARGET_MARKER_SELECT,
  DISPOSABLE_TEST_TARGET_MARKER_TABLE,
  validateStandardTestDestructiveTarget,
  type DestructiveTargetEnvironment,
  type ValidatedStandardTestDestructiveTarget,
} from "../../scripts/destructive-target-fence";

export type DisposableChildCheckpoint =
  "PARENT_PROVED" | "CHILD_CREATED" | "CHILD_CONNECTED" | "CHILD_MARKED";

type ChildCreationReceipt = Readonly<{
  childDatabaseName: string;
  childFingerprint: string;
  parentFingerprint: string;
}>;

type LifecycleHooks = {
  checkpoint?: (checkpoint: DisposableChildCheckpoint) => void | Promise<void>;
  closePool?: (pool: Pool) => Promise<void>;
  closeParent?: (parent: Connection) => Promise<void>;
};

type CreateDisposableMysqlChildOptions = {
  childDatabaseName: string;
  env?: DestructiveTargetEnvironment;
  namespace: string;
  hooks?: LifecycleHooks;
};

function connectionOptions(target: ValidatedStandardTestDestructiveTarget) {
  const url = new URL(target.databaseUrl);
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: target.databaseName,
  };
}

function quoteDatabaseName(databaseName: string): string {
  if (
    !/^escalas(?:_test(?:_[a-z0-9_]+)?|_[a-z0-9_]+_test)$/.test(databaseName)
  ) {
    throw new Error("Disposable child database name is no longer safe.");
  }
  return `\`${databaseName}\``;
}

function quoteUnqualifiedIdentifier(identifier: string): string {
  if (
    identifier.length === 0 ||
    identifier.length > 64 ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)
  ) {
    throw new Error(
      "Destructive target must be an unqualified MySQL identifier.",
    );
  }
  return `\`${identifier}\``;
}

function qualifiedChildMarkerSelect(databaseName: string): string {
  return (
    "SELECT database_name, marker_hash FROM " +
    `${quoteDatabaseName(databaseName)}.\`${DISPOSABLE_TEST_TARGET_MARKER_TABLE}\` ` +
    "WHERE id = 1 LIMIT 2"
  );
}

async function assertMarkedTarget(
  connection: Connection | PoolConnection,
  target: ValidatedStandardTestDestructiveTarget,
  markerSelect = DISPOSABLE_TEST_TARGET_MARKER_SELECT,
): Promise<void> {
  const [databaseRows] = await connection.query<RowDataPacket[]>(
    "SELECT DATABASE() AS database_name",
  );
  assertConnectedDatabaseName(
    databaseRows[0]?.database_name,
    target.databaseName,
    "Connected disposable test database",
  );
  assertDisposableTestTargetMarker(
    await connection.query(markerSelect),
    target,
  );
}

export class DisposableMysqlChildRunner {
  readonly parentTarget: ValidatedStandardTestDestructiveTarget;
  readonly childTarget: ValidatedStandardTestDestructiveTarget;

  private parent: Connection | null = null;
  private childPool: Pool | null = null;
  private creationReceipt: ChildCreationReceipt | null = null;
  private markerInstalled = false;
  private cleanupStarted = false;

  private constructor(
    parentTarget: ValidatedStandardTestDestructiveTarget,
    childTarget: ValidatedStandardTestDestructiveTarget,
    private readonly hooks: LifecycleHooks,
  ) {
    this.parentTarget = parentTarget;
    this.childTarget = childTarget;
  }

  static async create(
    options: CreateDisposableMysqlChildOptions,
  ): Promise<DisposableMysqlChildRunner> {
    const parentTarget = validateStandardTestDestructiveTarget(
      options.env ?? process.env,
    );
    const childTarget = deriveDisposableChildTestTarget(
      parentTarget,
      options.childDatabaseName,
      options.namespace,
    );
    const runner = new DisposableMysqlChildRunner(
      parentTarget,
      childTarget,
      options.hooks ?? {},
    );

    try {
      await runner.initialize();
      return runner;
    } catch (initializationError) {
      try {
        await runner.cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [initializationError, cleanupError],
          "Disposable child initialization and cleanup both failed.",
        );
      }
      throw initializationError;
    }
  }

  get pool(): Pool {
    if (!this.childPool || !this.markerInstalled) {
      throw new Error("Disposable child is not fully prepared.");
    }
    return this.childPool;
  }

  async deleteAllFrom(tableName: string): Promise<void> {
    const table = quoteUnqualifiedIdentifier(tableName);
    await this.executeVerifiedMutation(`DELETE FROM ${table}`);
  }

  async deleteByIntegerId(tableName: string, id: number): Promise<void> {
    const table = quoteUnqualifiedIdentifier(tableName);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Destructive row id must be a positive safe integer.");
    }
    await this.executeVerifiedMutation(`DELETE FROM ${table} WHERE id = ?`, [
      id,
    ]);
  }

  async dropTrigger(triggerName: string, ifExists = false): Promise<void> {
    const trigger = quoteUnqualifiedIdentifier(triggerName);
    await this.executeVerifiedMutation(
      `DROP TRIGGER ${ifExists ? "IF EXISTS " : ""}${trigger}`,
    );
  }

  async dropColumn(tableName: string, columnName: string): Promise<void> {
    await this.dropTableObject(tableName, "COLUMN", columnName);
  }

  async dropIndex(tableName: string, indexName: string): Promise<void> {
    await this.dropTableObject(tableName, "INDEX", indexName);
  }

  async dropForeignKey(
    tableName: string,
    constraintName: string,
  ): Promise<void> {
    await this.dropTableObject(tableName, "FOREIGN KEY", constraintName);
  }

  async dropCheck(tableName: string, constraintName: string): Promise<void> {
    await this.dropTableObject(tableName, "CHECK", constraintName);
  }

  async dropDefault(tableName: string, columnName: string): Promise<void> {
    const table = quoteUnqualifiedIdentifier(tableName);
    const column = quoteUnqualifiedIdentifier(columnName);
    await this.executeVerifiedMutation(
      `ALTER TABLE ${table} ALTER ${column} DROP DEFAULT`,
    );
  }

  private async dropTableObject(
    tableName: string,
    objectType: "CHECK" | "COLUMN" | "FOREIGN KEY" | "INDEX",
    objectName: string,
  ): Promise<void> {
    const table = quoteUnqualifiedIdentifier(tableName);
    const object = quoteUnqualifiedIdentifier(objectName);
    await this.executeVerifiedMutation(
      `ALTER TABLE ${table} DROP ${objectType} ${object}`,
    );
  }

  private async executeVerifiedMutation(
    statement: string,
    values: unknown[] = [],
  ): Promise<void> {
    if (statement.includes(";") || /\bDROP\s+DATABASE\b/i.test(statement)) {
      throw new Error(
        "Verified mutation must contain exactly one child operation.",
      );
    }
    const connection = await this.pool.getConnection();
    try {
      await assertMarkedTarget(connection, this.childTarget);
      await connection.query(statement, values);
    } finally {
      connection.release();
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    const errors: unknown[] = [];
    let dropAuthorized = false;

    if (this.creationReceipt && this.parent) {
      try {
        await assertMarkedTarget(this.parent, this.parentTarget);
        this.assertCreationReceipt();
        if (this.markerInstalled) {
          assertDisposableTestTargetMarker(
            await this.parent.query(
              qualifiedChildMarkerSelect(this.childTarget.databaseName),
            ),
            this.childTarget,
          );
        }
        dropAuthorized = true;
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      if (this.childPool) {
        if (this.hooks.closePool) {
          try {
            await this.hooks.closePool(this.childPool);
          } catch (error) {
            errors.push(error);
            await this.childPool.end();
          }
        } else {
          await this.childPool.end();
        }
      }
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        if (dropAuthorized && this.parent) {
          await this.parent.query(
            `DROP DATABASE ${quoteDatabaseName(this.childTarget.databaseName)}`,
          );
        }
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          if (this.parent) {
            if (this.hooks.closeParent) {
              try {
                await this.hooks.closeParent(this.parent);
              } catch (error) {
                errors.push(error);
                await this.parent.end();
              }
            } else {
              await this.parent.end();
            }
          }
        } catch (error) {
          errors.push(error);
        }
      }
    }

    this.childPool = null;
    this.parent = null;
    if (errors.length > 0) {
      throw new AggregateError(errors, "Disposable child cleanup failed.");
    }
  }

  private async initialize(): Promise<void> {
    this.parent = await mysql.createConnection({
      ...connectionOptions(this.parentTarget),
      multipleStatements: true,
    });
    await assertMarkedTarget(this.parent, this.parentTarget);
    const [version] = await this.parent.query<RowDataPacket[]>(
      "SELECT VERSION() AS version",
    );
    if (!/^8\./.test(String(version[0]?.version))) {
      throw new Error("Disposable child runner requires MySQL 8.");
    }
    await this.hooks.checkpoint?.("PARENT_PROVED");

    await this.parent.query(
      `CREATE DATABASE ${quoteDatabaseName(this.childTarget.databaseName)}`,
    );
    this.creationReceipt = Object.freeze({
      childDatabaseName: this.childTarget.databaseName,
      childFingerprint: this.childTarget.fingerprint,
      parentFingerprint: this.parentTarget.fingerprint,
    });
    await this.hooks.checkpoint?.("CHILD_CREATED");

    this.childPool = mysql.createPool({
      ...connectionOptions(this.childTarget),
      multipleStatements: true,
      connectionLimit: 8,
      timezone: "Z",
    });
    const [childDatabase] = await this.childPool.query<RowDataPacket[]>(
      "SELECT DATABASE() AS database_name",
    );
    assertConnectedDatabaseName(
      childDatabase[0]?.database_name,
      this.childTarget.databaseName,
      "Connected disposable child database",
    );
    await this.hooks.checkpoint?.("CHILD_CONNECTED");

    await this.childPool.query(
      `CREATE TABLE \`${DISPOSABLE_TEST_TARGET_MARKER_TABLE}\` (` +
        "id TINYINT UNSIGNED NOT NULL PRIMARY KEY, " +
        "database_name VARCHAR(64) NOT NULL, " +
        "marker_hash CHAR(64) NOT NULL, " +
        "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
        "CONSTRAINT chk_disposable_test_target_singleton CHECK (id = 1)" +
        ") ENGINE=InnoDB",
    );
    await this.childPool.query(
      `INSERT INTO \`${DISPOSABLE_TEST_TARGET_MARKER_TABLE}\` ` +
        "(id, database_name, marker_hash) VALUES (1, ?, ?)",
      [this.childTarget.databaseName, this.childTarget.markerHash],
    );
    assertDisposableTestTargetMarker(
      await this.childPool.query(DISPOSABLE_TEST_TARGET_MARKER_SELECT),
      this.childTarget,
    );
    this.markerInstalled = true;
    await this.hooks.checkpoint?.("CHILD_MARKED");
  }

  private assertCreationReceipt(): void {
    const receipt = this.creationReceipt;
    if (
      !receipt ||
      receipt.childDatabaseName !== this.childTarget.databaseName ||
      receipt.childFingerprint !== this.childTarget.fingerprint ||
      receipt.parentFingerprint !== this.parentTarget.fingerprint
    ) {
      throw new Error("Disposable child creation receipt is invalid.");
    }
  }
}
