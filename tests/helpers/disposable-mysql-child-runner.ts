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

  async executeVerifiedStatement(
    statement: string,
    values: unknown[] = [],
  ): Promise<void> {
    if (
      !/^(?:DELETE\s+FROM|DROP\s+|ALTER\s+TABLE\s+.+\s+DROP\s+)/is.test(
        statement.trim(),
      )
    ) {
      throw new Error(
        "Verified destructive execution accepts only DELETE or DROP statements.",
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
