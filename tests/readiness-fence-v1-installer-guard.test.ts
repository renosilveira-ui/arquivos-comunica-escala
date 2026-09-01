import { describe, expect, it } from "vitest";
import {
  applyReadinessFenceV1Migration,
  buildReadinessFenceV1ConnectionOptions,
  readReadinessFenceV1DedicatedCliOptions,
  safeReadinessFenceV1CliErrorCode,
} from "../scripts/apply-readiness-fence-v1-migration";
import { assertGenericManualMigrationAllowed } from "../scripts/apply-manual-migration";

describe("proteções do instalador dedicado da readiness fence V1", () => {
  it("recusa o arquivo dedicado e cópias com diretiva V1 no executor genérico", () => {
    expect(() =>
      assertGenericManualMigrationAllowed(
        "/tmp/2026-09-01-readiness-fence-v1-clean.sql",
        "SELECT 1",
      ),
    ).toThrow("READINESS_FENCE_V1_DEDICATED_INSTALLER_REQUIRED");
    expect(() =>
      assertGenericManualMigrationAllowed(
        "/tmp/copia-renomeada.sql",
        "-- @readiness-fence-trigger\nSELECT 1",
      ),
    ).toThrow("READINESS_FENCE_V1_DEDICATED_INSTALLER_REQUIRED");
    expect(() =>
      assertGenericManualMigrationAllowed(
        "/tmp/copia-sem-diretiva.sql",
        "CREATE TABLE institution_readiness_fence_events (institution_id INT)",
      ),
    ).toThrow("READINESS_FENCE_V1_DEDICATED_INSTALLER_REQUIRED");
    expect(() =>
      assertGenericManualMigrationAllowed(
        "/tmp/copia-sem-diretiva.sql",
        "CREATE TRIGGER trg_rdf_i_ai AFTER INSERT ON institutions FOR EACH ROW SELECT 1",
      ),
    ).toThrow("READINESS_FENCE_V1_DEDICATED_INSTALLER_REQUIRED");
    expect(() =>
      assertGenericManualMigrationAllowed(
        "/tmp/outra-migration.sql",
        "CREATE TABLE unrelated_example (id INT)",
      ),
    ).not.toThrow();
  });

  it("exige opt-in e URL dedicada, sem reutilizar DATABASE_URL", () => {
    expect(() =>
      readReadinessFenceV1DedicatedCliOptions({
        DATABASE_URL: "mysql://accidental:secret@db.example.test:3306/prod",
      }),
    ).toThrow("READINESS_FENCE_V1_EXPLICIT_APPROVAL_REQUIRED");
    expect(() =>
      readReadinessFenceV1DedicatedCliOptions({
        READINESS_FENCE_V1_APPLY: "1",
      }),
    ).toThrow("READINESS_FENCE_V1_DATABASE_URL_REQUIRED");
    expect(
      readReadinessFenceV1DedicatedCliOptions({
        READINESS_FENCE_V1_APPLY: "1",
        READINESS_FENCE_V1_DATABASE_URL:
          "mysql://installer:secret@db.example.test:3306/escala?ssl-mode=REQUIRED",
      }),
    ).toEqual({
      explicitApproval: true,
      databaseUrl:
        "mysql://installer:secret@db.example.test:3306/escala?ssl-mode=REQUIRED",
    });
    expect(() =>
      readReadinessFenceV1DedicatedCliOptions({
        NODE_ENV: "production",
        READINESS_FENCE_V1_APPLY: "1",
        READINESS_FENCE_V1_DATABASE_URL:
          "mysql://root:root@127.0.0.1:3306/escala_test",
        READINESS_FENCE_V1_ALLOW_INSECURE_LOOPBACK_FOR_TEST: "1",
      }),
    ).toThrow("READINESS_FENCE_V1_INSECURE_LOOPBACK_TEST_ONLY");
    expect(
      readReadinessFenceV1DedicatedCliOptions({
        NODE_ENV: "test",
        READINESS_FENCE_V1_APPLY: "1",
        READINESS_FENCE_V1_DATABASE_URL:
          "mysql://root:root@127.0.0.1:3306/escala_test",
        READINESS_FENCE_V1_ALLOW_INSECURE_LOOPBACK_FOR_TEST: "1",
      }),
    ).toMatchObject({ allowInsecureLoopbackForTest: true });
  });

  it("exige TLS fora de loopback e só permite loopback inseguro por opt-in de teste", () => {
    const remoteUrl = "mysql://installer:secret@db.example.test:3306/escala";
    expect(() => buildReadinessFenceV1ConnectionOptions(remoteUrl)).toThrow(
      "READINESS_FENCE_V1_DATABASE_TLS_REQUIRED",
    );
    try {
      buildReadinessFenceV1ConnectionOptions(remoteUrl);
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(
        "secret",
      );
    }

    expect(
      buildReadinessFenceV1ConnectionOptions(`${remoteUrl}?ssl-mode=REQUIRED`)
        .ssl,
    ).toEqual({ rejectUnauthorized: true });
    expect(() =>
      buildReadinessFenceV1ConnectionOptions(
        "mysql://root:root@127.0.0.1:3306/escala_test",
      ),
    ).toThrow("READINESS_FENCE_V1_DATABASE_TLS_REQUIRED");
    expect(
      buildReadinessFenceV1ConnectionOptions(
        "mysql://root:root@127.0.0.1:3306/escala_test",
        { allowInsecureLoopbackForTest: true },
      ).ssl,
    ).toBeUndefined();
    expect(() =>
      buildReadinessFenceV1ConnectionOptions(
        "mysql:///escala_test?ssl-mode=REQUIRED",
      ),
    ).toThrow("READINESS_FENCE_V1_DATABASE_HOST_REQUIRED");
    expect(() =>
      buildReadinessFenceV1ConnectionOptions(
        "mysql://root:root@127.0.0.1:0/escala_test?ssl-mode=REQUIRED",
      ),
    ).toThrow("READINESS_FENCE_V1_DATABASE_PORT_INVALID");
  });

  it("recusa falta de aprovação antes de abrir conexão com qualquer banco", async () => {
    await expect(
      applyReadinessFenceV1Migration({
        explicitApproval: false,
        databaseUrl: "mysql://installer:secret@db.example.test:3306/escala",
      } as never),
    ).rejects.toThrow("READINESS_FENCE_V1_EXPLICIT_APPROVAL_REQUIRED");
  });

  it("não registra URL ou credencial quando o instalador falha", () => {
    expect(
      safeReadinessFenceV1CliErrorCode(
        new Error("connect mysql://installer:secret@db.example.test/escala"),
      ),
    ).toBe("READINESS_FENCE_V1_INSTALLATION_FAILED");
    expect(
      safeReadinessFenceV1CliErrorCode(
        new Error("READINESS_FENCE_V1_DATABASE_TLS_REQUIRED"),
      ),
    ).toBe("READINESS_FENCE_V1_DATABASE_TLS_REQUIRED");
  });
});
