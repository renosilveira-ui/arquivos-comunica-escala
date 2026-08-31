import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-31-institution-readiness-fences.sql",
    import.meta.url,
  ),
  "utf8",
);

const directTenantSources = [
  "institutions",
  "hospitals",
  "sectors",
  "schedule_contexts",
  "shift_templates",
  "shift_instances",
  "shift_assignments_v2",
  "professional_institutions",
  "professional_access",
  "manager_scope",
  "monthly_rosters",
] as const;

const relationshipSources = [
  "users",
  "professionals",
  "push_tokens",
  "schedule_context_allowed_qualifications",
] as const;

const triggerOperationsBySource: Record<string, readonly string[]> = {
  institutions: ["ai", "au", "bd"],
  hospitals: ["ai", "au", "ad"],
  sectors: ["ai", "au", "ad"],
  schedule_contexts: ["ai", "au", "ad"],
  shift_templates: ["ai", "au", "ad"],
  shift_instances: ["ai", "au", "ad"],
  shift_assignments_v2: ["ai", "au", "ad"],
  professional_institutions: ["ai", "au", "ad"],
  professional_access: ["ai", "au", "ad"],
  manager_scope: ["ai", "au", "ad"],
  monthly_rosters: ["ai", "au", "ad"],
  users: ["ai", "au", "bd"],
  professionals: ["ai", "au", "bd"],
  push_tokens: ["ai", "au", "ad"],
  schedule_context_allowed_qualifications: ["ai", "au", "ad"],
};

/** Campos que entram no relatório, no fingerprint ou na decisão de publicar. */
const observableUpdateFields: Record<string, readonly string[]> = {
  institutions: ["is_active"],
  hospitals: ["institution_id"],
  sectors: ["institution_id", "hospital_id", "name"],
  schedule_contexts: [
    "institution_id",
    "hospital_id",
    "sector_id",
    "medical_specialty_id",
    "operational_profile_code",
    "admission_policy",
    "active",
  ],
  shift_templates: [
    "institution_id",
    "hospital_id",
    "sector_id",
    "name",
    "start_time",
    "end_time",
    "priority",
    "is_active",
  ],
  shift_instances: [
    "institution_id",
    "hospital_id",
    "sector_id",
    "schedule_context_id",
    "label",
    "specialty",
    "status",
    "start_at",
    "end_at",
    "modality",
    "coverage_type",
    "payment_model",
    "productivity_cap_brl",
  ],
  shift_assignments_v2: [
    "institution_id",
    "hospital_id",
    "sector_id",
    "shift_instance_id",
    "professional_id",
    "status",
    "is_active",
  ],
  professional_institutions: [
    "institution_id",
    "professional_id",
    "user_id",
    "role_in_institution",
    "active",
  ],
  professional_access: [
    "institution_id",
    "professional_id",
    "hospital_id",
    "sector_id",
    "can_access",
  ],
  manager_scope: [
    "institution_id",
    "manager_professional_id",
    "hospital_id",
    "sector_id",
    "active",
  ],
  monthly_rosters: ["institution_id", "hospital_id", "year_month", "status"],
  users: ["email", "approval_status", "deleted_at"],
  professionals: ["user_id"],
  push_tokens: ["user_id"],
  schedule_context_allowed_qualifications: [
    "schedule_context_id",
    "medical_specialty_id",
    "operational_profile_code",
  ],
};

const sourceVisibilityFlags = {
  schedule_contexts: "active",
  shift_templates: "is_active",
  shift_assignments_v2: "is_active",
  professional_institutions: "active",
  professional_access: "can_access",
  manager_scope: "active",
} as const;

function triggerName(source: string, operation: string): string {
  return `trg_readiness_fence_${source}_${operation}`;
}

function triggerBlock(name: string): string {
  const start = migration.indexOf(`CREATE TRIGGER ${name}`);
  const next = migration.indexOf("CREATE TRIGGER ", start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

describe("migration manual de institution_readiness_fences", () => {
  it("é aditiva, repetível e não toca em fonte de prontidão", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS institution_readiness_fences",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS institution_readiness_fence_installations",
    );
    expect(migration).toContain("revision BIGINT UNSIGNED NOT NULL DEFAULT 0");
    expect(migration).toContain("fk_institution_readiness_fences_institution");
    expect(migration).toContain("coverage_version VARCHAR(64) NOT NULL");
    expect(migration).toContain("coverage_hash CHAR(64) NOT NULL");
    expect(migration).toContain(") ENGINE=InnoDB;");
    expect(migration).not.toMatch(/^\s*DELIMITER\s+/im);
    expect(migration).not.toMatch(/\bBEGIN\b/i);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|TRIGGER)\b/i);
    expect(migration).not.toMatch(
      /CREATE\s+TRIGGER[\s\S]*?\bON\s+institution_readiness_fences\b/i,
    );
    expect(migration).not.toMatch(
      /CREATE\s+TRIGGER[\s\S]*?\bON\s+institution_readiness_fence_installations\b/i,
    );

    for (const source of [...directTenantSources, ...relationshipSources]) {
      expect(migration).not.toMatch(
        new RegExp(
          `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${source}\\b`,
          "i",
        ),
      );
    }
  });

  it("cobre INSERT, UPDATE e DELETE para todas as fontes com tenant direto", () => {
    for (const source of directTenantSources) {
      for (const operation of triggerOperationsBySource[source]) {
        const name = triggerName(source, operation);
        expect(migration).toContain(
          `-- @idempotent-trigger\nCREATE TRIGGER ${name}`,
        );
        expect(triggerBlock(name)).toContain("ON DUPLICATE KEY UPDATE");
        expect(triggerBlock(name)).toContain("revision = revision + 1");
      }
    }
  });

  it("cobre as fontes sem institution_id com lookups antes da remoção", () => {
    for (const source of relationshipSources) {
      for (const operation of triggerOperationsBySource[source]) {
        const name = triggerName(source, operation);
        expect(migration).toContain(
          `-- @idempotent-trigger\nCREATE TRIGGER ${name}`,
        );
      }
    }
    expect(triggerBlock("trg_readiness_fence_users_bd")).toContain(
      "BEFORE DELETE ON users",
    );
    expect(triggerBlock("trg_readiness_fence_institutions_bd")).toContain(
      "BEFORE DELETE ON institutions",
    );
    expect(triggerBlock("trg_readiness_fence_professionals_bd")).toContain(
      "BEFORE DELETE ON professionals",
    );
    expect(triggerBlock("trg_readiness_fence_users_au")).toContain(
      "professional_institutions AS membership",
    );
    expect(triggerBlock("trg_readiness_fence_professionals_au")).toContain(
      "professional_institutions AS membership",
    );
    const allowlistUpdate = triggerBlock(
      "trg_readiness_fence_schedule_context_allowed_qualifications_au",
    );
    expect(allowlistUpdate).toContain("schedule_contexts AS schedule_context");
    expect(allowlistUpdate).toContain("SELECT affected.institution_id");
    expect(allowlistUpdate).toContain(
      "schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'",
    );
  });

  it("atribui cobertura de push pelo usuário vinculado, não pelo tenant de proveniência", () => {
    const insertBlock = triggerBlock("trg_readiness_fence_push_tokens_ai");
    const updateBlock = triggerBlock("trg_readiness_fence_push_tokens_au");

    expect(insertBlock).toContain("membership.user_id = NEW.user_id");
    expect(insertBlock).not.toContain("NEW.institution_id");
    expect(updateBlock).toContain("membership.user_id = OLD.user_id");
    expect(updateBlock).toContain("membership.user_id = NEW.user_id");
  });

  it("não invalida por materialização DRAFT que mantém o mesmo estado observado", () => {
    const insertBlock = triggerBlock("trg_readiness_fence_monthly_rosters_ai");
    const updateBlock = triggerBlock("trg_readiness_fence_monthly_rosters_au");
    const deleteBlock = triggerBlock("trg_readiness_fence_monthly_rosters_ad");

    expect(insertBlock).toContain("WHERE NEW.status <> 'DRAFT'");
    expect(updateBlock).toContain("NOT (OLD.status <=> NEW.status)");
    expect(updateBlock).toContain("NOT (OLD.year_month <=> NEW.year_month)");
    expect(updateBlock).toContain(
      "OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT'",
    );
    expect(deleteBlock).toContain("WHERE OLD.status <> 'DRAFT'");
  });

  it("avança somente por campos observáveis e não por updated_at ou metadados omitidos", () => {
    for (const [source, fields] of Object.entries(observableUpdateFields)) {
      const block = triggerBlock(triggerName(source, "au"));
      for (const field of fields) {
        expect(block).toContain(`OLD.${field}`);
        expect(block).toContain(`NEW.${field}`);
      }
    }

    const templateUpdate = triggerBlock(
      "trg_readiness_fence_shift_templates_au",
    );
    expect(templateUpdate).toContain("OLD.name");
    expect(templateUpdate).toContain("NEW.name");
  });

  it("ignora inserção, remoção e edição de registros fora do filtro de leitura", () => {
    for (const [source, flag] of Object.entries(sourceVisibilityFlags)) {
      const insertBlock = triggerBlock(triggerName(source, "ai"));
      const updateBlock = triggerBlock(triggerName(source, "au"));
      const deleteBlock = triggerBlock(triggerName(source, "ad"));

      expect(insertBlock).toContain(`WHERE NEW.${flag} = TRUE`);
      expect(deleteBlock).toContain(`WHERE OLD.${flag} = TRUE`);
      expect(updateBlock).toContain(`NOT (OLD.${flag} <=> NEW.${flag})`);
      expect(updateBlock).toContain(
        `(OLD.${flag} = TRUE OR NEW.${flag} = TRUE)`,
      );
    }
  });

  it("observa allowlist somente no contexto ativo de política canônica", () => {
    for (const operation of ["ai", "au", "ad"]) {
      const block = triggerBlock(
        triggerName("schedule_context_allowed_qualifications", operation),
      );
      expect(block).toContain("schedule_context.active = TRUE");
      expect(block).toContain(
        "schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'",
      );
    }
  });

  it("invalida também o tenant dono da topologia observável", () => {
    const hospitalObservedSources = [
      "sectors",
      "schedule_contexts",
      "shift_templates",
      "shift_instances",
      "professional_access",
      "manager_scope",
    ] as const;

    for (const source of hospitalObservedSources) {
      expect(triggerBlock(triggerName(source, "ai"))).toContain(
        "FROM hospitals AS hospital",
      );
      const updateBlock = triggerBlock(triggerName(source, "au"));
      expect(updateBlock).toContain("FROM hospitals AS old_hospital");
      expect(updateBlock).toContain("FROM hospitals AS new_hospital");
      expect(triggerBlock(triggerName(source, "ad"))).toContain(
        "FROM hospitals AS hospital",
      );
    }

    const assignmentInsert = triggerBlock(
      triggerName("shift_assignments_v2", "ai"),
    );
    const assignmentUpdate = triggerBlock(
      triggerName("shift_assignments_v2", "au"),
    );
    const assignmentDelete = triggerBlock(
      triggerName("shift_assignments_v2", "ad"),
    );
    for (const block of [assignmentInsert, assignmentDelete]) {
      expect(block).toContain("FROM shift_instances AS parent_shift");
      expect(block).toContain("INNER JOIN hospitals AS parent_hospital");
    }
    expect(assignmentUpdate).toContain(
      "FROM shift_instances AS old_parent_shift",
    );
    expect(assignmentUpdate).toContain(
      "FROM shift_instances AS new_parent_shift",
    );
    expect(assignmentUpdate).toContain(
      "INNER JOIN hospitals AS old_parent_hospital",
    );
    expect(assignmentUpdate).toContain(
      "INNER JOIN hospitals AS new_parent_hospital",
    );

    for (const operation of ["ai", "au", "ad"]) {
      expect(
        triggerBlock(
          triggerName("schedule_context_allowed_qualifications", operation),
        ),
      ).toContain("INNER JOIN hospitals AS hospital");
    }
  });

  it("usa somente OLD em DELETE e somente NEW em INSERT", () => {
    for (const [source, operations] of Object.entries(
      triggerOperationsBySource,
    )) {
      if (operations.includes("ai")) {
        expect(triggerBlock(triggerName(source, "ai"))).not.toMatch(/\bOLD\./);
      }
      const deleteOperation = operations.find(
        (operation) => operation === "ad" || operation === "bd",
      );
      if (deleteOperation) {
        expect(triggerBlock(triggerName(source, deleteOperation))).not.toMatch(
          /\bNEW\./,
        );
      }
    }
  });

  it("declara somente as fontes atuais de leitura como alvos de trigger", () => {
    const targets = [
      ...migration.matchAll(
        /CREATE\s+TRIGGER\s+\S+\s+(?:AFTER|BEFORE)\s+(?:INSERT|UPDATE|DELETE)\s+ON\s+([a-z_0-9]+)/gi,
      ),
    ].map((match) => match[1]);

    expect([...new Set(targets)].sort()).toEqual(
      [...directTenantSources, ...relationshipSources].sort(),
    );
    expect(targets).toHaveLength(
      Object.values(triggerOperationsBySource).reduce(
        (total, operations) => total + operations.length,
        0,
      ),
    );
  });

  it("mantém cada corpo de trigger em uma única instrução compatível com mysql2", () => {
    for (const [source, operations] of Object.entries(
      triggerOperationsBySource,
    )) {
      for (const operation of operations) {
        const block = triggerBlock(triggerName(source, operation));
        expect(block).toMatch(
          /FOR EACH ROW\s+INSERT INTO institution_readiness_fences/i,
        );
        expect(block).not.toMatch(/\bBEGIN\b|\bEND\b/i);
        const sqlWithoutComments = block.replace(/^\s*--.*$/gm, "");
        expect(sqlWithoutComments.match(/;/g)).toHaveLength(1);
      }
    }
  });
});
