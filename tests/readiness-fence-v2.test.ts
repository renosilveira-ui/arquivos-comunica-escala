import { describe, expect, it, vi } from "vitest";
import {
  assertCompleteReadinessFenceV2Installation,
  assertInstitutionReadinessFenceV2Unchanged,
  materializeAndLockInstitutionReadinessFenceV2,
  type ReadinessFenceV2Transaction,
} from "../server/readiness-fence-v2";
import {
  READINESS_FENCE_COVERAGE_HASH,
  READINESS_FENCE_COVERAGE_VERSION,
  READINESS_FENCE_INSTALLATION_ID,
} from "../server/readiness-fence-contract";
import {
  READINESS_FENCE_V2_COVERAGE_HASH,
  READINESS_FENCE_V2_COVERAGE_VERSION,
  READINESS_FENCE_V2_EXTENSION_KEY,
  READINESS_FENCE_V2_PREDECESSOR,
} from "../server/readiness-fence-v2-contract";

const validV1InstallationRows = [
  {
    installationId: READINESS_FENCE_INSTALLATION_ID,
    coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_COVERAGE_HASH,
  },
];

const validV2ExtensionRows = [
  {
    extensionKey: READINESS_FENCE_V2_EXTENSION_KEY,
    coverageVersion: READINESS_FENCE_V2_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_V2_COVERAGE_HASH,
    baseInstallationId: READINESS_FENCE_V2_PREDECESSOR.installationId,
    baseCoverageVersion: READINESS_FENCE_V2_PREDECESSOR.coverageVersion,
    baseCoverageHash: READINESS_FENCE_V2_PREDECESSOR.coverageHash,
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
    tx: { insert, execute } as unknown as ReadinessFenceV2Transaction,
    insert,
    values,
    onDuplicateKeyUpdate,
    execute,
  };
}

describe("runtime da extensão V2 da fence", () => {
  it("exige simultaneamente a instalação V1 e o recibo V2 ligado a ela", async () => {
    const fixture = fenceTransaction([
      validV1InstallationRows,
      validV2ExtensionRows,
    ]);

    await expect(
      assertCompleteReadinessFenceV2Installation(fixture.tx),
    ).resolves.toEqual({
      v1: {
        installationId: READINESS_FENCE_INSTALLATION_ID,
        coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
        coverageHash: READINESS_FENCE_COVERAGE_HASH,
      },
      extensionKey: READINESS_FENCE_V2_EXTENSION_KEY,
      coverageVersion: READINESS_FENCE_V2_COVERAGE_VERSION,
      coverageHash: READINESS_FENCE_V2_COVERAGE_HASH,
    });
  });

  it("falha fechada se V2 estiver ausente ou não referenciar exatamente V1", async () => {
    const missingV2 = fenceTransaction([validV1InstallationRows, []]);
    await expect(
      assertCompleteReadinessFenceV2Installation(missingV2.tx),
    ).rejects.toThrow("READINESS_FENCE_V2_EXTENSION_UNVERIFIED");

    const wrongBase = fenceTransaction([
      validV1InstallationRows,
      [
        {
          ...validV2ExtensionRows[0],
          baseCoverageHash: "b".repeat(64),
        },
      ],
    ]);
    await expect(
      assertCompleteReadinessFenceV2Installation(wrongBase.tx),
    ).rejects.toThrow("READINESS_FENCE_V2_EXTENSION_UNVERIFIED");
  });

  it("falha fechada se a prova V1 não for singleton e canônica", async () => {
    const fixture = fenceTransaction([
      [
        {
          installationId: READINESS_FENCE_INSTALLATION_ID,
          coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
          coverageHash: "b".repeat(64),
        },
      ],
    ]);

    await expect(
      assertCompleteReadinessFenceV2Installation(fixture.tx),
    ).rejects.toThrow("READINESS_FENCE_INSTALLATION_UNVERIFIED");
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("usa a revisão comum somente depois de provar as duas instalações", async () => {
    const fixture = fenceTransaction([
      validV1InstallationRows,
      validV2ExtensionRows,
      validV1InstallationRows,
      [{ institutionId: 7, revision: "4" }],
    ]);

    await expect(
      materializeAndLockInstitutionReadinessFenceV2(fixture.tx, 7),
    ).resolves.toEqual({ institutionId: 7, revision: 4n });
    expect(fixture.insert).toHaveBeenCalledTimes(1);
    expect(fixture.execute).toHaveBeenCalledTimes(4);
  });

  it("revalida as duas instalações antes de aceitar uma fence inalterada", async () => {
    const fixture = fenceTransaction([
      validV1InstallationRows,
      validV2ExtensionRows,
      validV1InstallationRows,
      [{ institutionId: 7, revision: "4" }],
      validV1InstallationRows,
      validV2ExtensionRows,
      validV1InstallationRows,
      [{ institutionId: 7, revision: "4" }],
    ]);
    const fence = await materializeAndLockInstitutionReadinessFenceV2(
      fixture.tx,
      7,
    );

    await expect(
      assertInstitutionReadinessFenceV2Unchanged(fixture.tx, fence),
    ).resolves.toEqual({ institutionId: 7, revision: 4n });
  });
});
