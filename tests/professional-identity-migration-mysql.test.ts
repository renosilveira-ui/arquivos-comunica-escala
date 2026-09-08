import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const MIGRATION_TEST_SERVER_URL =
  process.env.PROFESSIONAL_IDENTITY_MIGRATION_TEST_SERVER_URL;
const TEMPORARY_DATABASE_PREFIX = "escala_pidf_validation_";

type MigrationTestServer = {
  host: string;
  port: number;
  user: string;
  password: string;
};

type Fixture = {
  id: number;
  slug: string;
  userRole: "admin" | "manager" | "doctor" | "nurse" | "tech";
  professionalRole: string | null;
  userRoleOnProfessional: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
  specialty: string | null;
  medicalSpecialtyId: number | null;
  operationalProfileCode: "MEDICO_GENERALISTA" | null;
  preseededProfessionCode: string | null;
  expectedProfessionCode: string | null;
  expectedFreshProfessionCode?: string | null;
  unsafeIfClassified: boolean;
};

const fixtures: Fixture[] = [
  {
    id: 1,
    slug: "doctor_medico",
    userRole: "doctor",
    professionalRole: "Médico",
    userRoleOnProfessional: "USER",
    specialty: "Anestesiologia",
    medicalSpecialtyId: 42,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "MEDIC",
    unsafeIfClassified: false,
  },
  {
    id: 2,
    slug: "doctor_enfermeiro",
    userRole: "doctor",
    professionalRole: "Enfermeiro",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "NURSING",
    unsafeIfClassified: false,
  },
  {
    id: 3,
    slug: "doctor_administrativo",
    userRole: "doctor",
    professionalRole: "Administrativo",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 4,
    slug: "doctor_empty_role",
    userRole: "doctor",
    professionalRole: "",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 5,
    slug: "doctor_null_role",
    userRole: "doctor",
    professionalRole: null,
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: "MEDICO_GENERALISTA",
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 6,
    slug: "nurse_enfermeiro",
    userRole: "nurse",
    professionalRole: "Enfermeiro",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "NURSING",
    unsafeIfClassified: false,
  },
  {
    id: 7,
    slug: "nurse_medico",
    userRole: "nurse",
    professionalRole: "Médico",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "MEDIC",
    unsafeIfClassified: false,
  },
  {
    id: 8,
    slug: "tech_tec_enf_historico",
    userRole: "tech",
    professionalRole: "Técnico de Enfermagem",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "NURSING_TECHNICIAN",
    unsafeIfClassified: false,
  },
  {
    id: 9,
    slug: "tech_tecnico",
    userRole: "tech",
    professionalRole: "Técnico",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 10,
    slug: "tech_medico",
    userRole: "tech",
    professionalRole: "Médico",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "MEDIC",
    unsafeIfClassified: false,
  },
  {
    id: 11,
    slug: "admin_medico",
    userRole: "admin",
    professionalRole: "Médico",
    userRoleOnProfessional: "GESTOR_PLUS",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "MEDIC",
    unsafeIfClassified: false,
  },
  {
    id: 12,
    slug: "admin_enfermeiro",
    userRole: "admin",
    professionalRole: "Enfermeiro",
    userRoleOnProfessional: "GESTOR_PLUS",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "NURSING",
    unsafeIfClassified: false,
  },
  {
    id: 13,
    slug: "admin_administrador",
    userRole: "admin",
    professionalRole: "Administrador",
    userRoleOnProfessional: "GESTOR_PLUS",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 14,
    slug: "admin_tecnico",
    userRole: "admin",
    professionalRole: "Técnico",
    userRoleOnProfessional: "GESTOR_PLUS",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 15,
    slug: "manager_medico",
    userRole: "manager",
    professionalRole: "Médico",
    userRoleOnProfessional: "GESTOR_MEDICO",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "MEDIC",
    unsafeIfClassified: false,
  },
  {
    id: 16,
    slug: "manager_gestor",
    userRole: "manager",
    professionalRole: "Gestor",
    userRoleOnProfessional: "GESTOR_MEDICO",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 17,
    slug: "doctor_gestor_medico_label",
    userRole: "doctor",
    professionalRole: "GESTOR_MEDICO",
    userRoleOnProfessional: "GESTOR_MEDICO",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 18,
    slug: "doctor_gestor_plus_label",
    userRole: "doctor",
    professionalRole: "GESTOR_PLUS",
    userRoleOnProfessional: "GESTOR_PLUS",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 19,
    slug: "doctor_manager_label",
    userRole: "doctor",
    professionalRole: "Manager",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 20,
    slug: "doctor_unknown_label",
    userRole: "doctor",
    professionalRole: "FooBar",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: null,
    unsafeIfClassified: true,
  },
  {
    id: 21,
    slug: "tech_tec_enf_catalogo",
    userRole: "tech",
    professionalRole: "Técnico de enfermagem",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: null,
    expectedProfessionCode: "NURSING_TECHNICIAN",
    unsafeIfClassified: false,
  },
  {
    id: 22,
    slug: "preseeded_nursing_on_medico",
    userRole: "doctor",
    professionalRole: "Médico",
    userRoleOnProfessional: "USER",
    specialty: null,
    medicalSpecialtyId: null,
    operationalProfileCode: null,
    preseededProfessionCode: "NURSING",
    expectedProfessionCode: "NURSING",
    expectedFreshProfessionCode: "MEDIC",
    unsafeIfClassified: false,
  },
];

function parseMigrationTestServer(
  raw: string | undefined,
): MigrationTestServer | null {
  if (!raw) return null;
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (
    url.protocol !== "mysql:" ||
    !localHosts.has(host) ||
    url.pathname !== "/mysql" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PROFESSIONAL_IDENTITY_MIGRATION_TEST_SERVER_URL deve apontar somente para mysql:// local e o schema mysql.",
    );
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function temporaryDatabaseName(): string {
  const suffix = `${process.pid}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const name = `${TEMPORARY_DATABASE_PREFIX}${suffix}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Nome de schema de teste inválido.");
  }
  return name;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error("Identificador SQL de teste inválido.");
  }
  return `\`${identifier}\``;
}

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-06-professional-identity-foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseMigrationTestServer(MIGRATION_TEST_SERVER_URL);
const describeWithIsolatedMysql = server ? describe : describe.skip;

function professionalsDdl(options: {
  professionCodeSql?: string;
  customProfessionNameSql?: string;
  extraIndexesSql?: string;
}): string {
  const professionCodeSql =
    options.professionCodeSql === undefined
      ? ""
      : `${options.professionCodeSql},\n`;
  const customProfessionNameSql =
    options.customProfessionNameSql === undefined
      ? ""
      : `${options.customProfessionNameSql},\n`;
  const extraIndexesSql = options.extraIndexesSql
    ? `,\n${options.extraIndexesSql}`
    : "";
  return `
    CREATE TABLE users (
      id INT NOT NULL,
      role ENUM('admin','manager','doctor','nurse','tech') NOT NULL DEFAULT 'doctor',
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE professionals (
      id INT NOT NULL,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(100) NULL,
      specialty VARCHAR(100) NULL,
      medical_specialty_id INT NULL,
      operational_profile_code ENUM('MEDICO_GENERALISTA','RESIDENTE_ANESTESIOLOGIA') NULL,
      ${professionCodeSql}${customProfessionNameSql}
      user_role ENUM('USER','GESTOR_MEDICO','GESTOR_PLUS') NOT NULL DEFAULT 'USER',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)${extraIndexesSql}
    ) ENGINE=InnoDB;
    CREATE TABLE professional_institutions (
      id INT NOT NULL,
      professional_id INT NOT NULL,
      user_id INT NOT NULL,
      institution_id INT NOT NULL,
      role_in_institution ENUM('USER','GESTOR_MEDICO','GESTOR_PLUS') NOT NULL DEFAULT 'USER',
      is_primary TINYINT(1) NOT NULL DEFAULT 0,
      active TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE professional_access (
      id INT NOT NULL,
      institution_id INT NOT NULL,
      professional_id INT NOT NULL,
      hospital_id INT NOT NULL,
      sector_id INT NULL,
      can_access TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE manager_scope (
      id INT NOT NULL,
      institution_id INT NOT NULL,
      manager_professional_id INT NOT NULL,
      hospital_id INT NOT NULL,
      sector_id INT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE shift_assignments_v2 (
      id INT NOT NULL,
      shift_instance_id INT NOT NULL,
      professional_id INT NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
  `;
}

async function seedFixtures(
  connection: Connection,
  options: { includeProfessionColumns: boolean },
) {
  for (const fixture of fixtures) {
    await connection.execute("INSERT INTO users (id, role) VALUES (?, ?)", [
      fixture.id,
      fixture.userRole,
    ]);
    if (options.includeProfessionColumns) {
      await connection.execute(
        `INSERT INTO professionals (
          id, user_id, name, role, specialty, medical_specialty_id,
          operational_profile_code, profession_code, custom_profession_name, user_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fixture.id,
          fixture.id,
          fixture.slug,
          fixture.professionalRole,
          fixture.specialty,
          fixture.medicalSpecialtyId,
          fixture.operationalProfileCode,
          fixture.preseededProfessionCode,
          null,
          fixture.userRoleOnProfessional,
        ],
      );
    } else {
      await connection.execute(
        `INSERT INTO professionals (
          id, user_id, name, role, specialty, medical_specialty_id,
          operational_profile_code, user_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fixture.id,
          fixture.id,
          fixture.slug,
          fixture.professionalRole,
          fixture.specialty,
          fixture.medicalSpecialtyId,
          fixture.operationalProfileCode,
          fixture.userRoleOnProfessional,
        ],
      );
    }
  }

  await connection.query(`
    INSERT INTO professional_institutions
      (id, professional_id, user_id, institution_id, role_in_institution, is_primary, active)
    VALUES (1, 1, 1, 10, 'USER', 1, 1);
    INSERT INTO professional_access
      (id, institution_id, professional_id, hospital_id, sector_id, can_access)
    VALUES (1, 10, 1, 20, 30, 1);
    INSERT INTO manager_scope
      (id, institution_id, manager_professional_id, hospital_id, sector_id, active)
    VALUES (1, 10, 15, 20, NULL, 1);
    INSERT INTO shift_assignments_v2
      (id, shift_instance_id, professional_id, is_active)
    VALUES (1, 100, 1, 1);
  `);
}

async function readProfessionCodes(connection: Connection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT id, name, role, profession_code
     FROM professionals
     ORDER BY id`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    slug: String(row.name),
    role: row.role === null ? null : String(row.role),
    professionCode:
      row.profession_code === null ? null : String(row.profession_code),
  }));
}

async function readColumnContract(connection: Connection, columnName: string) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT,
            IFNULL(GENERATION_EXPRESSION, '') AS GENERATION_EXPRESSION,
            EXTRA
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'professionals'
       AND COLUMN_NAME = ?`,
    [columnName],
  );
  return rows[0] ?? null;
}

async function readIndexContract(connection: Connection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE, COLLATION, SUB_PART,
            INDEX_TYPE, IS_VISIBLE
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'professionals'
       AND INDEX_NAME = 'idx_professionals_profession_code'
     ORDER BY SEQ_IN_INDEX`,
  );
  return rows.map((row) => ({
    columnName: String(row.COLUMN_NAME),
    sequence: Number(row.SEQ_IN_INDEX),
    nonUnique: Number(row.NON_UNIQUE),
    collation: row.COLLATION === null ? null : String(row.COLLATION),
    subPart: row.SUB_PART === null ? null : Number(row.SUB_PART),
    indexType: String(row.INDEX_TYPE),
    isVisible: row.IS_VISIBLE === null ? null : String(row.IS_VISIBLE),
  }));
}

/**
 * Reproduz as tabelas homônimas que neutralizavam o abort legado. A migration
 * atual não pode consultá-las: o JSON inválido deve continuar falhando mesmo
 * quando todos esses nomes já existem no schema.
 */
async function createLegacySentinelCollisionTables(connection: Connection) {
  await connection.query(`
    CREATE TABLE professional_identity_profession_code_contract_mismatch (id INT);
    CREATE TABLE professional_identity_custom_profession_name_contract_mismatch (id INT);
    CREATE TABLE professional_identity_profession_code_index_contract_mismatch (id INT);
  `);
}

async function seedContractMismatchProfessional(
  connection: Connection,
  options: {
    professionCode?: string | null;
    customProfessionName?: string | null;
  } = {},
) {
  await connection.execute("INSERT INTO users (id, role) VALUES (1, 'doctor')");
  await connection.execute(
    `INSERT INTO professionals (
      id, user_id, name, role, profession_code, custom_profession_name
    ) VALUES (1, 1, 'contract_mismatch', 'Médico', ?, ?)`,
    [options.professionCode ?? null, options.customProfessionName ?? null],
  );
}

async function readProfessionalIdentity(connection: Connection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT profession_code, custom_profession_name
     FROM professionals
     WHERE id = 1`,
  );
  return {
    professionCode:
      rows[0]?.profession_code === null
        ? null
        : String(rows[0]?.profession_code),
    customProfessionName:
      rows[0]?.custom_profession_name === null
        ? null
        : String(rows[0]?.custom_profession_name),
  };
}

async function expectContractMismatch(connection: Connection) {
  await expect(connection.query(migration)).rejects.toMatchObject({
    code: "ER_INVALID_JSON_TEXT_IN_PARAM",
    errno: 3141,
  });
}

describeWithIsolatedMysql(
  "migração de identidade profissional em MySQL isolado",
  () => {
    let admin: Connection;
    const ownedSchemas: string[] = [];

    async function openEphemeralDatabase() {
      if (!server) throw new Error("Servidor local ausente.");
      const schemaName = temporaryDatabaseName();
      await admin.query(`CREATE DATABASE ${quoteIdentifier(schemaName)}`);
      ownedSchemas.push(schemaName);
      const connection = await mysql.createConnection({
        ...server,
        database: schemaName,
        multipleStatements: true,
      });
      return { schemaName, connection };
    }

    beforeAll(async () => {
      if (!server) throw new Error("Servidor local ausente.");
      admin = await mysql.createConnection({ ...server, database: "mysql" });
    });

    afterAll(async () => {
      try {
        for (const schemaName of ownedSchemas) {
          if (schemaName.startsWith(TEMPORARY_DATABASE_PREFIX)) {
            await admin?.query(
              `DROP DATABASE IF EXISTS ${quoteIdentifier(schemaName)}`,
            );
          }
        }
      } finally {
        await admin?.end();
      }
    });

    it("A/B: schema ausente aplica, classifica só labels inequívocos e reroda sem mutar", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(professionalsDdl({}));
        await seedFixtures(connection, { includeProfessionColumns: false });
        await connection.query(migration);

        const firstPass = await readProfessionCodes(connection);
        expect(firstPass).toEqual(
          fixtures.map((fixture) => ({
            id: fixture.id,
            slug: fixture.slug,
            role: fixture.professionalRole,
            professionCode:
              fixture.expectedFreshProfessionCode ??
              fixture.expectedProfessionCode,
          })),
        );

        const falsePositives = firstPass.filter((row) => {
          const fixture = fixtures.find((item) => item.id === row.id);
          return Boolean(fixture?.unsafeIfClassified && row.professionCode);
        });
        expect(falsePositives).toEqual([]);

        const professionCode = await readColumnContract(
          connection,
          "profession_code",
        );
        const customName = await readColumnContract(
          connection,
          "custom_profession_name",
        );
        expect(professionCode).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 64,
          IS_NULLABLE: "YES",
          COLUMN_DEFAULT: null,
          GENERATION_EXPRESSION: "",
        });
        expect(String(professionCode?.EXTRA ?? "")).not.toMatch(/GENERATED/i);
        expect(customName).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 120,
          IS_NULLABLE: "YES",
          COLUMN_DEFAULT: null,
          GENERATION_EXPRESSION: "",
        });
        expect(await readIndexContract(connection)).toEqual([
          {
            columnName: "profession_code",
            sequence: 1,
            nonUnique: 1,
            collation: "A",
            subPart: null,
            indexType: "BTREE",
            isVisible: "YES",
          },
        ]);

        const [users] = await connection.query<RowDataPacket[]>(
          "SELECT id, role FROM users ORDER BY id",
        );
        expect(users.map((row) => [Number(row.id), String(row.role)])).toEqual(
          fixtures.map((fixture) => [fixture.id, fixture.userRole]),
        );

        const [professionals] = await connection.query<RowDataPacket[]>(`
          SELECT id, user_id, name, role, specialty, medical_specialty_id,
                 operational_profile_code, user_role
          FROM professionals
          ORDER BY id
        `);
        expect(
          professionals.map((row) => ({
            id: Number(row.id),
            userId: Number(row.user_id),
            name: String(row.name),
            role: row.role === null ? null : String(row.role),
            specialty: row.specialty === null ? null : String(row.specialty),
            medicalSpecialtyId:
              row.medical_specialty_id === null
                ? null
                : Number(row.medical_specialty_id),
            operationalProfileCode:
              row.operational_profile_code === null
                ? null
                : String(row.operational_profile_code),
            userRole: String(row.user_role),
          })),
        ).toEqual(
          fixtures.map((fixture) => ({
            id: fixture.id,
            userId: fixture.id,
            name: fixture.slug,
            role: fixture.professionalRole,
            specialty: fixture.specialty,
            medicalSpecialtyId: fixture.medicalSpecialtyId,
            operationalProfileCode: fixture.operationalProfileCode,
            userRole: fixture.userRoleOnProfessional,
          })),
        );

        const [memberships] = await connection.query<RowDataPacket[]>(
          "SELECT * FROM professional_institutions",
        );
        const [access] = await connection.query<RowDataPacket[]>(
          "SELECT * FROM professional_access",
        );
        const [scopes] = await connection.query<RowDataPacket[]>(
          "SELECT * FROM manager_scope",
        );
        const [assignments] = await connection.query<RowDataPacket[]>(
          "SELECT * FROM shift_assignments_v2",
        );
        expect(memberships).toHaveLength(1);
        expect(Number(memberships[0]?.professional_id)).toBe(1);
        expect(String(memberships[0]?.role_in_institution)).toBe("USER");
        expect(access).toHaveLength(1);
        expect(Number(access[0]?.professional_id)).toBe(1);
        expect(Number(access[0]?.can_access)).toBe(1);
        expect(scopes).toHaveLength(1);
        expect(Number(scopes[0]?.manager_professional_id)).toBe(15);
        expect(assignments).toHaveLength(1);
        expect(Number(assignments[0]?.professional_id)).toBe(1);

        await connection.query(migration);
        expect(await readProfessionCodes(connection)).toEqual(firstPass);
      } finally {
        await connection.end();
      }
    });

    it("G: colunas e índice exatos pré-existentes são no-op de DDL e só preenchem NULL", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
            extraIndexesSql:
              "INDEX idx_professionals_profession_code (profession_code)",
          }),
        );
        await seedFixtures(connection, { includeProfessionColumns: true });
        await connection.query(migration);
        await connection.query(migration);

        expect(await readProfessionCodes(connection)).toEqual(
          fixtures.map((fixture) => ({
            id: fixture.id,
            slug: fixture.slug,
            role: fixture.professionalRole,
            professionCode: fixture.expectedProfessionCode,
          })),
        );
        expect(await readIndexContract(connection)).toEqual([
          {
            columnName: "profession_code",
            sequence: 1,
            nonUnique: 1,
            collation: "A",
            subPart: null,
            indexType: "BTREE",
            isVisible: "YES",
          },
        ]);
      } finally {
        await connection.end();
      }
    });

    it("C: profession_code INT falha fechado e não coage MEDIC para 0", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code INT NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
          }),
        );
        await connection.execute(
          "INSERT INTO users (id, role) VALUES (1, 'doctor')",
        );
        await connection.execute(
          `INSERT INTO professionals (id, user_id, name, role)
           VALUES (1, 1, 'int_coercion', 'Médico')`,
        );

        await createLegacySentinelCollisionTables(connection);
        await expectContractMismatch(connection);

        const [rows] = await connection.query<RowDataPacket[]>(
          "SELECT profession_code FROM professionals WHERE id = 1",
        );
        expect(rows[0]?.profession_code).toBeNull();
        expect(rows[0]?.profession_code).not.toBe(0);

        const contract = await readColumnContract(
          connection,
          "profession_code",
        );
        expect(contract?.DATA_TYPE).toBe("int");
      } finally {
        await connection.end();
      }
    });

    it("D: profession_code VARCHAR(8) falha fechado e não redimensiona", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(8) NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
          }),
        );
        await connection.execute(
          "INSERT INTO users (id, role) VALUES (1, 'doctor')",
        );
        await connection.execute(
          `INSERT INTO professionals (id, user_id, name, role, profession_code)
           VALUES (1, 1, 'short_varchar', 'Médico', NULL)`,
        );

        await expectContractMismatch(connection);

        const contract = await readColumnContract(
          connection,
          "profession_code",
        );
        expect(contract).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 8,
        });
        const [rows] = await connection.query<RowDataPacket[]>(
          "SELECT profession_code FROM professionals WHERE id = 1",
        );
        expect(rows[0]?.profession_code).toBeNull();
      } finally {
        await connection.end();
      }
    });

    it("E: custom_profession_name incompatível falha fechado", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(8) NULL",
          }),
        );
        await connection.execute(
          "INSERT INTO users (id, role) VALUES (1, 'doctor')",
        );
        await connection.execute(
          `INSERT INTO professionals (id, user_id, name, role)
           VALUES (1, 1, 'custom_short', 'Médico')`,
        );

        await createLegacySentinelCollisionTables(connection);
        await expectContractMismatch(connection);

        const contract = await readColumnContract(
          connection,
          "custom_profession_name",
        );
        expect(contract).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 8,
        });
        const professionCode = await readColumnContract(
          connection,
          "profession_code",
        );
        expect(professionCode).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 64,
        });
      } finally {
        await connection.end();
      }
    });

    it("F: índice homônimo na coluna errada falha fechado", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
            extraIndexesSql: "INDEX idx_professionals_profession_code (id)",
          }),
        );
        await connection.execute(
          "INSERT INTO users (id, role) VALUES (1, 'doctor')",
        );
        await connection.execute(
          `INSERT INTO professionals (id, user_id, name, role)
           VALUES (1, 1, 'wrong_index', 'Médico')`,
        );

        await createLegacySentinelCollisionTables(connection);
        await expectContractMismatch(connection);

        expect(await readIndexContract(connection)).toEqual([
          {
            columnName: "id",
            sequence: 1,
            nonUnique: 1,
            collation: "A",
            subPart: null,
            indexType: "BTREE",
            isVisible: "YES",
          },
        ]);
        const [rows] = await connection.query<RowDataPacket[]>(
          "SELECT profession_code FROM professionals WHERE id = 1",
        );
        expect(rows[0]?.profession_code).toBeNull();
      } finally {
        await connection.end();
      }
    });

    it("H1: profession_code com DEFAULT falha fechado e não preenche a linha", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql:
              "profession_code VARCHAR(64) NULL DEFAULT 'MEDIC'",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
          }),
        );
        await seedContractMismatchProfessional(connection);

        await expectContractMismatch(connection);

        expect(
          await readColumnContract(connection, "profession_code"),
        ).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 64,
          IS_NULLABLE: "YES",
          COLUMN_DEFAULT: "MEDIC",
        });
        expect(await readProfessionalIdentity(connection)).toEqual({
          professionCode: null,
          customProfessionName: null,
        });
      } finally {
        await connection.end();
      }
    });

    it("H2: custom_profession_name com DEFAULT falha fechado e não preenche a linha", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql:
              "custom_profession_name VARCHAR(120) NULL DEFAULT 'x'",
          }),
        );
        await seedContractMismatchProfessional(connection);

        await expectContractMismatch(connection);

        expect(
          await readColumnContract(connection, "custom_profession_name"),
        ).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 120,
          IS_NULLABLE: "YES",
          COLUMN_DEFAULT: "x",
        });
        expect(await readProfessionalIdentity(connection)).toEqual({
          professionCode: null,
          customProfessionName: null,
        });
      } finally {
        await connection.end();
      }
    });

    it("H3: profession_code NOT NULL falha fechado e preserva o valor compatível pré-semeado", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NOT NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
          }),
        );
        await seedContractMismatchProfessional(connection, {
          professionCode: "NURSING",
        });

        await expectContractMismatch(connection);

        expect(
          await readColumnContract(connection, "profession_code"),
        ).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 64,
          IS_NULLABLE: "NO",
          COLUMN_DEFAULT: null,
        });
        expect(await readProfessionalIdentity(connection)).toEqual({
          professionCode: "NURSING",
          customProfessionName: null,
        });
      } finally {
        await connection.end();
      }
    });

    it("H4: custom_profession_name NOT NULL falha fechado e preserva o valor compatível pré-semeado", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql:
              "custom_profession_name VARCHAR(120) NOT NULL",
          }),
        );
        await seedContractMismatchProfessional(connection, {
          customProfessionName: "Profissão histórica",
        });

        await expectContractMismatch(connection);

        expect(
          await readColumnContract(connection, "custom_profession_name"),
        ).toMatchObject({
          DATA_TYPE: "varchar",
          CHARACTER_MAXIMUM_LENGTH: 120,
          IS_NULLABLE: "NO",
          COLUMN_DEFAULT: null,
        });
        expect(await readProfessionalIdentity(connection)).toEqual({
          professionCode: null,
          customProfessionName: "Profissão histórica",
        });
      } finally {
        await connection.end();
      }
    });

    it("I1: índice UNIQUE homônimo falha fechado e permanece UNIQUE", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
            extraIndexesSql:
              "UNIQUE INDEX idx_professionals_profession_code (profession_code)",
          }),
        );
        await seedContractMismatchProfessional(connection);

        await expectContractMismatch(connection);

        expect(await readIndexContract(connection)).toEqual([
          {
            columnName: "profession_code",
            sequence: 1,
            nonUnique: 0,
            collation: "A",
            subPart: null,
            indexType: "BTREE",
            isVisible: "YES",
          },
        ]);
        expect(await readProfessionalIdentity(connection)).toEqual({
          professionCode: null,
          customProfessionName: null,
        });
      } finally {
        await connection.end();
      }
    });

    it("I2: índice prefixado homônimo falha fechado e preserva SUB_PART", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
            extraIndexesSql:
              "INDEX idx_professionals_profession_code (profession_code(8))",
          }),
        );
        await seedContractMismatchProfessional(connection);

        await expectContractMismatch(connection);

        expect(await readIndexContract(connection)).toEqual([
          {
            columnName: "profession_code",
            sequence: 1,
            nonUnique: 1,
            collation: "A",
            subPart: 8,
            indexType: "BTREE",
            isVisible: "YES",
          },
        ]);
        expect(await readProfessionalIdentity(connection)).toEqual({
          professionCode: null,
          customProfessionName: null,
        });
      } finally {
        await connection.end();
      }
    });

    it("I3: índice FULLTEXT homônimo falha fechado e preserva o tipo", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
            extraIndexesSql:
              "FULLTEXT INDEX idx_professionals_profession_code (profession_code)",
          }),
        );
        await seedContractMismatchProfessional(connection);

        await expectContractMismatch(connection);

        expect(await readIndexContract(connection)).toEqual([
          {
            columnName: "profession_code",
            sequence: 1,
            nonUnique: 1,
            collation: null,
            subPart: null,
            indexType: "FULLTEXT",
            isVisible: "YES",
          },
        ]);
        expect(await readProfessionalIdentity(connection)).toEqual({
          professionCode: null,
          customProfessionName: null,
        });
      } finally {
        await connection.end();
      }
    });

    it("I4: índice INVISIBLE homônimo falha fechado e preserva a invisibilidade", async () => {
      const { connection } = await openEphemeralDatabase();
      try {
        await connection.query(
          professionalsDdl({
            professionCodeSql: "profession_code VARCHAR(64) NULL",
            customProfessionNameSql: "custom_profession_name VARCHAR(120) NULL",
            extraIndexesSql:
              "INDEX idx_professionals_profession_code (profession_code) INVISIBLE",
          }),
        );
        await seedContractMismatchProfessional(connection);

        await expectContractMismatch(connection);

        expect(await readIndexContract(connection)).toEqual([
          {
            columnName: "profession_code",
            sequence: 1,
            nonUnique: 1,
            collation: "A",
            subPart: null,
            indexType: "BTREE",
            isVisible: "NO",
          },
        ]);
        expect(await readProfessionalIdentity(connection)).toEqual({
          professionCode: null,
          customProfessionName: null,
        });
      } finally {
        await connection.end();
      }
    });
  },
);
