import { describe, expect, it, vi } from "vitest";
import * as readinessFence from "../server/readiness-fence-v1";
import {
  assertCompleteReadinessFenceV1Installation,
  assertInstitutionReadinessFenceV1Unchanged,
  materializeAndLockInstitutionReadinessFenceV1,
  type ReadinessFenceV1Transaction,
} from "../server/readiness-fence-v1";
import {
  READINESS_FENCE_V1_COVERAGE_HASH,
  READINESS_FENCE_V1_COVERAGE_VERSION,
  READINESS_FENCE_V1_INSTALLATION_ID,
} from "../server/readiness-fence-v1-contract";

const validMarker = [
  {
    installationId: READINESS_FENCE_V1_INSTALLATION_ID,
    coverageVersion: READINESS_FENCE_V1_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_V1_COVERAGE_HASH,
  },
];

function fenceTransaction(executeRows: unknown[][]) {
  const onDuplicateKeyUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onDuplicateKeyUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const rows = [...executeRows];
  const execute = vi
    .fn()
    .mockImplementation(async () => [rows.shift() ?? [], []]);
  return {
    tx: { insert, execute } as unknown as ReadinessFenceV1Transaction,
    insert,
    values,
    onDuplicateKeyUpdate,
    execute,
  };
}

describe("readiness fence V1", () => {
  it("não expõe uma fábrica de ciência, aprovação ou snapshot", () => {
    expect("createReadinessFenceAcknowledgementBinding" in readinessFence).toBe(
      false,
    );
    expect("approveReadinessFence" in readinessFence).toBe(false);
    expect("bindClientReadinessSnapshot" in readinessFence).toBe(false);
  });

  it("falha fechada sem recibo antes de materializar a linha", async () => {
    const fixture = fenceTransaction([[]]);

    await expect(
      materializeAndLockInstitutionReadinessFenceV1(fixture.tx, 7),
    ).rejects.toThrow("READINESS_FENCE_V1_INSTALLATION_UNVERIFIED");
    expect(fixture.insert).not.toHaveBeenCalled();
  });

  it("materializa sem avançar a revisão e trava a linha canônica", async () => {
    const fixture = fenceTransaction([
      validMarker,
      [{ institutionId: "7", revision: "9007199254740993" }],
    ]);

    await expect(
      materializeAndLockInstitutionReadinessFenceV1(fixture.tx, 7),
    ).resolves.toEqual({ institutionId: 7, revision: 9007199254740993n });
    expect(fixture.values).toHaveBeenCalledWith({ institutionId: 7 });
    expect(fixture.onDuplicateKeyUpdate).toHaveBeenCalledTimes(1);
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
      const fixture = fenceTransaction([rows]);
      await expect(
        assertCompleteReadinessFenceV1Installation(fixture.tx),
      ).rejects.toThrow("READINESS_FENCE_V1_INSTALLATION_UNVERIFIED");
    }
  });

  it("não aceita resultado de driver com instituição ou revisão não canônica", async () => {
    for (const row of [
      { institutionId: 8, revision: "2" },
      { institutionId: 7, revision: "-1" },
      { institutionId: 7, revision: "01" },
    ]) {
      const fixture = fenceTransaction([validMarker, [row]]);
      await expect(
        materializeAndLockInstitutionReadinessFenceV1(fixture.tx, 7),
      ).rejects.toThrow("READINESS_FENCE_V1_INTEGRITY_FAILURE");
    }
  });

  it("não aceita lock criado pelo chamador", async () => {
    const fixture = fenceTransaction([]);
    await expect(
      assertInstitutionReadinessFenceV1Unchanged(fixture.tx, {
        institutionId: 7,
        revision: 1n,
      }),
    ).rejects.toThrow("READINESS_FENCE_V1_UNISSUED_LOCK");
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("rejeita revisão alterada entre leitura e rechecagem", async () => {
    const fixture = fenceTransaction([
      validMarker,
      [{ institutionId: 7, revision: "11" }],
      validMarker,
      [{ institutionId: 7, revision: "12" }],
    ]);
    const lock = await materializeAndLockInstitutionReadinessFenceV1(
      fixture.tx,
      7,
    );

    await expect(
      assertInstitutionReadinessFenceV1Unchanged(fixture.tx, lock),
    ).rejects.toThrow("READINESS_FENCE_V1_CHANGED");
  });

  it("preserva uma revisão imutável quando a rechecagem coincide", async () => {
    const fixture = fenceTransaction([
      validMarker,
      [{ institutionId: 7, revision: "12" }],
      validMarker,
      [{ institutionId: 7, revision: "12" }],
    ]);
    const lock = await materializeAndLockInstitutionReadinessFenceV1(
      fixture.tx,
      7,
    );
    expect(Object.isFrozen(lock)).toBe(true);

    await expect(
      assertInstitutionReadinessFenceV1Unchanged(fixture.tx, lock),
    ).resolves.toEqual({ institutionId: 7, revision: 12n });
  });
});
