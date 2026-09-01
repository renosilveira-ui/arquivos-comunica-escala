/**
 * Planeja a estrutura confirmada da Unimed: Hospital Regional Unimed (HRU)
 * e Hospital Unimed Sul (HUS), com as oito especialidades assistenciais
 * descritivas por setor.
 *
 * Este arquivo é deliberadamente somente leitura. A antiga provisão por CLI
 * aceitava uma confirmação de ambiente como se ela provasse quem autorizou a
 * alteração. Ela não prova: qualquer operador com acesso ao processo poderia
 * atribuir a escrita a um gestor. Até existir uma mutation autenticada, com
 * sessão e revalidação transacional de papel/escopo, `--apply` permanece
 * bloqueado.
 *
 * Uso (somente plano):
 *   UNIMED_INSTITUTION_ID=... \
 *   UNIMED_INSTITUTION_NAME='Unimed' \
 *   DATABASE_URL='mysql://...' \
 *   pnpm plan:unimed-hospital-provision
 *
 * O plano não cria hospital, setor, contexto, template, calendário, plantão,
 * alocação, convite, acesso profissional ou relação N:N. Ele apenas verifica
 * se a migration N:N é compatível e informa cada ação que a futura mutation
 * autenticada precisará executar.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  assertUnimedHospitalProvisionBlueprint,
  UNIMED_HOSPITAL_PROVISION_BLUEPRINT,
} from "../lib/unimed-hospital-provision-blueprint";
import type { MedicalSpecialtyCode } from "../lib/medical-specialties";
import { resolveSslConfig } from "../server/_core/db-ssl";

type Target = Readonly<{
  institutionId: number;
  institutionName: string;
}>;

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
  category: "internacao" | "cirurgico" | "servico";
  color: string;
};

type SpecialtyRow = RowDataPacket & {
  id: number;
  code: string;
  active: number | boolean;
};

type ExistingSectorSpecialtyRow = RowDataPacket & {
  medicalSpecialtyId: number;
  code: string | null;
};

type InformationSchemaColumnRow = RowDataPacket & {
  columnName: string;
  dataType: string;
  columnType: string;
  isNullable: "YES" | "NO";
  columnDefault: string | null;
  extra: string;
};

type InformationSchemaIndexRow = RowDataPacket & {
  indexName: string;
  nonUnique: number;
  sequence: number;
  columnName: string;
};

type InformationSchemaForeignKeyRow = RowDataPacket & {
  constraintName: string;
  sequence: number;
  columnName: string;
  referencedTableSchema: string;
  referencedTableName: string;
  referencedColumnName: string;
  updateRule: string;
  deleteRule: string;
};

export type PlannedAction = "CREATE" | "EXISTS";

export type UnimedHospitalProvisionPlan = Readonly<{
  mode: "READ_ONLY_PLAN";
  applyAvailability: "BLOCKED_UNTIL_AUTHENTICATED_MUTATION";
  institution: Target;
  hospitals: readonly {
    code: "HRU" | "HUS";
    name: string;
    id: number | null;
    action: PlannedAction;
    sectors: readonly {
      name: string;
      id: number | null;
      action: PlannedAction;
      category: "internacao" | "cirurgico" | "servico";
      color: string;
      specialtyRelations: readonly {
        code: MedicalSpecialtyCode;
        action: PlannedAction;
      }[];
      preservedExistingSpecialtyCodes: readonly string[];
    }[];
  }[];
}>;

const APPLY_BLOCKED_MESSAGE =
  "--apply está bloqueado: a provisão Unimed só poderá escrever por mutation autenticada, com sessão e revalidação transacional de papel/escopo.";

function requirePositiveInteger(
  value: string | undefined,
  variableName: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${variableName} deve ser um inteiro positivo explícito.`);
  }
  return parsed;
}

function requireNonEmpty(
  value: string | undefined,
  variableName: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${variableName} é obrigatório.`);
  return trimmed;
}

function requireExactNonEmpty(
  value: string | undefined,
  variableName: string,
): string {
  const trimmed = requireNonEmpty(value, variableName);
  if (value !== trimmed) {
    throw new Error(
      `${variableName} não pode conter espaços nas extremidades.`,
    );
  }
  return trimmed;
}

function parseTarget(env: NodeJS.ProcessEnv): Target {
  return {
    institutionId: requirePositiveInteger(
      env.UNIMED_INSTITUTION_ID,
      "UNIMED_INSTITUTION_ID",
    ),
    institutionName: requireExactNonEmpty(
      env.UNIMED_INSTITUTION_NAME,
      "UNIMED_INSTITUTION_NAME",
    ),
  };
}

function parseCliArgs(argv: readonly string[]): void {
  const unexpected = argv.filter((argument) => argument !== "--apply");
  if (unexpected.length > 0) {
    throw new Error(`Argumento não suportado: ${unexpected.join(", ")}`);
  }
  if (argv.includes("--apply")) {
    throw new Error(APPLY_BLOCKED_MESSAGE);
  }
}

const LOOPBACK_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizedDatabaseHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function buildConnectionOptions(env: NodeJS.ProcessEnv) {
  const rawUrl = requireNonEmpty(env.DATABASE_URL, "DATABASE_URL");
  const url = new URL(rawUrl);
  if (url.protocol !== "mysql:" || url.hash) {
    throw new Error(
      "DATABASE_URL deve usar mysql:// e não pode conter fragmento.",
    );
  }
  const sslModes = url.searchParams.getAll("ssl-mode");
  const sslMode = sslModes[0]?.toUpperCase() ?? null;
  if (
    ![...url.searchParams.keys()].every((key) => key === "ssl-mode") ||
    sslModes.length > 1 ||
    (sslMode !== null && sslMode !== "REQUIRED")
  ) {
    throw new Error(
      "DATABASE_URL aceita somente o parâmetro ssl-mode=REQUIRED.",
    );
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("DATABASE_URL deve informar o banco.");
  const host = normalizedDatabaseHost(url.hostname);
  if (!host) throw new Error("DATABASE_URL deve informar o host.");
  const port = url.port ? Number(url.port) : 3306;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("DATABASE_URL deve informar uma porta entre 1 e 65535.");
  }
  const isLoopback = LOOPBACK_DATABASE_HOSTS.has(host);
  if (!isLoopback && sslMode !== "REQUIRED") {
    throw new Error(
      "DATABASE_URL de host remoto exige ssl-mode=REQUIRED com verificação de certificado.",
    );
  }
  return {
    host,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl:
      sslMode === "REQUIRED"
        ? { rejectUnauthorized: true }
        : resolveSslConfig(env),
  };
}

function isActive(value: number | boolean): boolean {
  return value === true || value === 1;
}

/**
 * Só serve para encontrar variações tipográficas da mesma identidade já
 * declarada no blueprint. A decisão continua exigindo a grafia exata abaixo;
 * não há equivalência semântica de nomes livres.
 */
function topologyLookupName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function assertExactName(
  actual: string,
  expected: string,
  kind: "instituição" | "hospital" | "setor",
): void {
  if (actual !== expected) {
    throw new Error(
      `${kind} encontrada como alias (${actual}); o provisionamento exige o nome exato ${expected}.`,
    );
  }
}

async function assertTargetInstitution(
  connection: Connection,
  target: Target,
): Promise<void> {
  const [rows] = await connection.execute<InstitutionRow[]>(
    `SELECT id, name, is_active AS isActive
       FROM institutions
      WHERE id = ?`,
    [target.institutionId],
  );
  if (rows.length !== 1) {
    throw new Error("Instituição alvo ausente ou duplicada.");
  }
  const institution = rows[0]!;
  assertExactName(institution.name, target.institutionName, "instituição");
  if (!isActive(institution.isActive)) {
    throw new Error("Instituição alvo está inativa.");
  }
}

async function findExactHospital(
  connection: Connection,
  target: Target,
  expectedName: string,
): Promise<HospitalRow | null> {
  const [rows] = await connection.execute<HospitalRow[]>(
    `SELECT id, institution_id AS institutionId, name
       FROM hospitals
      WHERE institution_id = ?
      ORDER BY id`,
    [target.institutionId],
  );
  const candidates = rows.filter(
    (row) => topologyLookupName(row.name) === topologyLookupName(expectedName),
  );
  if (candidates.length > 1) {
    throw new Error(`Hospital duplicado na Unimed: ${expectedName}.`);
  }
  const hospital = candidates[0] ?? null;
  if (!hospital) return null;
  if (hospital.institutionId !== target.institutionId) {
    throw new Error(`Hospital fora da topologia Unimed: ${expectedName}.`);
  }
  assertExactName(hospital.name, expectedName, "hospital");
  return hospital;
}

async function findExactSector(
  connection: Connection,
  input: Readonly<{
    institutionId: number;
    hospitalId: number;
    expectedName: string;
    expectedCategory: SectorRow["category"];
    expectedColor: string;
  }>,
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
      ORDER BY id`,
    [input.hospitalId],
  );
  const candidates = rows.filter(
    (row) =>
      topologyLookupName(row.name) === topologyLookupName(input.expectedName),
  );
  if (candidates.length > 1) {
    throw new Error(
      `Setor duplicado em hospital ${input.hospitalId}: ${input.expectedName}.`,
    );
  }
  const sector = candidates[0] ?? null;
  if (!sector) return null;
  if (
    sector.institutionId !== input.institutionId ||
    sector.hospitalId !== input.hospitalId
  ) {
    throw new Error(`Setor fora da topologia Unimed: ${input.expectedName}.`);
  }
  assertExactName(sector.name, input.expectedName, "setor");
  if (
    sector.category !== input.expectedCategory ||
    sector.color !== input.expectedColor
  ) {
    throw new Error(
      `Setor ${input.expectedName} existe com categoria/cor incompatível; não será reinterpretado.`,
    );
  }
  return sector;
}

function assertNamedIndex(
  rows: readonly InformationSchemaIndexRow[],
  indexName: string,
  nonUnique: number,
  columns: readonly string[],
): void {
  const entries = rows
    .filter((row) => row.indexName === indexName)
    .sort((left, right) => left.sequence - right.sequence);
  if (
    entries.length !== columns.length ||
    entries.some(
      (row, index) =>
        Number(row.nonUnique) !== nonUnique ||
        Number(row.sequence) !== index + 1 ||
        row.columnName !== columns[index],
    )
  ) {
    throw new Error(`Migration N:N incompatível: índice ${indexName}.`);
  }
}

function assertExpectedForeignKeys(
  rows: readonly InformationSchemaForeignKeyRow[],
): void {
  const isRestrictiveRule = (value: string): boolean =>
    value === "RESTRICT" || value === "NO ACTION";
  const expected: Readonly<Record<string, readonly [string, string][]>> = {
    fk_sector_service_specialty_institution: [
      ["institution_id", "institutions:id"],
    ],
    fk_sector_service_specialty_hospital: [["hospital_id", "hospitals:id"]],
    fk_sector_service_specialty_sector: [["sector_id", "sectors:id"]],
    fk_sector_service_specialty_medical_specialty: [
      ["medical_specialty_id", "medical_specialties:id"],
    ],
    fk_sector_service_specialty_topology: [
      ["institution_id", "sectors:institution_id"],
      ["hospital_id", "sectors:hospital_id"],
      ["sector_id", "sectors:id"],
    ],
  };
  const names = new Set(rows.map((row) => row.constraintName));
  if (
    names.size !== Object.keys(expected).length ||
    Object.keys(expected).some((name) => !names.has(name))
  ) {
    throw new Error("Migration N:N incompatível: chaves estrangeiras.");
  }

  for (const [constraintName, expectedColumns] of Object.entries(expected)) {
    const entries = rows
      .filter((row) => row.constraintName === constraintName)
      .sort((left, right) => left.sequence - right.sequence);
    if (
      entries.length !== expectedColumns.length ||
      entries.some((row, index) => {
        const [columnName, reference] = expectedColumns[index]!;
        const [tableName, referencedColumnName] = reference.split(":");
        return (
          Number(row.sequence) !== index + 1 ||
          row.columnName !== columnName ||
          row.referencedTableName !== tableName ||
          row.referencedColumnName !== referencedColumnName ||
          !isRestrictiveRule(row.updateRule) ||
          !isRestrictiveRule(row.deleteRule)
        );
      })
    ) {
      throw new Error(
        `Migration N:N incompatível: chave estrangeira ${constraintName}.`,
      );
    }
  }
}

/**
 * Garante que uma tabela homônima parcial nunca seja interpretada como a
 * relação N:N canônica. A validação lê metadados do próprio schema e não faz
 * DDL nem DML.
 */
export async function assertSectorServiceSpecialtiesMigrationCompatible(
  connection: Connection,
): Promise<void> {
  const [tables] = await connection.execute<
    (RowDataPacket & { engine: string })[]
  >(
    `SELECT ENGINE AS engine
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'sector_service_specialties'`,
  );
  if (tables.length !== 1 || tables[0]!.engine.toUpperCase() !== "INNODB") {
    throw new Error(
      "Migration N:N ausente ou incompatível: sector_service_specialties.",
    );
  }

  const [columns] = await connection.execute<InformationSchemaColumnRow[]>(
    `SELECT COLUMN_NAME AS columnName,
            DATA_TYPE AS dataType,
            COLUMN_TYPE AS columnType,
            IS_NULLABLE AS isNullable,
            COLUMN_DEFAULT AS columnDefault,
            EXTRA AS extra
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'sector_service_specialties'
      ORDER BY ORDINAL_POSITION`,
  );
  const expectedColumns = [
    "id",
    "institution_id",
    "hospital_id",
    "sector_id",
    "medical_specialty_id",
    "created_at",
  ];
  if (
    columns.length !== expectedColumns.length ||
    columns.some(
      (column, index) => column.columnName !== expectedColumns[index],
    )
  ) {
    throw new Error("Migration N:N incompatível: colunas da relação.");
  }
  const [
    id,
    institutionId,
    hospitalId,
    sectorId,
    medicalSpecialtyId,
    createdAt,
  ] = columns;
  const isSignedInt = (column: InformationSchemaColumnRow) =>
    column.dataType === "int" &&
    !column.columnType.toLowerCase().includes("unsigned") &&
    column.isNullable === "NO" &&
    column.columnDefault === null;
  if (
    !id ||
    !institutionId ||
    !hospitalId ||
    !sectorId ||
    !medicalSpecialtyId ||
    !createdAt ||
    !isSignedInt(id) ||
    !id.extra.toLowerCase().includes("auto_increment") ||
    ![institutionId, hospitalId, sectorId, medicalSpecialtyId].every(
      (column) => isSignedInt(column) && column.extra === "",
    ) ||
    createdAt.dataType !== "timestamp" ||
    createdAt.isNullable !== "NO" ||
    !["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP()", "NOW()"].includes(
      String(createdAt.columnDefault).toUpperCase(),
    ) ||
    createdAt.extra.toLowerCase().includes("on update")
  ) {
    throw new Error("Migration N:N incompatível: tipos das colunas.");
  }

  const [indexes] = await connection.execute<InformationSchemaIndexRow[]>(
    `SELECT INDEX_NAME AS indexName,
            NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequence,
            COLUMN_NAME AS columnName
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'sector_service_specialties'`,
  );
  assertNamedIndex(indexes, "PRIMARY", 0, ["id"]);
  assertNamedIndex(indexes, "uniq_sector_service_specialty", 0, [
    "institution_id",
    "hospital_id",
    "sector_id",
    "medical_specialty_id",
  ]);
  assertNamedIndex(indexes, "idx_sector_service_specialty_specialty", 1, [
    "medical_specialty_id",
    "institution_id",
  ]);

  const [foreignKeys] = await connection.execute<
    InformationSchemaForeignKeyRow[]
  >(
    `SELECT kcu.CONSTRAINT_NAME AS constraintName,
            kcu.ORDINAL_POSITION AS sequence,
            kcu.COLUMN_NAME AS columnName,
            kcu.REFERENCED_TABLE_SCHEMA AS referencedTableSchema,
            kcu.REFERENCED_TABLE_NAME AS referencedTableName,
            kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
            rc.UPDATE_RULE AS updateRule,
            rc.DELETE_RULE AS deleteRule
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS kcu
       INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND rc.TABLE_NAME = kcu.TABLE_NAME
      WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
        AND kcu.TABLE_NAME = 'sector_service_specialties'
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
        AND kcu.REFERENCED_TABLE_SCHEMA = DATABASE()`,
  );
  assertExpectedForeignKeys(foreignKeys);
}

async function resolveActiveSpecialties(
  connection: Connection,
): Promise<Map<MedicalSpecialtyCode, number>> {
  const requiredCodes = [
    ...new Set(
      UNIMED_HOSPITAL_PROVISION_BLUEPRINT.flatMap((hospital) =>
        hospital.sectors.flatMap((sector) => sector.medicalSpecialtyCodes),
      ),
    ),
  ];
  const [rows] = await connection.query<SpecialtyRow[]>(
    `SELECT id, code, active
       FROM medical_specialties
      WHERE code IN (${requiredCodes.map(() => "?").join(", ")})`,
    requiredCodes,
  );
  const result = new Map<MedicalSpecialtyCode, number>();
  for (const row of rows) {
    if (!isActive(row.active)) continue;
    if (!requiredCodes.includes(row.code as MedicalSpecialtyCode)) continue;
    if (result.has(row.code as MedicalSpecialtyCode)) {
      throw new Error(
        `Especialidade canônica duplicada no catálogo: ${row.code}.`,
      );
    }
    result.set(row.code as MedicalSpecialtyCode, Number(row.id));
  }
  const missing = requiredCodes.filter((code) => !result.has(code));
  if (missing.length > 0) {
    throw new Error(
      `Catálogo CFM incompleto ou inativo: ${missing.join(", ")}.`,
    );
  }
  return result;
}

async function listExistingSectorSpecialties(
  connection: Connection,
  input: Readonly<{
    institutionId: number;
    hospitalId: number;
    sectorId: number;
  }>,
): Promise<readonly ExistingSectorSpecialtyRow[]> {
  const [rows] = await connection.execute<ExistingSectorSpecialtyRow[]>(
    `SELECT relation.medical_specialty_id AS medicalSpecialtyId,
            specialty.code AS code
       FROM sector_service_specialties AS relation
       LEFT JOIN medical_specialties AS specialty
         ON specialty.id = relation.medical_specialty_id
      WHERE relation.institution_id = ?
        AND relation.hospital_id = ?
        AND relation.sector_id = ?
      ORDER BY specialty.code, relation.medical_specialty_id`,
    [input.institutionId, input.hospitalId, input.sectorId],
  );
  if (rows.some((row) => !row.code)) {
    throw new Error("Relação N:N contém especialidade sem catálogo canônico.");
  }
  return rows;
}

async function buildPlan(
  connection: Connection,
  target: Target,
): Promise<UnimedHospitalProvisionPlan> {
  assertUnimedHospitalProvisionBlueprint();
  await assertSectorServiceSpecialtiesMigrationCompatible(connection);
  await assertTargetInstitution(connection, target);
  const specialtyIds = await resolveActiveSpecialties(connection);

  const hospitals: UnimedHospitalProvisionPlan["hospitals"][number][] = [];
  for (const blueprintHospital of UNIMED_HOSPITAL_PROVISION_BLUEPRINT) {
    const hospital = await findExactHospital(
      connection,
      target,
      blueprintHospital.name,
    );
    const sectors: UnimedHospitalProvisionPlan["hospitals"][number]["sectors"][number][] =
      [];

    for (const blueprintSector of blueprintHospital.sectors) {
      const sector = hospital
        ? await findExactSector(connection, {
            institutionId: target.institutionId,
            hospitalId: hospital.id,
            expectedName: blueprintSector.name,
            expectedCategory: blueprintSector.category,
            expectedColor: blueprintSector.color,
          })
        : null;
      const existingRelations =
        hospital && sector
          ? await listExistingSectorSpecialties(connection, {
              institutionId: target.institutionId,
              hospitalId: hospital.id,
              sectorId: sector.id,
            })
          : [];
      const existingIds = new Set(
        existingRelations.map((relation) => relation.medicalSpecialtyId),
      );
      const expectedCodes = new Set(blueprintSector.medicalSpecialtyCodes);
      const preservedExistingSpecialtyCodes = existingRelations
        .map((relation) => relation.code!)
        .filter((code) => !expectedCodes.has(code as MedicalSpecialtyCode));

      sectors.push({
        name: blueprintSector.name,
        id: sector?.id ?? null,
        action: sector ? "EXISTS" : "CREATE",
        category: blueprintSector.category,
        color: blueprintSector.color,
        specialtyRelations: blueprintSector.medicalSpecialtyCodes.map(
          (code) => ({
            code,
            action: existingIds.has(specialtyIds.get(code)!)
              ? "EXISTS"
              : "CREATE",
          }),
        ),
        preservedExistingSpecialtyCodes,
      });
    }

    hospitals.push({
      code: blueprintHospital.code,
      name: blueprintHospital.name,
      id: hospital?.id ?? null,
      action: hospital ? "EXISTS" : "CREATE",
      sectors,
    });
  }

  return {
    mode: "READ_ONLY_PLAN",
    applyAvailability: "BLOCKED_UNTIL_AUTHENTICATED_MUTATION",
    institution: target,
    hospitals,
  };
}

/**
 * Executa exclusivamente SELECTs em uma transação READ ONLY e sempre faz
 * rollback. A assinatura aceita ambiente explícito para permitir a prova
 * contra um schema MySQL efêmero, nunca contra um banco real durante testes.
 */
export async function runUnimedHospitalProvisionPlan(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<UnimedHospitalProvisionPlan> {
  parseCliArgs(argv);
  const target = parseTarget(env);
  const connection = await mysql.createConnection(buildConnectionOptions(env));
  try {
    await connection.query("SET TRANSACTION READ ONLY");
    await connection.beginTransaction();
    const plan = await buildPlan(connection, target);
    await connection.rollback();
    return plan;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // A falha original descreve melhor a causa; a conexão será fechada.
    }
    throw error;
  } finally {
    await connection.end();
  }
}

async function main(): Promise<void> {
  const plan = await runUnimedHospitalProvisionPlan();
  console.log(JSON.stringify(plan, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      "Falha ao planejar a provisão Unimed:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  });
}
