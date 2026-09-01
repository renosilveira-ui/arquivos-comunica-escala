import { beforeEach, describe, expect, it, vi } from "vitest";
import * as readinessFence from "../server/readiness-fence-v1";
import {
  withReadinessFenceV1Transaction,
  type InstitutionReadinessFenceV1Lock,
  type ReadinessFenceV1Scope,
} from "../server/readiness-fence-v1";
import {
  READINESS_FENCE_V1_COVERAGE_HASH,
  READINESS_FENCE_V1_COVERAGE_VERSION,
  READINESS_FENCE_V1_FUTURE_CONSUMER_REQUIREMENTS,
  READINESS_FENCE_V1_INSTALLATION_ID,
  READINESS_FENCE_V1_RECEIPT_ROLE,
} from "../server/readiness-fence-v1-contract";
import { getDb } from "../server/db";

vi.mock("../server/db", () => ({ getDb: vi.fn() }));

const getDbMock = vi.mocked(getDb);

const validMarker = [
  {
    installationId: READINESS_FENCE_V1_INSTALLATION_ID,
    coverageVersion: READINESS_FENCE_V1_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_V1_COVERAGE_HASH,
  },
];

function transactionHarness(executeRows: unknown[][]) {
  const events: string[] = [];
  const onDuplicateKeyUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onDuplicateKeyUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const rows = [...executeRows];
  const execute = vi.fn().mockImplementation(async () => {
    events.push("transaction.execute");
    return [rows.shift() ?? [], []];
  });
  const tx = { insert, execute };
  const transaction = vi.fn(
    async (operation: (value: typeof tx) => unknown) => {
      events.push("transaction.begin");
      try {
        return await operation(tx);
      } finally {
        events.push("transaction.end");
      }
    },
  );
  const autocommit = {
    execute: vi.fn(),
    insert: vi.fn(),
  };
  getDbMock.mockResolvedValue({
    ...autocommit,
    transaction,
  } as never);
  return {
    autocommit,
    events,
    execute,
    insert,
    onDuplicateKeyUpdate,
    transaction,
    values,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readiness fence V1", () => {
  it("não expõe aprovação, snapshot nem helpers que aceitem tx estrutural", () => {
    expect("createReadinessFenceAcknowledgementBinding" in readinessFence).toBe(
      false,
    );
    expect("approveReadinessFence" in readinessFence).toBe(false);
    expect("bindClientReadinessSnapshot" in readinessFence).toBe(false);
    expect(
      "materializeAndLockInstitutionReadinessFenceV1" in readinessFence,
    ).toBe(false);
    expect("assertInstitutionReadinessFenceV1Unchanged" in readinessFence).toBe(
      false,
    );
    expect("assertCompleteReadinessFenceV1Installation" in readinessFence).toBe(
      false,
    );
    expect("withReadinessFenceV1Transaction" in readinessFence).toBe(true);
  });

  it("trata recibo como pré-requisito técnico, nunca autoridade de prontidão", () => {
    expect(READINESS_FENCE_V1_RECEIPT_ROLE).toBe(
      "INSTALLATION_PREREQUISITE_ONLY",
    );
    expect(READINESS_FENCE_V1_FUTURE_CONSUMER_REQUIREMENTS).toEqual([
      "VERIFY_CURRENT_CATALOG_IN_SAME_TRANSACTION",
      "VERIFY_TRIGGER_COVERAGE_IN_SAME_TRANSACTION",
    ]);
  });

  it("rejeita objeto de db estrutural em autocommit antes de qualquer query", async () => {
    const autocommit = { execute: vi.fn(), insert: vi.fn() };
    getDbMock.mockResolvedValue(autocommit as never);

    await expect(
      withReadinessFenceV1Transaction(async () => undefined),
    ).rejects.toThrow("READINESS_FENCE_V1_TRANSACTION_UNAVAILABLE");
    expect(autocommit.execute).not.toHaveBeenCalled();
    expect(autocommit.insert).not.toHaveBeenCalled();
  });

  it("falha fechada sem recibo antes de executar o callback", async () => {
    const fixture = transactionHarness([[]]);
    const operation = vi.fn(async () => undefined);

    await expect(withReadinessFenceV1Transaction(operation)).rejects.toThrow(
      "READINESS_FENCE_V1_INSTALLATION_UNVERIFIED",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.autocommit.execute).not.toHaveBeenCalled();
  });

  it("mantém leitura, lock e rechecagem na mesma transação real", async () => {
    const fixture = transactionHarness([
      validMarker,
      validMarker,
      [{ institutionId: "7", revision: "9007199254740993" }],
      validMarker,
      [{ institutionId: "7", revision: "9007199254740993" }],
    ]);

    await expect(
      withReadinessFenceV1Transaction(async (scope) => {
        expect(Object.isFrozen(scope)).toBe(true);
        const lock = await scope.materializeAndLockInstitution(7);
        expect(lock).toEqual({ institutionId: 7, revision: 9007199254740993n });
        return scope.assertInstitutionUnchanged(lock);
      }),
    ).resolves.toEqual({ institutionId: 7, revision: 9007199254740993n });

    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.values).toHaveBeenCalledWith({ institutionId: 7 });
    expect(fixture.onDuplicateKeyUpdate).toHaveBeenCalledTimes(1);
    expect(fixture.autocommit.execute).not.toHaveBeenCalled();
    expect(fixture.autocommit.insert).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      "transaction.begin",
      "transaction.execute",
      "transaction.execute",
      "transaction.execute",
      "transaction.execute",
      "transaction.execute",
      "transaction.end",
    ]);
  });

  it("rejeita recibo divergente, duplicado ou malformado", async () => {
    for (const rows of [
      [
        {
          ...validMarker[0],
          coverageHash: "b".repeat(64),
        },
      ],
      [...validMarker, { ...validMarker[0], installationId: 2 }],
      [{ ...validMarker[0], installationId: "01" }],
    ]) {
      transactionHarness([rows]);
      await expect(
        withReadinessFenceV1Transaction(async (scope) =>
          scope.materializeAndLockInstitution(7),
        ),
      ).rejects.toThrow("READINESS_FENCE_V1_INSTALLATION_UNVERIFIED");
    }
  });

  it("rejeita resultado de driver com instituição ou revisão não canônica", async () => {
    for (const row of [
      { institutionId: 8, revision: "2" },
      { institutionId: 7, revision: "-1" },
      { institutionId: 7, revision: "01" },
    ]) {
      transactionHarness([validMarker, validMarker, [row]]);
      await expect(
        withReadinessFenceV1Transaction(async (scope) =>
          scope.materializeAndLockInstitution(7),
        ),
      ).rejects.toThrow("READINESS_FENCE_V1_INTEGRITY_FAILURE");
    }
  });

  it("não aceita lock criado pelo chamador", async () => {
    transactionHarness([validMarker]);
    await expect(
      withReadinessFenceV1Transaction(async (scope) =>
        scope.assertInstitutionUnchanged({ institutionId: 7, revision: 1n }),
      ),
    ).rejects.toThrow("READINESS_FENCE_V1_UNISSUED_LOCK");
  });

  it("invalida scope retida depois do commit da transação", async () => {
    const fixture = transactionHarness([
      validMarker,
      validMarker,
      [{ institutionId: 7, revision: "12" }],
    ]);
    let retainedScope!: ReadinessFenceV1Scope;
    let lock!: InstitutionReadinessFenceV1Lock;

    await withReadinessFenceV1Transaction(async (scope) => {
      retainedScope = scope;
      lock = await scope.materializeAndLockInstitution(7);
    });

    expect(() => retainedScope.assertInstitutionUnchanged(lock)).toThrow(
      "READINESS_FENCE_V1_SCOPE_INACTIVE",
    );
    expect(fixture.execute).toHaveBeenCalledTimes(3);
  });

  it("vincula lock à transação que o emitiu", async () => {
    transactionHarness([
      validMarker,
      validMarker,
      [{ institutionId: 7, revision: "12" }],
    ]);
    let firstLock!: InstitutionReadinessFenceV1Lock;
    await withReadinessFenceV1Transaction(async (scope) => {
      firstLock = await scope.materializeAndLockInstitution(7);
    });

    transactionHarness([validMarker]);
    await expect(
      withReadinessFenceV1Transaction(async (scope) =>
        scope.assertInstitutionUnchanged(firstLock),
      ),
    ).rejects.toThrow("READINESS_FENCE_V1_LOCK_TRANSACTION_MISMATCH");
  });

  it("rejeita revisão alterada entre leitura e rechecagem", async () => {
    transactionHarness([
      validMarker,
      validMarker,
      [{ institutionId: 7, revision: "11" }],
      validMarker,
      [{ institutionId: 7, revision: "12" }],
    ]);
    await expect(
      withReadinessFenceV1Transaction(async (scope) => {
        const lock = await scope.materializeAndLockInstitution(7);
        return scope.assertInstitutionUnchanged(lock);
      }),
    ).rejects.toThrow("READINESS_FENCE_V1_CHANGED");
  });
});
