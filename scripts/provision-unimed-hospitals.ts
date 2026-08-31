/**
 * Provisiona, de forma idempotente, a base operacional de dois hospitais
 * independentes da Unimed: Hospital Regional Unimed (HRU) e Hospital Unimed
 * Sul (HUS).
 *
 * Esta provisão cria apenas a base de escala: hospital, setor, um context
 * operacional e templates próprios do setor. Não cria plantões, alocações,
 * permissões clínicas, escopos de gestor nem tokens de push.
 *
 * Dry-run:
 *   UNIMED_INSTITUTION_ID=2 \
 *   UNIMED_INSTITUTION_NAME='Cooperativa dos Médicos de Fortaleza - Unimed' \
 *   DATABASE_SSL=require \
 *   pnpm provision:unimed-hospitals
 *
 * Aplicar:
 *   UNIMED_INSTITUTION_ID=2 \
 *   UNIMED_INSTITUTION_NAME='Cooperativa dos Médicos de Fortaleza - Unimed' \
 *   UNIMED_PROVISION_CONFIRM=UNIMED_DOIS_HOSPITAIS_V1 \
 *   DATABASE_SSL=require \
 *   pnpm provision:unimed-hospitals -- --apply
 *
 * Para uma cadeia TLS autoassinada já usada pelo provedor, substitua
 * DATABASE_SSL=require por DATABASE_SSL=insecure de forma explícita após
 * um dry-run verde. Isso mantém o canal cifrado, mas não valida a cadeia do
 * certificado; a correção definitiva é configurar uma CA verificável.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { DEFAULT_SECTOR_SHIFT_TEMPLATES } from "../lib/default-sector-shift-blueprint";
import type { MedicalSpecialtyCode } from "../lib/medical-specialties";
import { resolveSslConfig } from "../server/_core/db-ssl";

type SectorCategory = "internacao" | "cirurgico" | "servico";

type SectorBlueprint = {
  name: string;
  category: SectorCategory;
  color: string;
  specialtyCode: MedicalSpecialtyCode;
};

type HospitalBlueprint = {
  name: string;
  sectors: readonly SectorBlueprint[];
};

/** Frase explícita exigida para qualquer escrita nesta provisão. */
export const UNIMED_PROVISION_CONFIRM = "UNIMED_DOIS_HOSPITAIS_V1";

/**
 * `specialtyCode` valida o catálogo CFM que dá nome clínico ao serviço.
 * A política continua ALL_CFM_SPECIALTIES: não reintroduzimos bloqueio por
 * especialidade enquanto essa não for uma decisão explícita de produto.
 */
export const UNIMED_HOSPITAL_BLUEPRINT: readonly HospitalBlueprint[] = [
  {
    name: "Hospital Regional Unimed",
    sectors: [
      {
        name: "Anestesia",
        category: "cirurgico",
        color: "#2563EB",
        specialtyCode: "ANESTESIOLOGIA",
      },
      {
        name: "Cirurgia Geral",
        category: "cirurgico",
        color: "#7C3AED",
        specialtyCode: "CIRURGIA_GERAL",
      },
      {
        name: "UTI",
        category: "internacao",
        color: "#DC2626",
        specialtyCode: "MEDICINA_INTENSIVA",
      },
      {
        name: "Traumatologia e Ortopedia",
        category: "cirurgico",
        color: "#D97706",
        specialtyCode: "ORTOPEDIA_E_TRAUMATOLOGIA",
      },
      {
        name: "Emergência",
        category: "servico",
        color: "#059669",
        specialtyCode: "MEDICINA_DE_EMERGENCIA",
      },
    ],
  },
  {
    name: "Hospital Unimed Sul",
    sectors: [
      {
        name: "Pediatria",
        category: "internacao",
        color: "#0EA5E9",
        specialtyCode: "PEDIATRIA",
      },
      {
        name: "Anestesia",
        category: "cirurgico",
        color: "#2563EB",
        specialtyCode: "ANESTESIOLOGIA",
      },
      {
        name: "Ginecologia e Obstetrícia",
        category: "internacao",
        color: "#DB2777",
        specialtyCode: "GINECOLOGIA_E_OBSTETRICIA",
      },
    ],
  },
] as const;

type InstitutionRow = RowDataPacket & {
  id: number;
  name: string;
  isActive: number | boolean;
};

type HospitalRow = RowDataPacket & {
  id: number;
  institutionId: number;
  name: string;
};

type SectorRow = RowDataPacket & {
  id: number;
  institutionId: number;
  hospitalId: number;
  name: string;
  category: SectorCategory;
  color: string;
};

type ContextRow = RowDataPacket & {
  id: number;
  medicalSpecialtyId: number | null;
  operationalProfileCode: string | null;
  admissionPolicy: string;
  active: number | boolean;
};

type TemplateRow = RowDataPacket & {
  id: number;
  name: string;
  startTime: string;
  endTime: string;
  active: number | boolean;
  priority: number;
};

type PlannedSector = {
  name: string;
  specialtyCode: MedicalSpecialtyCode;
  sector: "create" | "exists";
  context: "create" | "exists";
  templates: number;
};

type PlannedHospital = {
  name: string;
  hospital: "create" | "exists";
  sectors: PlannedSector[];
};

type Target = {
  institutionId: number;
  institutionName: string;
};

function requirePositiveInteger(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} deve ser um inteiro positivo explícito`);
  }
  return value;
}

function requireNonEmpty(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} é obrigatório`);
  return value;
}

function clock(value: string): string {
  return value.length === 5 ? `${value}:00` : value.slice(0, 8);
}

function buildConnectionOptions() {
  const rawUrl = requireNonEmpty("DATABASE_URL");
  const url = new URL(rawUrl);
  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL deve usar protocolo mysql://");
  }
  if (url.hash) throw new Error("DATABASE_URL não pode conter fragmento");
  const sslMode = url.searchParams.get("ssl-mode")?.toUpperCase() ?? null;
  const hasLegacySsl = url.searchParams.has("ssl");
  const acceptedSearch = [...url.searchParams.keys()].every(
    (key) => key === "ssl-mode" || key === "ssl",
  );
  if (!acceptedSearch || (sslMode !== null && sslMode !== "REQUIRED")) {
    throw new Error(
      "DATABASE_URL aceita somente ssl-mode=REQUIRED ou ssl; outros parâmetros são recusados",
    );
  }
  // Algumas URLs legadas carregam `ssl={...}`. O script não desserializa
  // configuração TLS vinda da URL: a política deve ser explícita no ambiente.
  const resolvedSsl = resolveSslConfig(process.env);
  if (hasLegacySsl && !resolvedSsl) {
    throw new Error(
      "DATABASE_URL contém ssl legado; defina DATABASE_SSL=require ou insecure explicitamente",
    );
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("DATABASE_URL deve informar o banco");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl:
      resolvedSsl ??
      (sslMode === "REQUIRED" ? { rejectUnauthorized: true } : undefined),
  };
}

export function assertUnimedHospitalBlueprint(): void {
  const hospitalNames = new Set<string>();
  for (const hospital of UNIMED_HOSPITAL_BLUEPRINT) {
    const hospitalKey = hospital.name.toLocaleLowerCase("pt-BR");
    if (hospitalNames.has(hospitalKey)) {
      throw new Error(`Hospital duplicado no blueprint: ${hospital.name}`);
    }
    hospitalNames.add(hospitalKey);
    const sectorNames = new Set<string>();
    for (const sector of hospital.sectors) {
      const sectorKey = sector.name.toLocaleLowerCase("pt-BR");
      if (sectorNames.has(sectorKey)) {
        throw new Error(`Setor duplicado em ${hospital.name}: ${sector.name}`);
      }
      sectorNames.add(sectorKey);
    }
  }
}

async function assertTarget(
  connection: Connection,
  target: Target,
): Promise<void> {
  const [rows] = await connection.execute<InstitutionRow[]>(
    `SELECT id, name, is_active AS isActive
       FROM institutions
      WHERE id = ?
      FOR UPDATE`,
    [target.institutionId],
  );
  const institution = rows[0];
  if (
    !institution ||
    institution.name !== target.institutionName ||
    !institution.isActive
  ) {
    throw new Error("Instituição alvo não confere ou está inativa");
  }
}

async function assertCatalogReady(connection: Connection): Promise<void> {
  const codes = [
    ...new Set(
      UNIMED_HOSPITAL_BLUEPRINT.flatMap((hospital) =>
        hospital.sectors.map((sector) => sector.specialtyCode),
      ),
    ),
  ];
  const [rows] = await connection.query<
    (RowDataPacket & { code: string; active: number | boolean })[]
  >(
    `SELECT code, active
       FROM medical_specialties
      WHERE code IN (${codes.map(() => "?").join(", ")})
      FOR SHARE`,
    codes,
  );
  const activeCodes = new Set(
    rows.filter((row) => !!row.active).map((row) => row.code),
  );
  const missing = codes.filter((code) => !activeCodes.has(code));
  if (missing.length) {
    throw new Error(
      `Catálogo CFM incompleto ou inativo: ${missing.join(", ")}`,
    );
  }
}

async function findHospital(
  connection: Connection,
  target: Target,
  name: string,
): Promise<HospitalRow | null> {
  const [rows] = await connection.execute<HospitalRow[]>(
    `SELECT id, institution_id AS institutionId, name
       FROM hospitals
      WHERE institution_id = ?
        AND LOWER(TRIM(name)) = LOWER(TRIM(?))
      ORDER BY id
      FOR UPDATE`,
    [target.institutionId, name],
  );
  if (rows.length > 1) {
    throw new Error(`Hospital duplicado na instituição: ${name}`);
  }
  const hospital = rows[0] ?? null;
  if (
    hospital &&
    (hospital.institutionId !== target.institutionId || hospital.name !== name)
  ) {
    throw new Error(`Hospital existe como alias; corrija antes: ${name}`);
  }
  return hospital;
}

async function ensureHospital(
  connection: Connection,
  target: Target,
  blueprint: HospitalBlueprint,
  apply: boolean,
): Promise<{ action: "create" | "exists"; hospital: HospitalRow | null }> {
  const existing = await findHospital(connection, target, blueprint.name);
  if (existing) return { action: "exists", hospital: existing };
  if (!apply) return { action: "create", hospital: null };
  const [insert] = await connection.execute<ResultSetHeader>(
    `INSERT INTO hospitals (institution_id, name)
     VALUES (?, ?)`,
    [target.institutionId, blueprint.name],
  );
  return {
    action: "create",
    hospital: {
      id: insert.insertId,
      institutionId: target.institutionId,
      name: blueprint.name,
    } as HospitalRow,
  };
}

async function findSector(
  connection: Connection,
  input: { institutionId: number; hospitalId: number; name: string },
): Promise<SectorRow | null> {
  const [rows] = await connection.execute<SectorRow[]>(
    `SELECT id,
            institution_id AS institutionId,
            hospital_id AS hospitalId,
            name,
            category,
            color
       FROM sectors
      WHERE hospital_id = ?
        AND LOWER(TRIM(name)) = LOWER(TRIM(?))
      ORDER BY id
      FOR UPDATE`,
    [input.hospitalId, input.name],
  );
  if (rows.length > 1) {
    throw new Error(`Setor duplicado no hospital: ${input.name}`);
  }
  const sector = rows[0] ?? null;
  if (
    sector &&
    (sector.institutionId !== input.institutionId ||
      sector.hospitalId !== input.hospitalId ||
      sector.name !== input.name)
  ) {
    throw new Error(
      `Setor existe como alias ou fora da topologia: ${input.name}`,
    );
  }
  return sector;
}

async function ensureSector(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    blueprint: SectorBlueprint;
    apply: boolean;
  },
): Promise<{ action: "create" | "exists"; sector: SectorRow | null }> {
  const existing = await findSector(connection, {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    name: input.blueprint.name,
  });
  if (existing) return { action: "exists", sector: existing };
  if (!input.apply) return { action: "create", sector: null };
  const [insert] = await connection.execute<ResultSetHeader>(
    `INSERT INTO sectors
      (institution_id, hospital_id, name, category, color, min_staff_count)
     VALUES (?, ?, ?, ?, ?, 2)`,
    [
      input.institutionId,
      input.hospitalId,
      input.blueprint.name,
      input.blueprint.category,
      input.blueprint.color,
    ],
  );
  return {
    action: "create",
    sector: {
      id: insert.insertId,
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      name: input.blueprint.name,
      category: input.blueprint.category,
      color: input.blueprint.color,
    } as SectorRow,
  };
}

async function ensureSingleOpenContext(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    apply: boolean;
  },
): Promise<"create" | "exists"> {
  const [rows] = await connection.execute<ContextRow[]>(
    `SELECT id,
            medical_specialty_id AS medicalSpecialtyId,
            operational_profile_code AS operationalProfileCode,
            admission_policy AS admissionPolicy,
            active
       FROM schedule_contexts
      WHERE institution_id = ?
        AND hospital_id = ?
        AND sector_id = ?
      ORDER BY id
      FOR UPDATE`,
    [input.institutionId, input.hospitalId, input.sectorId],
  );
  if (rows.length > 1) {
    throw new Error(
      `Setor ${input.sectorId} já possui múltiplos contexts; consolide antes de provisionar`,
    );
  }
  const existing = rows[0];
  if (existing) {
    const compatible =
      !!existing.active &&
      existing.admissionPolicy === "ALL_CFM_SPECIALTIES" &&
      existing.medicalSpecialtyId === null &&
      existing.operationalProfileCode === null;
    if (!compatible) {
      throw new Error(
        `Contexto existente do setor ${input.sectorId} é incompatível; não será alterado automaticamente`,
      );
    }
    return "exists";
  }
  if (input.apply) {
    await connection.execute(
      `INSERT INTO schedule_contexts
        (institution_id, hospital_id, sector_id, medical_specialty_id, operational_profile_code, admission_policy, active)
       VALUES (?, ?, ?, NULL, NULL, 'ALL_CFM_SPECIALTIES', TRUE)`,
      [input.institutionId, input.hospitalId, input.sectorId],
    );
  }
  return "create";
}

async function ensureSectorTemplates(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    apply: boolean;
  },
): Promise<number> {
  const [rows] = await connection.execute<TemplateRow[]>(
    `SELECT id,
            name,
            start_time AS startTime,
            end_time AS endTime,
            is_active AS active,
            priority
       FROM shift_templates
      WHERE institution_id = ?
        AND hospital_id = ?
        AND sector_id = ?
      ORDER BY id
      FOR UPDATE`,
    [input.institutionId, input.hospitalId, input.sectorId],
  );
  const byName = new Map<string, TemplateRow>();
  for (const row of rows) {
    if (byName.has(row.name)) {
      throw new Error(
        `Template duplicado no setor ${input.sectorId}: ${row.name}`,
      );
    }
    byName.set(row.name, row);
  }

  let created = 0;
  for (const template of DEFAULT_SECTOR_SHIFT_TEMPLATES) {
    const existing = byName.get(template.name);
    if (existing) {
      const compatible =
        !!existing.active &&
        clock(existing.startTime) === template.startTime &&
        clock(existing.endTime) === template.endTime &&
        Number(existing.priority) === template.priority;
      if (!compatible) {
        throw new Error(
          `Template ${template.name} do setor ${input.sectorId} é incompatível; não será sobrescrito`,
        );
      }
      continue;
    }
    created += 1;
    if (input.apply) {
      await connection.execute(
        `INSERT INTO shift_templates
          (institution_id, hospital_id, sector_id, name, start_time, end_time, is_active, priority)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`,
        [
          input.institutionId,
          input.hospitalId,
          input.sectorId,
          template.name,
          template.startTime,
          template.endTime,
          template.priority,
        ],
      );
    }
  }
  return created;
}

async function planHospital(
  connection: Connection,
  target: Target,
  blueprint: HospitalBlueprint,
  apply: boolean,
): Promise<PlannedHospital> {
  const ensuredHospital = await ensureHospital(
    connection,
    target,
    blueprint,
    apply,
  );
  const plan: PlannedHospital = {
    name: blueprint.name,
    hospital: ensuredHospital.action,
    sectors: [],
  };
  if (!ensuredHospital.hospital) {
    for (const sector of blueprint.sectors) {
      plan.sectors.push({
        name: sector.name,
        specialtyCode: sector.specialtyCode,
        sector: "create",
        context: "create",
        templates: DEFAULT_SECTOR_SHIFT_TEMPLATES.length,
      });
    }
    return plan;
  }

  for (const sectorBlueprint of blueprint.sectors) {
    const ensuredSector = await ensureSector(connection, {
      institutionId: target.institutionId,
      hospitalId: ensuredHospital.hospital.id,
      blueprint: sectorBlueprint,
      apply,
    });
    if (!ensuredSector.sector) {
      plan.sectors.push({
        name: sectorBlueprint.name,
        specialtyCode: sectorBlueprint.specialtyCode,
        sector: "create",
        context: "create",
        templates: DEFAULT_SECTOR_SHIFT_TEMPLATES.length,
      });
      continue;
    }
    const context = await ensureSingleOpenContext(connection, {
      institutionId: target.institutionId,
      hospitalId: ensuredHospital.hospital.id,
      sectorId: ensuredSector.sector.id,
      apply,
    });
    const templates = await ensureSectorTemplates(connection, {
      institutionId: target.institutionId,
      hospitalId: ensuredHospital.hospital.id,
      sectorId: ensuredSector.sector.id,
      apply,
    });
    plan.sectors.push({
      name: sectorBlueprint.name,
      specialtyCode: sectorBlueprint.specialtyCode,
      sector: ensuredSector.action,
      context,
      templates,
    });
  }
  return plan;
}

export async function provisionUnimedHospitals(): Promise<void> {
  assertUnimedHospitalBlueprint();
  const apply = process.argv.includes("--apply");
  if (
    apply &&
    process.env.UNIMED_PROVISION_CONFIRM !== UNIMED_PROVISION_CONFIRM
  ) {
    throw new Error(
      `--apply exige UNIMED_PROVISION_CONFIRM=${UNIMED_PROVISION_CONFIRM}`,
    );
  }
  const target: Target = {
    institutionId: requirePositiveInteger("UNIMED_INSTITUTION_ID"),
    institutionName: requireNonEmpty("UNIMED_INSTITUTION_NAME"),
  };
  const connection = await mysql.createConnection(buildConnectionOptions());
  const lockName = `escala:unimed-hospitais:${target.institutionId}`;
  let locked = false;
  try {
    const [lockRows] = await connection.execute<
      (RowDataPacket & { acquired: number | null })[]
    >("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    if (lockRows[0]?.acquired !== 1) {
      throw new Error("Outra provisão da Unimed já está em andamento");
    }
    locked = true;
    await connection.beginTransaction();
    await assertTarget(connection, target);
    await assertCatalogReady(connection);

    const plan: PlannedHospital[] = [];
    for (const hospital of UNIMED_HOSPITAL_BLUEPRINT) {
      plan.push(await planHospital(connection, target, hospital, apply));
    }

    if (apply) await connection.commit();
    else await connection.rollback();
    console.log(
      apply ? "Provisão Unimed aplicada:" : "Dry-run; nenhuma escrita:",
    );
    console.log(
      JSON.stringify({ institution: target, hospitals: plan }, null, 2),
    );
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // A falha original explica a interrupção; rollback pode já ter ocorrido.
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
      } catch {
        // O encerramento da conexão libera a trava de qualquer forma.
      }
    }
    await connection.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  provisionUnimedHospitals().catch((error) => {
    console.error(
      "Falha ao provisionar hospitais Unimed:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  });
}
