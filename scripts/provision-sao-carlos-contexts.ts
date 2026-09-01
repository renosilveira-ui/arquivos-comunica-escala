/**
 * Provisiona, de forma idempotente, os quatro contextos iniciais do Hospital
 * São Carlos. O padrão é somente leitura; escrita exige `--apply`, IDs, nomes
 * esperados e uma frase de confirmação explícita.
 *
 * Exemplo de dry-run:
 *   HSC_INSTITUTION_ID=... HSC_INSTITUTION_NAME='...' \
 *   HSC_HOSPITAL_ID=... HSC_HOSPITAL_NAME='Hospital São Carlos' \
 *   pnpm exec tsx scripts/provision-sao-carlos-contexts.ts
 *
 * Para aplicar, acrescente:
 *   HSC_PROVISION_CONFIRM=SAO_CARLOS_MULTISETOR --apply
 */
import "dotenv/config";
import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { resolveSslConfig } from "../server/_core/db-ssl";
import type { MedicalSpecialtyCode } from "../lib/medical-specialties";
import {
  HSC_SCHEDULE_CONTEXT_BLUEPRINT,
  type PinnedQualification,
  type ScheduleContextAdmissionPolicy,
} from "../lib/sao-carlos-schedule-blueprint";

export { HSC_SCHEDULE_CONTEXT_BLUEPRINT } from "../lib/sao-carlos-schedule-blueprint";

type IdentityRow = RowDataPacket & {
  id: number;
  name: string;
  institutionId?: number;
  isActive?: number | boolean;
};

type SectorRow = RowDataPacket & {
  id: number;
  institutionId: number;
  hospitalId: number;
  name: string;
};

export function assertExactSaoCarlosSectorTopology(
  sector: Pick<SectorRow, "institutionId" | "hospitalId" | "name">,
  expected: { institutionId: number; hospitalId: number; name: string },
): void {
  if (
    sector.institutionId !== expected.institutionId ||
    sector.hospitalId !== expected.hospitalId ||
    sector.name !== expected.name
  ) {
    throw new Error(
      `Setor ${expected.name} existe como alias ou fora da topologia exata; corrija antes de provisionar`,
    );
  }
}

type ContextRow = RowDataPacket & {
  id: number;
  active: number | boolean;
  admissionPolicy?: string;
};

type CountRow = RowDataPacket & { count: number };

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

function buildConnectionOptions() {
  const rawUrl = requireNonEmpty("DATABASE_URL");
  const url = new URL(rawUrl);
  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL deve usar protocolo mysql://");
  }
  if (url.hash) {
    throw new Error("DATABASE_URL não pode conter fragmento");
  }
  const sslMode = url.searchParams.get("ssl-mode")?.toUpperCase() ?? null;
  const acceptedSearch =
    [...url.searchParams.keys()].every((key) => key === "ssl-mode") &&
    (sslMode === null || sslMode === "REQUIRED");
  if (!acceptedSearch) {
    throw new Error(
      "DATABASE_URL aceita somente o parâmetro ssl-mode=REQUIRED",
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
      sslMode === "REQUIRED"
        ? { rejectUnauthorized: true }
        : resolveSslConfig(process.env),
  };
}

async function assertTarget(
  connection: Connection,
  input: {
    institutionId: number;
    institutionName: string;
    hospitalId: number;
    hospitalName: string;
  },
): Promise<void> {
  const [institutions] = await connection.execute<IdentityRow[]>(
    "SELECT id, name, is_active AS isActive FROM institutions WHERE id = ? FOR UPDATE",
    [input.institutionId],
  );
  const institution = institutions[0];
  if (
    !institution ||
    institution.name !== input.institutionName ||
    !institution.isActive
  ) {
    throw new Error("Instituição alvo não confere ou está inativa");
  }
  const [hospitals] = await connection.execute<IdentityRow[]>(
    "SELECT id, institution_id AS institutionId, name FROM hospitals WHERE id = ? FOR UPDATE",
    [input.hospitalId],
  );
  const hospital = hospitals[0];
  if (
    !hospital ||
    hospital.institutionId !== input.institutionId ||
    hospital.name !== input.hospitalName
  ) {
    throw new Error(
      "Hospital alvo não confere com a instituição e o nome esperados",
    );
  }
}

async function findSector(
  connection: Connection,
  institutionId: number,
  hospitalId: number,
  name: string,
): Promise<SectorRow | null> {
  const [rows] = await connection.execute<SectorRow[]>(
    `SELECT id, institution_id AS institutionId, hospital_id AS hospitalId, name
       FROM sectors
      WHERE hospital_id = ?
        AND LOWER(TRIM(name)) = LOWER(TRIM(?))
      ORDER BY id
      FOR UPDATE`,
    [hospitalId, name],
  );
  if (rows.length > 1) {
    throw new Error(`Setor duplicado no hospital: ${name}`);
  }
  const sector = rows[0] ?? null;
  if (sector) {
    assertExactSaoCarlosSectorTopology(sector, {
      institutionId,
      hospitalId,
      name,
    });
  }
  return sector;
}

async function resolveSpecialtyId(
  connection: Connection,
  code: MedicalSpecialtyCode,
): Promise<number> {
  const [rows] = await connection.execute<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM medical_specialties WHERE code = ? AND active = TRUE FOR SHARE",
    [code],
  );
  if (rows.length !== 1) {
    throw new Error(`Especialidade ausente/inativa no catálogo: ${code}`);
  }
  return rows[0]!.id;
}

async function ensureContext(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    admissionPolicy: ScheduleContextAdmissionPolicy;
    qualification?: PinnedQualification;
    apply: boolean;
  },
): Promise<"create" | "reactivate" | "exists"> {
  const specialtyId =
    input.qualification?.kind === "MEDICAL_SPECIALTY"
      ? await resolveSpecialtyId(connection, input.qualification.code)
      : null;
  const operationalProfileCode =
    input.qualification?.kind === "OPERATIONAL_PROFILE"
      ? input.qualification.code
      : null;
  const [rows] = await connection.execute<ContextRow[]>(
    `SELECT id, active
       FROM schedule_contexts
      WHERE institution_id = ?
        AND hospital_id = ?
        AND sector_id = ?
        AND admission_policy = ?
        AND medical_specialty_id <=> ?
        AND operational_profile_code <=> ?
      ORDER BY id
      FOR UPDATE`,
    [
      input.institutionId,
      input.hospitalId,
      input.sectorId,
      input.admissionPolicy,
      specialtyId,
      operationalProfileCode,
    ],
  );
  if (rows.length > 1) throw new Error("Contexto de escala duplicado");
  const existing = rows[0];
  if (existing) {
    if (existing.active) return "exists";
    if (input.apply) {
      await connection.execute(
        "UPDATE schedule_contexts SET active = TRUE WHERE id = ? AND active = FALSE",
        [existing.id],
      );
    }
    return "reactivate";
  }
  if (input.apply) {
    await connection.execute(
      `INSERT INTO schedule_contexts
        (institution_id, hospital_id, sector_id, medical_specialty_id, operational_profile_code, admission_policy, active)
       VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
      [
        input.institutionId,
        input.hospitalId,
        input.sectorId,
        specialtyId,
        operationalProfileCode,
        input.admissionPolicy,
      ],
    );
  }
  return "create";
}

async function findContextId(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    admissionPolicy: ScheduleContextAdmissionPolicy;
    specialtyId: number | null;
    operationalProfileCode: string | null;
  },
): Promise<number | null> {
  const [rows] = await connection.execute<(RowDataPacket & { id: number })[]>(
    `SELECT id
       FROM schedule_contexts
      WHERE institution_id = ?
        AND hospital_id = ?
        AND sector_id = ?
        AND admission_policy = ?
        AND medical_specialty_id <=> ?
        AND operational_profile_code <=> ?
      ORDER BY id
      FOR SHARE`,
    [
      input.institutionId,
      input.hospitalId,
      input.sectorId,
      input.admissionPolicy,
      input.specialtyId,
      input.operationalProfileCode,
    ],
  );
  if (rows.length > 1) {
    throw new Error(
      "Mais de um contexto ativo/inativo corresponde à mesma configuração; regularize antes de provisionar",
    );
  }
  return rows[0]?.id ?? null;
}

async function ensureAllowlistQualification(
  connection: Connection,
  input: {
    scheduleContextId: number;
    qualification: PinnedQualification;
    apply: boolean;
  },
): Promise<"create" | "exists"> {
  const specialtyId =
    input.qualification.kind === "MEDICAL_SPECIALTY"
      ? await resolveSpecialtyId(connection, input.qualification.code)
      : null;
  const operationalProfileCode =
    input.qualification.kind === "OPERATIONAL_PROFILE"
      ? input.qualification.code
      : null;
  const [rows] = await connection.execute<CountRow[]>(
    `SELECT COUNT(*) AS count
       FROM schedule_context_allowed_qualifications
      WHERE schedule_context_id = ?
        AND medical_specialty_id <=> ?
        AND operational_profile_code <=> ?`,
    [input.scheduleContextId, specialtyId, operationalProfileCode],
  );
  if (Number(rows[0]?.count ?? 0) > 0) return "exists";
  if (input.apply) {
    await connection.execute(
      `INSERT INTO schedule_context_allowed_qualifications
        (schedule_context_id, medical_specialty_id, operational_profile_code)
       VALUES (?, ?, ?)`,
      [input.scheduleContextId, specialtyId, operationalProfileCode],
    );
  }
  return "create";
}

async function consolidateLegacyPinnedContexts(
  connection: Connection,
  input: {
    sectorId: number;
    unifiedContextId: number;
    apply: boolean;
  },
): Promise<number> {
  const [legacy] = await connection.execute<(RowDataPacket & { id: number })[]>(
    `SELECT id
       FROM schedule_contexts
      WHERE sector_id = ?
        AND admission_policy = 'PINNED_QUALIFICATION'
        AND active = TRUE
        AND id <> ?
      ORDER BY id
      FOR UPDATE`,
    [input.sectorId, input.unifiedContextId],
  );
  if (legacy.length === 0 || !input.apply) return legacy.length;
  const legacyIds = legacy.map((row) => row.id);
  const placeholders = legacyIds.map(() => "?").join(", ");
  await connection.execute(
    `UPDATE shift_instances
        SET schedule_context_id = ?
      WHERE schedule_context_id IN (${placeholders})`,
    [input.unifiedContextId, ...legacyIds],
  );
  await connection.execute(
    `UPDATE schedule_contexts
        SET active = FALSE
      WHERE id IN (${placeholders})`,
    legacyIds,
  );
  return legacy.length;
}

async function assertUnifiedSectorContextIntegrity(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    expectedContextId: number;
  },
): Promise<void> {
  const [contexts] = await connection.execute<
    (RowDataPacket & { id: number; admissionPolicy: string })[]
  >(
    `SELECT id, admission_policy AS admissionPolicy
       FROM schedule_contexts
      WHERE institution_id = ?
        AND hospital_id = ?
        AND sector_id = ?
        AND active = TRUE
      ORDER BY id
      FOR SHARE`,
    [input.institutionId, input.hospitalId, input.sectorId],
  );
  if (
    contexts.length !== 1 ||
    contexts[0]?.id !== input.expectedContextId ||
    contexts[0]?.admissionPolicy !== "QUALIFICATION_ALLOWLIST"
  ) {
    throw new Error(
      "O setor deve ter exatamente uma escala unificada ativa antes da consolidação",
    );
  }
  const [allowlist] = await connection.execute<
    (RowDataPacket & { id: number })[]
  >(
    `SELECT id
       FROM schedule_context_allowed_qualifications
      WHERE schedule_context_id = ?
      FOR SHARE`,
    [input.expectedContextId],
  );
  if (allowlist.length === 0) {
    throw new Error(
      "A escala unificada está sem metadado clínico de allowlist",
    );
  }
}

async function ensureUnifiedAllowlistContext(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    qualifications: readonly PinnedQualification[];
    apply: boolean;
  },
): Promise<string> {
  const contextAction = await ensureContext(connection, {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    sectorId: input.sectorId,
    admissionPolicy: "QUALIFICATION_ALLOWLIST",
    apply: input.apply,
  });
  const contextId = await findContextId(connection, {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    sectorId: input.sectorId,
    admissionPolicy: "QUALIFICATION_ALLOWLIST",
    specialtyId: null,
    operationalProfileCode: null,
  });
  const allowlistActions: string[] = [];
  if (contextId) {
    for (const qualification of input.qualifications) {
      const allowAction = await ensureAllowlistQualification(connection, {
        scheduleContextId: contextId,
        qualification,
        apply: input.apply,
      });
      allowlistActions.push(`${qualification.code}=${allowAction}`);
    }
    const retired = await consolidateLegacyPinnedContexts(connection, {
      sectorId: input.sectorId,
      unifiedContextId: contextId,
      apply: input.apply,
    });
    if (retired > 0) {
      allowlistActions.push(`retired=${retired}`);
    }
    if (input.apply) {
      await assertUnifiedSectorContextIntegrity(connection, {
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        expectedContextId: contextId,
      });
    }
  }
  return `QUALIFICATION_ALLOWLIST=${contextAction}; ${allowlistActions.join(", ")}`;
}

function blueprintSpecialtyCodes(): MedicalSpecialtyCode[] {
  return [
    ...new Set(
      HSC_SCHEDULE_CONTEXT_BLUEPRINT.flatMap((item) => {
        if (item.admission.mode === "QUALIFICATION_ALLOWLIST") {
          return item.admission.qualifications.flatMap((qualification) =>
            qualification.kind === "MEDICAL_SPECIALTY"
              ? [qualification.code]
              : [],
          );
        }
        if (
          item.admission.mode === "PINNED_QUALIFICATION" &&
          item.admission.qualification.kind === "MEDICAL_SPECIALTY"
        ) {
          return [item.admission.qualification.code];
        }
        return [];
      }),
    ),
  ];
}

async function assertCatalogReady(connection: Connection): Promise<void> {
  for (const code of blueprintSpecialtyCodes()) {
    await resolveSpecialtyId(connection, code);
  }
}

async function assertPriorityPilotReady(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
  },
): Promise<void> {
  const recovery = HSC_SCHEDULE_CONTEXT_BLUEPRINT.find(
    (item) => item.sectorName === "Sala de Recuperação",
  );
  if (!recovery) throw new Error("Blueprint da Sala de Recuperação ausente");
  const sector = await findSector(
    connection,
    input.institutionId,
    input.hospitalId,
    recovery.sectorName,
  );
  if (!sector) throw new Error("Sala de Recuperação ainda não foi criada");

  if (recovery.admission.mode !== "QUALIFICATION_ALLOWLIST") {
    throw new Error(
      "Sala de Recuperação deve ter lista fechada de qualificações",
    );
  }
  const [contexts] = await connection.execute<ContextRow[]>(
    `SELECT id, active, admission_policy AS admissionPolicy
       FROM schedule_contexts
      WHERE institution_id = ?
        AND hospital_id = ?
        AND sector_id = ?
        AND active = TRUE
      ORDER BY id
      FOR SHARE`,
    [input.institutionId, input.hospitalId, sector.id],
  );
  if (
    contexts.length !== 1 ||
    contexts[0]?.admissionPolicy !== "QUALIFICATION_ALLOWLIST"
  ) {
    throw new Error(
      "Sala de Recuperação deve ter exatamente uma escala unificada ativa",
    );
  }
  const [allowlist] = await connection.execute<CountRow[]>(
    `SELECT COUNT(*) AS count
       FROM schedule_context_allowed_qualifications
      WHERE schedule_context_id = ?`,
    [contexts[0]!.id],
  );
  if (
    Number(allowlist[0]?.count ?? 0) !==
    recovery.admission.qualifications.length
  ) {
    throw new Error(
      "Sala de Recuperação ainda não tem todas as qualificações permitidas",
    );
  }

  const [templates] = await connection.execute<CountRow[]>(
    `SELECT COUNT(*) AS count
       FROM shift_templates
      WHERE institution_id = ?
        AND hospital_id = ?
        AND (sector_id IS NULL OR sector_id = ?)
        AND is_active = TRUE`,
    [input.institutionId, input.hospitalId, sector.id],
  );
  if (Number(templates[0]?.count ?? 0) < 1) {
    throw new Error(
      "Sala de Recuperação não possui template de horário ativo aplicável",
    );
  }

  const [eligible] = await connection.execute<CountRow[]>(
    `SELECT COUNT(DISTINCT professional.id) AS count
       FROM professionals AS professional
       INNER JOIN professional_institutions AS membership
         ON membership.professional_id = professional.id
        AND membership.user_id = professional.user_id
        AND membership.institution_id = ?
        AND membership.active = TRUE
       INNER JOIN users AS user
         ON user.id = professional.user_id
        AND user.approval_status = 'APPROVED'
        AND user.deleted_at IS NULL
       INNER JOIN professional_access AS access
         ON access.professional_id = professional.id
        AND access.institution_id = ?
        AND access.hospital_id = ?
        AND access.sector_id = ?
        AND access.can_access = TRUE`,
    [input.institutionId, input.institutionId, input.hospitalId, sector.id],
  );
  if (Number(eligible[0]?.count ?? 0) < 1) {
    throw new Error(
      "Sala de Recuperação não possui profissional aprovado com acesso setorial ativo",
    );
  }
}

export async function provisionSaoCarlosContexts(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const checkReady = process.argv.includes("--check-ready");
  if (apply && checkReady) {
    throw new Error("Use --apply e --check-ready em etapas separadas");
  }
  if (apply && process.env.HSC_PROVISION_CONFIRM !== "SAO_CARLOS_MULTISETOR") {
    throw new Error(
      "--apply exige HSC_PROVISION_CONFIRM=SAO_CARLOS_MULTISETOR",
    );
  }
  const target = {
    institutionId: requirePositiveInteger("HSC_INSTITUTION_ID"),
    institutionName: requireNonEmpty("HSC_INSTITUTION_NAME"),
    hospitalId: requirePositiveInteger("HSC_HOSPITAL_ID"),
    hospitalName: requireNonEmpty("HSC_HOSPITAL_NAME"),
  };
  const connection = await mysql.createConnection(buildConnectionOptions());
  const lockName = `escala:hsc-contexts:${target.institutionId}:${target.hospitalId}`;
  let locked = false;
  try {
    const [lockRows] = await connection.execute<
      (RowDataPacket & { acquired: number | null })[]
    >("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    if (lockRows[0]?.acquired !== 1) {
      throw new Error("Outra configuração do São Carlos está em andamento");
    }
    locked = true;
    await connection.beginTransaction();
    await assertTarget(connection, target);
    await assertCatalogReady(connection);

    if (checkReady) {
      await assertPriorityPilotReady(connection, target);
      await connection.rollback();
      console.log(
        "Pronto para o piloto: Sala de Recuperação tem contexto, template e profissional elegível.",
      );
      return;
    }

    const plan: string[] = [];
    for (const item of HSC_SCHEDULE_CONTEXT_BLUEPRINT) {
      let sector = await findSector(
        connection,
        target.institutionId,
        target.hospitalId,
        item.sectorName,
      );
      let sectorAction = "exists";
      if (!sector) {
        sectorAction = "create";
        if (apply) {
          const [insert] = await connection.execute<ResultSetHeader>(
            `INSERT INTO sectors
              (institution_id, hospital_id, name, category, color, min_staff_count)
             VALUES (?, ?, ?, ?, ?, 2)`,
            [
              target.institutionId,
              target.hospitalId,
              item.sectorName,
              item.category,
              item.color,
            ],
          );
          sector = {
            id: insert.insertId,
            institutionId: target.institutionId,
            hospitalId: target.hospitalId,
            name: item.sectorName,
          } as SectorRow;
        }
      }
      const contextActions: string[] = [];
      if (sector && item.admission.mode === "QUALIFICATION_ALLOWLIST") {
        contextActions.push(
          await ensureUnifiedAllowlistContext(connection, {
            institutionId: target.institutionId,
            hospitalId: target.hospitalId,
            sectorId: sector.id,
            qualifications: item.admission.qualifications,
            apply,
          }),
        );
      } else if (sector && item.admission.mode === "PINNED_QUALIFICATION") {
        const contextAction = await ensureContext(connection, {
          institutionId: target.institutionId,
          hospitalId: target.hospitalId,
          sectorId: sector.id,
          admissionPolicy: "PINNED_QUALIFICATION",
          qualification: item.admission.qualification,
          apply,
        });
        contextActions.push(
          `${item.admission.qualification.code}=${contextAction}`,
        );
      } else if (sector && item.admission.mode !== "PINNED_QUALIFICATION") {
        const contextAction = await ensureContext(connection, {
          institutionId: target.institutionId,
          hospitalId: target.hospitalId,
          sectorId: sector.id,
          admissionPolicy: item.admission.mode,
          apply,
        });
        contextActions.push(`${item.admission.mode}=${contextAction}`);
      } else {
        contextActions.push("create");
      }
      plan.push(
        `${item.sectorName}: setor=${sectorAction}; ${contextActions.join(", ")}`,
      );
    }

    if (apply) await connection.commit();
    else await connection.rollback();
    console.log(apply ? "Configuração aplicada:" : "Dry-run; nenhuma escrita:");
    for (const line of plan) console.log(`- ${line}`);
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // A falha original é mais informativa; a operação continua abortada.
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
      } catch {
        // O fechamento da conexão também libera o advisory lock.
      }
    }
    await connection.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  provisionSaoCarlosContexts().catch((error) => {
    console.error(
      "Falha ao provisionar São Carlos:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  });
}
