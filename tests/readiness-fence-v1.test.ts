import { beforeEach, describe, expect, it, vi } from "vitest";
import * as readinessFence from "../server/readiness-fence-v1";
import {
  captureInstitutionReadinessFenceV1HighWatermark,
  withReadinessFenceV1FinalDecisionTransaction,
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

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return Object.freeze({ promise, resolve });
}

function databaseHarness(
  input: Readonly<{
    captureRows?: unknown[][];
    transactionRows?: unknown[][];
  }>,
) {
  const events: string[] = [];
  const captureRows = [...(input.captureRows ?? [])];
  const transactionRows = [...(input.transactionRows ?? [])];
  const execute = vi.fn().mockImplementation(async () => {
    events.push("capture.execute");
    return [captureRows.shift() ?? [], []];
  });
  const transactionExecute = vi.fn().mockImplementation(async () => {
    events.push("transaction.execute");
    return [transactionRows.shift() ?? [], []];
  });
  const tx = { execute: transactionExecute };
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
  getDbMock.mockResolvedValue({ execute, transaction } as never);
  return { events, execute, transaction, transactionExecute, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readiness fence V1", () => {
  it("não expõe aprovação, snapshot ou a antiga trava longa por revisão", () => {
    expect("createReadinessFenceAcknowledgementBinding" in readinessFence).toBe(
      false,
    );
    expect("approveReadinessFence" in readinessFence).toBe(false);
    expect("bindClientReadinessSnapshot" in readinessFence).toBe(false);
    expect("materializeAndLockInstitution" in readinessFence).toBe(false);
    expect("assertInstitutionUnchanged" in readinessFence).toBe(false);
    expect("withReadinessFenceV1Transaction" in readinessFence).toBe(false);
    expect(
      "captureInstitutionReadinessFenceV1HighWatermark" in readinessFence,
    ).toBe(true);
    expect(
      "withReadinessFenceV1FinalDecisionTransaction" in readinessFence,
    ).toBe(true);
  });

  it("trata recibo como pré-requisito técnico, nunca autoridade de prontidão", () => {
    expect(READINESS_FENCE_V1_RECEIPT_ROLE).toBe(
      "INSTALLATION_PREREQUISITE_ONLY",
    );
    expect(READINESS_FENCE_V1_FUTURE_CONSUMER_REQUIREMENTS).toEqual([
      "VERIFY_CURRENT_CATALOG_IN_SAME_TRANSACTION",
      "VERIFY_TRIGGER_COVERAGE_IN_SAME_TRANSACTION",
      "CAPTURE_SERVER_ISSUED_HIGH_WATERMARK",
      "LOCK_NORMAL_RESOURCES_BEFORE_EVENT_RANGE",
    ]);
  });

  it("captura somente watermark emitido pelo servidor após validar o recibo", async () => {
    const fixture = databaseHarness({
      captureRows: [validMarker, [{ eventId: "9007199254740993" }]],
    });

    await expect(
      captureInstitutionReadinessFenceV1HighWatermark(7),
    ).resolves.toEqual({ institutionId: 7, eventId: 9007199254740993n });
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it("falha fechada sem recibo antes de consultar o high-watermark", async () => {
    const fixture = databaseHarness({ captureRows: [[]] });

    await expect(
      captureInstitutionReadinessFenceV1HighWatermark(7),
    ).rejects.toThrow("READINESS_FENCE_V1_INSTALLATION_UNVERIFIED");
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("rejeita db sem transação antes de abrir a decisão final", async () => {
    databaseHarness({
      captureRows: [validMarker, [{ eventId: "1" }]],
    });
    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(7);
    const execute = vi.fn();
    getDbMock.mockResolvedValue({ execute } as never);

    await expect(
      withReadinessFenceV1FinalDecisionTransaction(
        highWatermark,
        async () => undefined,
        async () => undefined,
      ),
    ).rejects.toThrow("READINESS_FENCE_V1_TRANSACTION_UNAVAILABLE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("ordena locks normais antes da faixa da fence e decide só após ela", async () => {
    const fixture = databaseHarness({
      captureRows: [validMarker, [{ eventId: "12" }]],
      transactionRows: [validMarker, []],
    });
    const sequence: string[] = [];

    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(7);
    await expect(
      withReadinessFenceV1FinalDecisionTransaction(
        highWatermark,
        async (tx) => {
          expect(tx).toBe(fixture.tx);
          expect(fixture.transactionExecute).not.toHaveBeenCalled();
          sequence.push("normal-locks");
          return "prepared";
        },
        async (tx, prepared) => {
          expect(tx).toBe(fixture.tx);
          expect(prepared).toBe("prepared");
          sequence.push("decision");
          return "published";
        },
      ),
    ).resolves.toBe("published");

    expect(sequence).toEqual(["normal-locks", "decision"]);
    expect(fixture.transactionExecute).toHaveBeenCalledTimes(2);
    expect(fixture.events).toEqual([
      "capture.execute",
      "capture.execute",
      "transaction.begin",
      "transaction.execute",
      "transaction.execute",
      "transaction.end",
    ]);
    expect(fixture.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
    });
  });

  it("rejeita uma alteração confirmada entre captura e fechamento", async () => {
    const fixture = databaseHarness({
      captureRows: [validMarker, [{ eventId: "4" }]],
      transactionRows: [validMarker, [{ eventId: "5" }]],
    });
    const decision = vi.fn(async () => "should-not-run");
    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(7);

    await expect(
      withReadinessFenceV1FinalDecisionTransaction(
        highWatermark,
        async () => "prepared",
        decision,
      ),
    ).rejects.toThrow("READINESS_FENCE_V1_STALE");
    expect(decision).not.toHaveBeenCalled();
    expect(fixture.transactionExecute).toHaveBeenCalledTimes(2);
  });

  it("recusa watermark forjado ou dado de driver não canônico", async () => {
    databaseHarness({
      captureRows: [validMarker, [{ eventId: "01" }]],
    });
    await expect(
      captureInstitutionReadinessFenceV1HighWatermark(7),
    ).rejects.toThrow("READINESS_FENCE_V1_HIGH_WATERMARK_INTEGRITY_FAILURE");

    const fixture = databaseHarness({ transactionRows: [] });
    await expect(
      withReadinessFenceV1FinalDecisionTransaction(
        { institutionId: 7, eventId: 1n },
        async () => undefined,
        async () => undefined,
      ),
    ).rejects.toThrow("READINESS_FENCE_V1_UNISSUED_HIGH_WATERMARK");
    expect(fixture.transactionExecute).not.toHaveBeenCalled();
  });

  it("consome o high-watermark após uma decisão final", async () => {
    const fixture = databaseHarness({
      captureRows: [validMarker, [{ eventId: "1" }]],
      transactionRows: [validMarker, []],
    });
    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(7);

    await withReadinessFenceV1FinalDecisionTransaction(
      highWatermark,
      async () => undefined,
      async () => undefined,
    );

    await expect(
      withReadinessFenceV1FinalDecisionTransaction(
        highWatermark,
        async () => undefined,
        async () => undefined,
      ),
    ).rejects.toThrow("READINESS_FENCE_V1_HIGH_WATERMARK_CONSUMED");
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
  });

  it("mantém a transação aberta até locks normais e decisão terminarem", async () => {
    const fixture = databaseHarness({
      captureRows: [validMarker, [{ eventId: "1" }]],
      transactionRows: [validMarker, []],
    });
    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(7);
    const normalLocksStarted = deferred();
    const releaseNormalLocks = deferred();

    const operation = withReadinessFenceV1FinalDecisionTransaction(
      highWatermark,
      async () => {
        normalLocksStarted.resolve();
        await releaseNormalLocks.promise;
      },
      async () => "decision",
    );

    await normalLocksStarted.promise;
    expect(fixture.events).toContain("transaction.begin");
    expect(fixture.events).not.toContain("transaction.end");
    releaseNormalLocks.resolve();
    await expect(operation).resolves.toBe("decision");
    expect(fixture.events).toContain("transaction.end");
  });

  it("propaga falha dos locks normais e encerra a transação", async () => {
    const fixture = databaseHarness({
      captureRows: [validMarker, [{ eventId: "1" }]],
    });
    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(7);

    await expect(
      withReadinessFenceV1FinalDecisionTransaction(
        highWatermark,
        async () => {
          throw new Error("NORMAL_LOCK_FAILED");
        },
        async () => undefined,
      ),
    ).rejects.toThrow("NORMAL_LOCK_FAILED");
    expect(fixture.events).toContain("transaction.end");
  });
});
