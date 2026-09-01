import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CORPORATE_GENERAL_CONTEXT_POLICY,
  CORPORATE_STRUCTURE_NORMALIZER_CONFIRMATION,
  authorizeCorporateStructuralApply,
  executeCorporateStructuralPlan,
  parseCorporateStructuralCliArgs,
  planCorporateStructuralNormalization,
  type CorporateStructuralScheduleContext,
  type CorporateStructuralShiftTemplate,
} from "../lib/corporate-structural-normalizer";
import { DEFAULT_SECTOR_SHIFT_TEMPLATES } from "../lib/default-sector-shift-blueprint";

const target = { institutionId: 11, hospitalId: 22, sectorId: 33 } as const;

function generalContext(
  overrides: Partial<CorporateStructuralScheduleContext> = {},
): CorporateStructuralScheduleContext {
  return {
    id: 1,
    ...target,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    admissionPolicy: CORPORATE_GENERAL_CONTEXT_POLICY,
    active: true,
    ...overrides,
  };
}

function template(
  index: number,
  overrides: Partial<CorporateStructuralShiftTemplate> = {},
): CorporateStructuralShiftTemplate {
  const expected = DEFAULT_SECTOR_SHIFT_TEMPLATES[index]!;
  return {
    id: index + 1,
    ...target,
    name: expected.name,
    startTime: expected.startTime,
    endTime: expected.endTime,
    isActive: true,
    priority: expected.priority,
    ...overrides,
  };
}

describe("normalizador estrutural corporativo", () => {
  it("mantém o adaptador limitado a contexto e template e faz dry-run READ ONLY", () => {
    const source = readFileSync(
      "scripts/normalize-corporate-schedule-structure.ts",
      "utf8",
    );

    expect(source).toContain('connection.query("SET TRANSACTION READ ONLY")');
    expect(source).toContain("authorizeCorporateStructuralApply");
    expect(source).toMatch(/INSERT INTO schedule_contexts/);
    expect(source).toMatch(/INSERT INTO shift_templates/);
    for (const forbiddenTable of [
      "monthly_rosters",
      "shift_instances",
      "shift_assignments",
      "professionals",
      "manager_scope",
      "schedule_invites",
      "users",
    ]) {
      expect(source).not.toMatch(
        new RegExp(`(?:INSERT INTO|UPDATE|DELETE FROM) ${forbiddenTable}`, "i"),
      );
    }
  });

  it("planeja somente o contexto geral amplo e os três templates para setor vazio", () => {
    const plan = planCorporateStructuralNormalization({
      target,
      contexts: [],
      templates: [],
    });

    expect(plan.status).toBe("READY");
    expect(plan.issues).toEqual([]);
    expect(plan.actions).toEqual([
      {
        kind: "CREATE_GENERAL_CONTEXT",
        ...target,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
      },
      {
        kind: "CREATE_SECTOR_TEMPLATE",
        ...target,
        ...DEFAULT_SECTOR_SHIFT_TEMPLATES[0],
      },
      {
        kind: "CREATE_SECTOR_TEMPLATE",
        ...target,
        ...DEFAULT_SECTOR_SHIFT_TEMPLATES[1],
      },
      {
        kind: "CREATE_SECTOR_TEMPLATE",
        ...target,
        ...DEFAULT_SECTOR_SHIFT_TEMPLATES[2],
      },
    ]);
  });

  it("documenta que o contexto geral não fixa especialidade nem perfil", () => {
    const [action] = planCorporateStructuralNormalization({
      target,
      contexts: [],
      templates: [],
    }).actions;

    expect(action).toMatchObject({
      kind: "CREATE_GENERAL_CONTEXT",
      admissionPolicy: "ALL_CFM_SPECIALTIES",
      medicalSpecialtyId: null,
      operationalProfileCode: null,
    });
  });

  it("considera templates hospitalares canônicos como estrutura efetiva, sem copiar para o setor", () => {
    const plan = planCorporateStructuralNormalization({
      target,
      contexts: [generalContext()],
      templates: DEFAULT_SECTOR_SHIFT_TEMPLATES.map((_, index) =>
        template(index, { sectorId: null }),
      ),
    });

    expect(plan.status).toBe("ALREADY_COMPLIANT");
    expect(plan.actions).toEqual([]);
    expect(plan.issues).toEqual([]);
  });

  it("é idempotente ao completar apenas templates canônicos ausentes no próprio setor", () => {
    const partial = planCorporateStructuralNormalization({
      target,
      contexts: [generalContext()],
      templates: [template(0)],
    });
    expect(partial.status).toBe("READY");
    expect(partial.actions.map((action) => action.kind)).toEqual([
      "CREATE_SECTOR_TEMPLATE",
      "CREATE_SECTOR_TEMPLATE",
    ]);

    const afterApply = planCorporateStructuralNormalization({
      target,
      contexts: [generalContext()],
      templates: [template(0), template(1), template(2)],
    });
    expect(afterApply.status).toBe("ALREADY_COMPLIANT");
    expect(afterApply.actions).toEqual([]);
  });

  it("falha fechado apenas no setor com contexto especializado ou ambíguo", () => {
    const plan = planCorporateStructuralNormalization({
      target,
      contexts: [
        generalContext({
          admissionPolicy: "QUALIFICATION_ALLOWLIST",
          medicalSpecialtyId: null,
          operationalProfileCode: null,
        }),
      ],
      templates: [],
    });

    expect(plan.status).toBe("BLOCKED");
    expect(plan.actions).toEqual([]);
    expect(plan.issues.map((issue) => issue.code)).toContain(
      "CONTEXT_CONFIGURATION_DIVERGENT",
    );
    expect(plan.issues[0]).toEqual({
      code: "CONTEXT_CONFIGURATION_DIVERGENT",
      scope: "SECTOR",
    });
  });

  it("não mistura registros de outro tenant e bloqueia referência do mesmo sectorId fora da topologia", () => {
    const plan = planCorporateStructuralNormalization({
      target,
      contexts: [generalContext({ institutionId: 99 })],
      templates: [],
    });

    expect(plan.status).toBe("BLOCKED");
    expect(plan.actions).toEqual([]);
    expect(plan.issues.map((issue) => issue.code)).toContain(
      "CONTEXT_TOPOLOGY_MISMATCH",
    );

    const isolated = planCorporateStructuralNormalization({
      target,
      contexts: [
        generalContext({ institutionId: 99, hospitalId: 98, sectorId: 97 }),
      ],
      templates: [],
    });
    expect(isolated.status).toBe("READY");
    expect(isolated.issues).toEqual([]);
  });

  it("não cria cópia setorial que ocultaria fallback hospitalar incompleto", () => {
    const plan = planCorporateStructuralNormalization({
      target,
      contexts: [generalContext()],
      templates: [template(0, { sectorId: null })],
    });

    expect(plan.status).toBe("BLOCKED");
    expect(plan.actions).toEqual([]);
    expect(plan.issues.map((issue) => issue.code)).toContain(
      "HOSPITAL_TEMPLATE_FALLBACK_INCOMPLETE",
    );
  });

  it("trata nome semelhante ou horário divergente como aviso bloqueante, sem sobrescrever", () => {
    const plan = planCorporateStructuralNormalization({
      target,
      contexts: [generalContext()],
      templates: [template(0, { startTime: "08:00:00" })],
    });

    expect(plan.status).toBe("BLOCKED");
    expect(plan.actions).toEqual([]);
    expect(plan.issues.map((issue) => issue.code)).toContain(
      "TEMPLATE_CONFIGURATION_DIVERGENT",
    );
  });

  it("mantém dry-run sem executor e exige confirmação literal para aplicar", async () => {
    const plan = planCorporateStructuralNormalization({
      target,
      contexts: [],
      templates: [],
    });
    const execute = vi.fn(async () => undefined);

    await expect(
      executeCorporateStructuralPlan(plan, null, execute),
    ).resolves.toBe(0);
    await expect(
      executeCorporateStructuralPlan(
        plan,
        true as unknown as ReturnType<typeof authorizeCorporateStructuralApply>,
        execute,
      ),
    ).resolves.toBe(0);
    expect(execute).not.toHaveBeenCalled();

    expect(parseCorporateStructuralCliArgs([])).toEqual({
      requestedApply: false,
    });
    expect(parseCorporateStructuralCliArgs(["--apply"])).toEqual({
      requestedApply: true,
    });
    expect(() =>
      parseCorporateStructuralCliArgs(["--sector-name", "UTI"]),
    ).toThrow(/Argumento não reconhecido/);
    expect(() =>
      authorizeCorporateStructuralApply({ requestedApply: true }, {}),
    ).toThrow(/CORPORATE_STRUCTURE_NORMALIZER_CONFIRM/);
    expect(() =>
      authorizeCorporateStructuralApply(
        { requestedApply: true },
        {
          CORPORATE_STRUCTURE_NORMALIZER_CONFIRM:
            CORPORATE_STRUCTURE_NORMALIZER_CONFIRMATION,
        },
      ),
    ).not.toThrow();
    expect(
      authorizeCorporateStructuralApply(
        { requestedApply: true },
        {
          CORPORATE_STRUCTURE_NORMALIZER_CONFIRM:
            CORPORATE_STRUCTURE_NORMALIZER_CONFIRMATION,
        },
      ),
    ).not.toBeNull();
    const authorization = authorizeCorporateStructuralApply(
      { requestedApply: true },
      {
        CORPORATE_STRUCTURE_NORMALIZER_CONFIRM:
          CORPORATE_STRUCTURE_NORMALIZER_CONFIRMATION,
      },
    );
    if (!authorization) throw new Error("autorização de teste ausente");
    await expect(
      executeCorporateStructuralPlan(plan, authorization, execute),
    ).resolves.toBe(4);
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
