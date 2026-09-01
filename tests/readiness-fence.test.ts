import { describe, expect, it, vi } from "vitest";
import * as readinessFence from "../server/readiness-fence";
import {
  assertCompleteReadinessFenceInstallation,
  assertInstitutionReadinessFenceUnchanged,
  materializeAndLockInstitutionReadinessFence,
  type ReadinessFenceTransaction,
} from "../server/readiness-fence";
import {
  READINESS_FENCE_COVERAGE_HASH,
  READINESS_FENCE_COVERAGE_VERSION,
  READINESS_FENCE_INSTALLATION_ID,
} from "../server/readiness-fence-contract";

const validInstallationRows = [
  {
    installationId: READINESS_FENCE_INSTALLATION_ID,
    coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_COVERAGE_HASH,
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
    tx: { insert, execute } as unknown as ReadinessFenceTransaction,
    insert,
    values,
    onDuplicateKeyUpdate,
    execute,
  };
}

describe("institution readiness fence", () => {
  it("não expõe fábrica genérica de receipt de ciência", () => {
    expect("createReadinessFenceAcknowledgementBinding" in readinessFence).toBe(
      false,
    );
  });

  it("materializa sem avançar a revisão e trava a linha da instituição", async () => {
    const fixture = fenceTransaction([
      validInstallationRows,
      [{ institutionId: "7", revision: "9007199254740993" }],
    ]);

    const fence = await materializeAndLockInstitutionReadinessFence(
      fixture.tx,
      7,
    );

    expect(fence).toEqual({ institutionId: 7, revision: 9007199254740993n });
    expect(Object.isFrozen(fence)).toBe(true);
    expect(fixture.insert).toHaveBeenCalledTimes(1);
    expect(fixture.values).toHaveBeenCalledWith({
      institutionId: 7,
      revision: 0n,
    });
    expect(fixture.onDuplicateKeyUpdate).toHaveBeenCalledTimes(1);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it("falha fechada sem marcador antes de materializar qualquer fence", async () => {
    const fixture = fenceTransaction([[]]);

    await expect(
      materializeAndLockInstitutionReadinessFence(fixture.tx, 7),
    ).rejects.toThrow("READINESS_FENCE_INSTALLATION_UNVERIFIED");
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("retorna recibo imutável para o contrato de instalação exata", async () => {
    const fixture = fenceTransaction([validInstallationRows]);

    await expect(
      assertCompleteReadinessFenceInstallation(fixture.tx),
    ).resolves.toEqual({
      installationId: READINESS_FENCE_INSTALLATION_ID,
      coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
      coverageHash: READINESS_FENCE_COVERAGE_HASH,
    });
  });

  it("falha fechada para marker divergente antes de materializar", async () => {
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
      materializeAndLockInstitutionReadinessFence(fixture.tx, 7),
    ).rejects.toThrow("READINESS_FENCE_INSTALLATION_UNVERIFIED");
    expect(fixture.insert).not.toHaveBeenCalled();
  });

  it("falha fechada para marcador não singleton antes de materializar", async () => {
    const fixture = fenceTransaction([
      [
        ...validInstallationRows,
        {
          installationId: 2,
          coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
          coverageHash: READINESS_FENCE_COVERAGE_HASH,
        },
      ],
    ]);

    await expect(
      materializeAndLockInstitutionReadinessFence(fixture.tx, 7),
    ).rejects.toThrow("READINESS_FENCE_INSTALLATION_UNVERIFIED");
    expect(fixture.insert).not.toHaveBeenCalled();
  });

  it("falha fechada para tenant inválido antes de emitir SQL", async () => {
    const fixture = fenceTransaction([validInstallationRows]);

    await expect(
      materializeAndLockInstitutionReadinessFence(fixture.tx, 0),
    ).rejects.toThrow("READINESS_FENCE_INVALID_INSTITUTION");
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("falha fechada se a linha travada não é canônica", async () => {
    const fixture = fenceTransaction([
      validInstallationRows,
      [{ institutionId: 8, revision: "2" }],
    ]);

    await expect(
      materializeAndLockInstitutionReadinessFence(fixture.tx, 7),
    ).rejects.toThrow("READINESS_FENCE_INTEGRITY_FAILURE");
  });

  it("não aceita revisão negativa ou malformada vinda do driver", async () => {
    const fixture = fenceTransaction([
      validInstallationRows,
      [{ institutionId: 7, revision: "-1" }],
    ]);

    await expect(
      materializeAndLockInstitutionReadinessFence(fixture.tx, 7),
    ).rejects.toThrow("READINESS_FENCE_INTEGRITY_FAILURE");
  });

  it("rejeita uma fence que mudou depois do snapshot", async () => {
    const fixture = fenceTransaction([
      validInstallationRows,
      [{ institutionId: 7, revision: "11" }],
      validInstallationRows,
      [{ institutionId: 7, revision: "12" }],
    ]);
    const fence = await materializeAndLockInstitutionReadinessFence(
      fixture.tx,
      7,
    );

    await expect(
      assertInstitutionReadinessFenceUnchanged(fixture.tx, fence),
    ).rejects.toThrow("READINESS_FENCE_CHANGED");
  });

  it("preserva a revisão quando a conferência final coincide", async () => {
    const fixture = fenceTransaction([
      validInstallationRows,
      [{ institutionId: 7, revision: "12" }],
      validInstallationRows,
      [{ institutionId: 7, revision: "12" }],
    ]);
    const fence = await materializeAndLockInstitutionReadinessFence(
      fixture.tx,
      7,
    );

    await expect(
      assertInstitutionReadinessFenceUnchanged(fixture.tx, fence),
    ).resolves.toEqual({ institutionId: 7, revision: 12n });
  });

  it("não permite rechecagem a partir de lock autoemitido", async () => {
    const rawLock = { institutionId: 7, revision: 12n };
    const rawLockFixture = fenceTransaction([]);
    await expect(
      assertInstitutionReadinessFenceUnchanged(rawLockFixture.tx, rawLock),
    ).rejects.toThrow("READINESS_FENCE_UNISSUED_LOCK");
    expect(rawLockFixture.execute).not.toHaveBeenCalled();
  });
});
