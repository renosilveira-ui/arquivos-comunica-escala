import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { findCanonicalConfirmationAccessId } from "../server/confirmation-canonical-access";
import {
  accessCoversContext,
  accessCoversScheduleContext,
  managerScopeCoversContext,
  projectEffectiveScheduleContextIds,
  type ActiveScheduleContext,
} from "../server/schedule-contexts";

function allowlistContext(
  sectorId: number,
  overrides: Partial<ActiveScheduleContext> = {},
): ActiveScheduleContext {
  return {
    id: 10,
    institutionId: 1,
    hospitalId: 100,
    hospitalName: "Hospital São Carlos",
    sectorId,
    sectorName: `Setor ${sectorId}`,
    medicalSpecialtyId: null,
    medicalSpecialtyCode: null,
    medicalSpecialtyName: null,
    operationalProfileCode: null,
    admissionPolicy: "QUALIFICATION_ALLOWLIST",
    // Caso de regressão de Sala de Recuperação: ausência de metadado clínico
    // não altera a ACL exata do setor.
    allowedQualifications: [],
    active: true,
    ...overrides,
  };
}

function legacyBroadContext(sectorId: number): ActiveScheduleContext {
  return {
    id: sectorId,
    institutionId: 1,
    hospitalId: 100,
    hospitalName: "Hospital São Carlos",
    sectorId,
    sectorName: `Setor ${sectorId}`,
    medicalSpecialtyId: null,
    medicalSpecialtyCode: null,
    medicalSpecialtyName: null,
    operationalProfileCode: null,
    admissionPolicy: "ALL_CFM_SPECIALTIES",
    active: true,
  };
}

const professionalId = 55;

type ConfirmationAccessRow = {
  id: number;
  institutionId: number;
  professionalId: number;
  hospitalId: number;
  sectorId: number | null;
  canAccess: boolean;
};

function confirmationAccessDb(
  admissionPolicy: ActiveScheduleContext["admissionPolicy"],
  allRows: ConfirmationAccessRow[],
) {
  const accessWhere = vi.fn();
  const accessLimit = vi.fn();
  const lock = vi.fn();
  let selectCount = 0;

  const db = {
    select: vi.fn(() => {
      const isContextQuery = selectCount++ === 0;
      return {
        from: () => ({
          where: (condition: unknown) => {
            if (isContextQuery) {
              return {
                limit: () => Promise.resolve([{ admissionPolicy }]),
              };
            }

            accessWhere(condition);
            return {
              orderBy: () => ({
                limit: (limit: number) => {
                  accessLimit(limit);
                  const sql = new MySqlDialect().sqlToQuery(
                    condition as never,
                  ).sql;
                  const hasSectorPredicate = sql.includes(
                    "`professional_access`.`sector_id`",
                  );
                  const eligibleRows = hasSectorPredicate
                    ? allRows.filter((row) =>
                        admissionPolicy === "QUALIFICATION_ALLOWLIST"
                          ? row.sectorId === 101
                          : row.sectorId === null || row.sectorId === 101,
                      )
                    : allRows;
                  const promise = Promise.resolve(
                    eligibleRows.slice(0, limit),
                  ) as Promise<ConfirmationAccessRow[]> & {
                    for: (kind: string) => Promise<ConfirmationAccessRow[]>;
                  };
                  promise.for = async (kind: string) => {
                    lock(kind);
                    return eligibleRows.slice(0, limit);
                  };
                  return promise;
                },
              }),
            };
          },
        }),
      };
    }),
  };

  return { db, accessWhere, accessLimit, lock };
}

describe("accessCoversScheduleContext — regra canônica allowlist", () => {
  const salaRecuperacao = allowlistContext(101);

  it("allowlist clínica vazia + setor exato → permitido", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: 101,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(true);
  });

  it("allowlist + hospital-wide null → negado", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: null,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(false);
  });

  it("allowlist + setor diferente → negado", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: 102,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(false);
  });

  it("outro hospital → negado", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 999,
          sectorId: 101,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(false);
  });

  it("outro tenant → negado", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 2,
          professionalId,
          hospitalId: 100,
          sectorId: 101,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(false);
  });

  it("contexto legado compatível preserva hospital-wide", () => {
    const emergencia = legacyBroadContext(201);
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: null,
          canAccess: true,
        },
        professionalId,
        emergencia,
      ),
    ).toBe(true);
    expect(
      accessCoversContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: null,
          canAccess: true,
        },
        professionalId,
        emergencia,
      ),
    ).toBe(true);
  });

  it("projectEffectiveScheduleContextIds nega allowlist com acesso hospital-wide", () => {
    const contexts = [allowlistContext(101), allowlistContext(102, { id: 11 })];
    expect(
      projectEffectiveScheduleContextIds({
        institutionId: 1,
        professionalId,
        contexts,
        accesses: [
          {
            institutionId: 1,
            professionalId,
            hospitalId: 100,
            sectorId: 101,
            canAccess: true,
          },
        ],
      }),
    ).toEqual([10]);
    expect(
      projectEffectiveScheduleContextIds({
        institutionId: 1,
        professionalId,
        contexts,
        accesses: [
          {
            institutionId: 1,
            professionalId,
            hospitalId: 100,
            sectorId: null,
            canAccess: true,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("manager scope hospital-wide continua cobrindo allowlist", () => {
    expect(
      managerScopeCoversContext(
        {
          institutionId: 1,
          managerProfessionalId: professionalId,
          hospitalId: 100,
          sectorId: null,
          active: true,
        },
        professionalId,
        allowlistContext(101),
      ),
    ).toBe(true);
  });
});

describe("acesso canônico de confirmação — paginação segura", () => {
  const input = {
    professionalId,
    institutionId: 1,
    hospitalId: 100,
    sectorId: 101,
    scheduleContextId: 10,
  };

  it("encontra acesso válido depois de 64 entradas sem leitura ilimitada", async () => {
    const rows: ConfirmationAccessRow[] = Array.from(
      { length: 64 },
      (_, index) => ({
        id: index + 1,
        institutionId: 1,
        professionalId,
        hospitalId: 100,
        sectorId: 200 + index,
        canAccess: true,
      }),
    );
    rows.push({
      id: 65,
      institutionId: 1,
      professionalId,
      hospitalId: 100,
      sectorId: 101,
      canAccess: true,
    });
    const { db, accessWhere, accessLimit } = confirmationAccessDb(
      "ALL_CFM_SPECIALTIES",
      rows,
    );

    await expect(
      findCanonicalConfirmationAccessId(db as never, input),
    ).resolves.toBe(65);
    expect(accessLimit).toHaveBeenCalledWith(1);

    const query = new MySqlDialect().sqlToQuery(
      accessWhere.mock.calls[0]![0] as never,
    );
    expect(query.sql).toContain(
      "(`professional_access`.`sector_id` is null or `professional_access`.`sector_id` = ?)",
    );
    expect(query.params).toContain(101);
  });

  it("allowlist exige setor exato no SQL e mantém o lock FOR UPDATE", async () => {
    const rows: ConfirmationAccessRow[] = [
      {
        id: 70,
        institutionId: 1,
        professionalId,
        hospitalId: 100,
        sectorId: null,
        canAccess: true,
      },
      {
        id: 71,
        institutionId: 1,
        professionalId,
        hospitalId: 100,
        sectorId: 101,
        canAccess: true,
      },
    ];
    const { db, accessWhere, lock } = confirmationAccessDb(
      "QUALIFICATION_ALLOWLIST",
      rows,
    );

    await expect(
      findCanonicalConfirmationAccessId(db as never, {
        ...input,
        accessId: 71,
        lockForUpdate: true,
      }),
    ).resolves.toBe(71);
    expect(lock).toHaveBeenCalledWith("update");

    const query = new MySqlDialect().sqlToQuery(
      accessWhere.mock.calls[0]![0] as never,
    );
    expect(query.sql).toContain("`professional_access`.`sector_id` = ?");
    expect(query.sql).not.toContain(
      "`professional_access`.`sector_id` is null",
    );
    expect(query.sql).toContain("`professional_access`.`id` = ?");
    expect(query.params).toContain(71);
  });

  it("mantém defesa em profundidade e remove o corte anterior de 64", () => {
    const source = readFileSync(
      "server/confirmation-canonical-access.ts",
      "utf8",
    );
    expect(source).toContain("accessCoversScheduleContext");
    expect(source).toContain('accessQuery.for("update")');
    expect(source).toContain("eq(professionalAccess.id, input.accessId)");
    expect(source).not.toContain(".limit(64)");
  });
});

describe("leitores SQL alinhados com accessCoversScheduleContext", () => {
  it("listAssignableForShift e listReplacementCandidates ramificam allowlist", () => {
    const assignable = readFileSync("server/aux-routers.ts", "utf8");
    const replacement = readFileSync("server/confirmation-router.ts", "utf8");

    for (const source of [assignable, replacement]) {
      expect(source).toContain("QUALIFICATION_ALLOWLIST");
      expect(source).toContain("pa.sector_id =");
      expect(source).toContain("pa.sector_id IS NULL OR");
    }
  });

  it("swap-router aplica a mesma fronteira em professional_access", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    expect(source).toContain(
      "fsc.admission_policy = 'QUALIFICATION_ALLOWLIST'",
    );
    expect(source).toContain(
      "tsc.admission_policy = 'QUALIFICATION_ALLOWLIST'",
    );
    expect(source).toContain("source_access.sector_id = fsi.sector_id");
    expect(source).toContain("actor_target_access.sector_id = tsi.sector_id");
  });

  it("assignDirect e listAssignable concordam no bloqueio hospital-wide", () => {
    const editor = readFileSync("tests/editor-assign-direct.test.ts", "utf8");
    const assignable = readFileSync(
      "tests/assignable-professionals.test.ts",
      "utf8",
    );
    expect(editor).toContain(
      "bloqueia bypass de alocação direta com acesso só hospitalar",
    );
    expect(assignable).toContain(
      "expect(ids).not.toContain(hospitalWideProfessionalId)",
    );
  });

  it("discovery e integrity de confirmação usam o predicado canônico #317", () => {
    const dispatcher = readFileSync(
      "server/cron/shift-confirmation-dispatcher.ts",
      "utf8",
    );
    const integrity = readFileSync("server/confirmation-integrity.ts", "utf8");
    const helper = readFileSync(
      "server/confirmation-canonical-access.ts",
      "utf8",
    );
    expect(dispatcher).toContain("plantonistaAccessCoversShiftSql");
    expect(dispatcher).not.toContain("professionalAccess.sectorId");
    expect(integrity).toContain("findCanonicalConfirmationAccessId");
    expect(integrity).not.toContain("qualificationMatches");
    expect(helper).toContain("accessCoversScheduleContext");
    expect(helper).toContain("QUALIFICATION_ALLOWLIST");
  });
});
