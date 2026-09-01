import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shiftInstances } from "../drizzle/schema";
import { OPERATIONAL_AGGREGATE_VERSION_CAPABILITIES } from "../server/operational-events";
import {
  advanceShiftInstanceRevision,
  type ShiftInstanceRevisionTx,
} from "../server/shift-instance-revision";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-02-shift-instance-operational-revision.sql",
    import.meta.url,
  ),
  "utf8",
);

function revisionTarget(operationalRevision = 7) {
  return {
    id: 18,
    institutionId: 3,
    hospitalId: 5,
    sectorId: 9,
    operationalRevision,
  };
}

function transactionRecordingUpdate(affectedRows = 1) {
  let values: Record<string, unknown> | undefined;
  let whereCalls = 0;
  const tx = {
    update(table: unknown) {
      expect(table).toBe(shiftInstances);
      return {
        set(nextValues: Record<string, unknown>) {
          values = nextValues;
          return {
            where() {
              whereCalls += 1;
              return Promise.resolve([{ affectedRows }]);
            },
          };
        },
      };
    },
  } as unknown as ShiftInstanceRevisionTx;

  return {
    tx,
    values: () => values,
    whereCalls: () => whereCalls,
  };
}

describe("revisão operacional de instância de turno", () => {
  it("declara a coluna e habilita somente o agregado SHIFT_INSTANCE", () => {
    expect(shiftInstances.operationalRevision.notNull).toBe(true);
    expect(shiftInstances.operationalRevision.default).toBe(0);
    expect(OPERATIONAL_AGGREGATE_VERSION_CAPABILITIES.SHIFT_INSTANCE).toBe(
      "ROW_VERSION",
    );
  });

  it("é aditiva, reexecutável e falha fechado diante de contrato divergente", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.TABLES");
    expect(migration).toContain("shift_instances_precondition_stmt");
    expect(migration).toContain("SELECT * FROM shift_instances WHERE 1 = 0");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("COLUMN_NAME = 'operational_revision'");
    expect(migration).toContain("DATA_TYPE = 'int'");
    expect(migration).toContain("IS_NULLABLE = 'NO'");
    expect(migration).toContain("CAST(COLUMN_DEFAULT AS CHAR) = '0'");
    expect(migration).toContain("operational_revision_contract_stmt");
    expect(migration).toContain(
      "shift_instances_operational_revision_contract_mismatch",
    );
    expect(migration).toContain(
      "ALTER TABLE shift_instances ADD COLUMN operational_revision INT NOT NULL DEFAULT 0",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/^\s*UPDATE\s+/im);
    expect(migration).not.toMatch(
      /\bALTER\s+TABLE\b[^']*\b(DROP|MODIFY|CHANGE|RENAME)\b/i,
    );
  });

  it("avança a revisão dentro do mesmo UPDATE condicional", async () => {
    const recording = transactionRecordingUpdate();

    await expect(
      advanceShiftInstanceRevision(recording.tx, revisionTarget(), {
        status: "PENDENTE",
      }),
    ).resolves.toBe(8);

    expect(recording.values()).toMatchObject({ status: "PENDENTE" });
    expect(recording.values()?.operationalRevision).toBeDefined();
    expect(recording.whereCalls()).toBe(1);
  });

  it("falha fechado quando o CAS não encontra exatamente uma linha", async () => {
    const recording = transactionRecordingUpdate(0);

    await expect(
      advanceShiftInstanceRevision(recording.tx, revisionTarget(), {
        status: "PENDENTE",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("recusa patch vazio e revisão corrompida antes de escrever", async () => {
    const empty = transactionRecordingUpdate();
    await expect(
      advanceShiftInstanceRevision(empty.tx, revisionTarget(), {}),
    ).rejects.toThrow("alteração efetiva");
    expect(empty.whereCalls()).toBe(0);

    const corrupt = transactionRecordingUpdate();
    await expect(
      advanceShiftInstanceRevision(corrupt.tx, revisionTarget(-1), {
        status: "PENDENTE",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(corrupt.whereCalls()).toBe(0);
  });

  it("centraliza os escritores produtivos e versiona scripts administrativos efetivos", () => {
    const writers = [
      "server/shifts-crud.ts",
      "server/shift-status.ts",
      "server/editor.ts",
      "server/routers.ts",
    ] as const;
    for (const writer of writers) {
      const source = readFileSync(
        new URL(`../${writer}`, import.meta.url),
        "utf8",
      );
      expect(source).toContain("advanceShiftInstanceRevision");
      expect(source).not.toContain(".update(shiftInstances)");
    }

    const helper = readFileSync(
      new URL("../server/shift-instance-revision.ts", import.meta.url),
      "utf8",
    );
    expect(helper).toContain(
      "eq(shiftInstances.operationalRevision, target.operationalRevision)",
    );
    expect(helper).toContain(
      "eq(shiftInstances.institutionId, target.institutionId)",
    );
    expect(helper).toContain(
      "eq(shiftInstances.hospitalId, target.hospitalId)",
    );
    expect(helper).toContain("eq(shiftInstances.sectorId, target.sectorId)");
    expect(helper).toContain("operationalRevision: sql`");

    const recompute = readFileSync(
      new URL("../server/shift-status.ts", import.meta.url),
      "utf8",
    );
    expect(recompute).toContain('.for("update")');
    expect(recompute).toContain("if (status !== shift.status)");

    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    const productiveScriptFiles = new Set(
      Object.values(packageJson.scripts ?? {}).flatMap((command) =>
        [...command.matchAll(/scripts\/([\w-]+\.ts)/g)].map(
          (match) => `scripts/${match[1]}`,
        ),
      ),
    );
    const directShiftInstanceScriptWriters = [...productiveScriptFiles]
      .filter((script) => {
        const source = readFileSync(
          new URL(`../${script}`, import.meta.url),
          "utf8",
        );
        return (
          /\bUPDATE\s+shift_instances\b/i.test(source) ||
          source.includes(".update(shiftInstances)")
        );
      })
      .sort();
    expect(directShiftInstanceScriptWriters).toEqual([
      "scripts/provision-sala-recuperacao-schedule.ts",
      "scripts/provision-sao-carlos-contexts.ts",
    ]);

    const saoCarlosProvisioning = readFileSync(
      new URL("../scripts/provision-sao-carlos-contexts.ts", import.meta.url),
      "utf8",
    );
    expect(saoCarlosProvisioning).toContain(
      "operational_revision = operational_revision + 1",
    );
    expect(saoCarlosProvisioning).toContain("AND schedule_context_id <> ?");

    const recoveryProvisioning = readFileSync(
      new URL(
        "../scripts/provision-sala-recuperacao-schedule.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(recoveryProvisioning).toContain(
      "operational_revision = operational_revision + 1",
    );
    expect(recoveryProvisioning).toContain("FOR UPDATE");
    const noOpGuard = recoveryProvisioning.indexOf("if (startOk && endOk)");
    const repairUpdate = recoveryProvisioning.indexOf("UPDATE shift_instances");
    expect(noOpGuard).toBeGreaterThan(-1);
    expect(repairUpdate).toBeGreaterThan(noOpGuard);
  });
});
