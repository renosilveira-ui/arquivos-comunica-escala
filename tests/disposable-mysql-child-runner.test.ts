import { randomBytes } from "node:crypto";

import mysql, { type RowDataPacket } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

import {
  assertConnectedDatabaseName,
  assertDisposableTestTargetMarker,
  DISPOSABLE_TEST_TARGET_MARKER_SELECT,
  validateStandardTestDestructiveTarget,
} from "../scripts/destructive-target-fence";
import {
  DisposableMysqlChildRunner,
  type DisposableChildCheckpoint,
} from "./helpers/disposable-mysql-child-runner";

const CHILD_TARGET_NAMESPACE = "whatsapp-runner-lifecycle-v1";

function childDatabaseName(): string {
  return `escalas_test_wa_lifecycle_${process.pid}_${randomBytes(6).toString("hex")}`;
}

function parentConnectionOptions() {
  const target = validateStandardTestDestructiveTarget(process.env);
  const url = new URL(target.databaseUrl);
  return {
    target,
    options: {
      host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: target.databaseName,
    },
  };
}

async function databaseExists(databaseName: string): Promise<boolean> {
  const { target, options } = parentConnectionOptions();
  const observer = await mysql.createConnection(options);
  try {
    const [databaseRows] = await observer.query<RowDataPacket[]>(
      "SELECT DATABASE() AS database_name",
    );
    assertConnectedDatabaseName(
      databaseRows[0]?.database_name,
      target.databaseName,
      "Connected disposable lifecycle observer",
    );
    assertDisposableTestTargetMarker(
      await observer.query(DISPOSABLE_TEST_TARGET_MARKER_SELECT),
      target,
    );
    const [rows] = await observer.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      [databaseName],
    );
    return rows.length > 0;
  } finally {
    await observer.end();
  }
}

describe("disposable MySQL child lifecycle", () => {
  it.each<DisposableChildCheckpoint>([
    "PARENT_PROVED",
    "CHILD_CREATED",
    "CHILD_CONNECTED",
    "CHILD_MARKED",
  ])("removes the child after a %s checkpoint failure", async (checkpoint) => {
    const databaseName = childDatabaseName();

    await expect(
      DisposableMysqlChildRunner.create({
        childDatabaseName: databaseName,
        namespace: CHILD_TARGET_NAMESPACE,
        hooks: {
          checkpoint(current) {
            if (current === checkpoint) {
              throw new Error(`injected ${checkpoint} failure`);
            }
          },
        },
      }),
    ).rejects.toThrow(`injected ${checkpoint} failure`);

    await expect(databaseExists(databaseName)).resolves.toBe(false);
  });

  it("still drops the proven child when both close hooks report failures", async () => {
    const databaseName = childDatabaseName();
    const runner = await DisposableMysqlChildRunner.create({
      childDatabaseName: databaseName,
      namespace: CHILD_TARGET_NAMESPACE,
      hooks: {
        async closePool() {
          throw new Error("injected pool.end failure");
        },
        async closeParent() {
          throw new Error("injected admin.end failure");
        },
      },
    });

    const cleanupFailure = await runner
      .cleanup()
      .catch((error: unknown) => error);
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect(
      (cleanupFailure as AggregateError).errors.map((error) => String(error)),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("injected pool.end failure"),
        expect.stringContaining("injected admin.end failure"),
      ]),
    );
    await expect(databaseExists(databaseName)).resolves.toBe(false);
  });

  it("rejects chained, qualified and comment-based destructive targets before opening a connection", async () => {
    const databaseName = childDatabaseName();
    const runner = await DisposableMysqlChildRunner.create({
      childDatabaseName: databaseName,
      namespace: CHILD_TARGET_NAMESPACE,
    });
    const getConnection = vi.spyOn(runner.pool, "getConnection");

    try {
      for (const invalidOperation of [
        () =>
          runner.deleteAllFrom(
            "users; DROP DATABASE escalas_test_destructive_fence_v3",
          ),
        () => runner.deleteAllFrom("other_schema.users"),
        () => runner.dropTrigger("reject_account_audit/*bypass*/"),
        () => runner.dropTrigger("DROP DATABASE production"),
      ]) {
        await expect(invalidOperation()).rejects.toThrow(
          "unqualified MySQL identifier",
        );
      }
      expect(getConnection).not.toHaveBeenCalled();
    } finally {
      getConnection.mockRestore();
      await runner.cleanup();
    }
    await expect(databaseExists(databaseName)).resolves.toBe(false);
  });
});
