/**
 * Normalizador corporativo da estrutura mínima de escala.
 *
 * Por padrão é dry-run transacional em modo READ ONLY. A aplicação exige os
 * dois sinais explícitos abaixo e nunca cria calendário, plantão, alocação,
 * profissional, gestor, convite, token ou dado clínico.
 *
 * Dry-run:
 *   pnpm normalize:corporate-structure
 *
 * Aplicação (não executar sem aprovação operacional específica):
 *   CORPORATE_STRUCTURE_NORMALIZER_CONFIRM=APPLY_MINIMUM_SCHEDULE_STRUCTURE \
 *   pnpm normalize:corporate-structure -- --apply
 */
import "dotenv/config";
import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { pathToFileURL } from "node:url";
import {
  authorizeCorporateStructuralApply,
  executeCorporateStructuralPlan,
  parseCorporateStructuralCliArgs,
  planCorporateStructuralNormalization,
  type CorporateStructuralAction,
  type CorporateStructuralNormalizationPlan,
  type CorporateStructuralScheduleContext,
  type CorporateStructuralShiftTemplate,
  type CorporateStructuralTarget,
} from "../lib/corporate-structural-normalizer";
import { resolveSslConfig } from "../server/_core/db-ssl";

type TargetRow = RowDataPacket & CorporateStructuralTarget;

type ContextRow = RowDataPacket & CorporateStructuralScheduleContext;

type TemplateRow = RowDataPacket & CorporateStructuralShiftTemplate;

type CorruptSectorTopologyRow = RowDataPacket & CorporateStructuralTarget;

const NORMALIZER_LOCK = "escala:corporate-structural-normalizer:v1";

function buildConnectionOptions() {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL é obrigatória");
  const url = new URL(raw);
  if (url.protocol !== "mysql:" || url.hash) {
    throw new Error("DATABASE_URL deve usar mysql:// e não pode ter fragmento");
  }
  const sslMode = url.searchParams.get("ssl-mode")?.toUpperCase() ?? null;
  if (
    ![...url.searchParams.keys()].every((key) => key === "ssl-mode") ||
    (sslMode !== null && sslMode !== "REQUIRED")
  ) {
    throw new Error("Somente ssl-mode=REQUIRED é aceito na DATABASE_URL");
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

function toBoolean(value: number | boolean): boolean {
  return value === true || value === 1;
}

function contextFromRow(row: ContextRow): CorporateStructuralScheduleContext {
  return {
    id: Number(row.id),
    institutionId: Number(row.institutionId),
    hospitalId: Number(row.hospitalId),
    sectorId: Number(row.sectorId),
    medicalSpecialtyId:
      row.medicalSpecialtyId === null ? null : Number(row.medicalSpecialtyId),
    operationalProfileCode: row.operationalProfileCode ?? null,
    admissionPolicy: row.admissionPolicy,
    active: toBoolean(row.active),
  };
}

function templateFromRow(row: TemplateRow): CorporateStructuralShiftTemplate {
  return {
    id: Number(row.id),
    institutionId: Number(row.institutionId),
    hospitalId: Number(row.hospitalId),
    sectorId: row.sectorId === null ? null : Number(row.sectorId),
    name: row.name,
    startTime: String(row.startTime),
    endTime: String(row.endTime),
    isActive: toBoolean(row.isActive),
    priority: Number(row.priority),
  };
}

async function listActiveSectorTargets(
  connection: Connection,
  forUpdate: boolean,
): Promise<CorporateStructuralTarget[]> {
  const [rows] = await connection.query<TargetRow[]>(
    `SELECT sector.institution_id AS institutionId,
            sector.hospital_id AS hospitalId,
            sector.id AS sectorId
       FROM sectors AS sector
       INNER JOIN institutions AS institution
         ON institution.id = sector.institution_id
        AND institution.is_active = TRUE
       INNER JOIN hospitals AS hospital
         ON hospital.id = sector.hospital_id
        AND hospital.institution_id = sector.institution_id
      ORDER BY sector.institution_id, sector.hospital_id, sector.id${forUpdate ? " FOR UPDATE" : ""}`,
  );
  return rows.map((row) => ({
    institutionId: Number(row.institutionId),
    hospitalId: Number(row.hospitalId),
    sectorId: Number(row.sectorId),
  }));
}

async function listCorruptActiveSectorTopologies(
  connection: Connection,
): Promise<CorporateStructuralTarget[]> {
  const [rows] = await connection.query<CorruptSectorTopologyRow[]>(
    `SELECT sector.institution_id AS institutionId,
            sector.hospital_id AS hospitalId,
            sector.id AS sectorId
       FROM sectors AS sector
       INNER JOIN institutions AS institution
         ON institution.id = sector.institution_id
        AND institution.is_active = TRUE
       LEFT JOIN hospitals AS hospital
         ON hospital.id = sector.hospital_id
        AND hospital.institution_id = sector.institution_id
      WHERE hospital.id IS NULL
      ORDER BY sector.institution_id, sector.hospital_id, sector.id`,
  );
  return rows.map((row) => ({
    institutionId: Number(row.institutionId),
    hospitalId: Number(row.hospitalId),
    sectorId: Number(row.sectorId),
  }));
}

async function loadSectorContexts(
  connection: Connection,
  target: CorporateStructuralTarget,
  forUpdate: boolean,
): Promise<CorporateStructuralScheduleContext[]> {
  const [rows] = await connection.execute<ContextRow[]>(
    `SELECT id,
            institution_id AS institutionId,
            hospital_id AS hospitalId,
            sector_id AS sectorId,
            medical_specialty_id AS medicalSpecialtyId,
            operational_profile_code AS operationalProfileCode,
            admission_policy AS admissionPolicy,
            active
       FROM schedule_contexts
      WHERE sector_id = ?
      ORDER BY id${forUpdate ? " FOR UPDATE" : ""}`,
    [target.sectorId],
  );
  return rows.map(contextFromRow);
}

async function loadEffectiveTemplates(
  connection: Connection,
  target: CorporateStructuralTarget,
  forUpdate: boolean,
): Promise<CorporateStructuralShiftTemplate[]> {
  const [rows] = await connection.execute<TemplateRow[]>(
    `SELECT id,
            institution_id AS institutionId,
            hospital_id AS hospitalId,
            sector_id AS sectorId,
            name,
            start_time AS startTime,
            end_time AS endTime,
            is_active AS isActive,
            priority
       FROM shift_templates
      WHERE sector_id = ?
         OR (hospital_id = ? AND sector_id IS NULL)
      ORDER BY id${forUpdate ? " FOR UPDATE" : ""}`,
    [target.sectorId, target.hospitalId],
  );
  return rows.map(templateFromRow);
}

async function applyAction(
  connection: Connection,
  action: CorporateStructuralAction,
): Promise<void> {
  if (action.kind === "CREATE_GENERAL_CONTEXT") {
    await connection.execute<ResultSetHeader>(
      `INSERT INTO schedule_contexts
        (institution_id, hospital_id, sector_id, medical_specialty_id, operational_profile_code, admission_policy, active)
       VALUES (?, ?, ?, NULL, NULL, 'ALL_CFM_SPECIALTIES', TRUE)`,
      [action.institutionId, action.hospitalId, action.sectorId],
    );
    return;
  }
  await connection.execute<ResultSetHeader>(
    `INSERT INTO shift_templates
      (institution_id, hospital_id, sector_id, name, start_time, end_time, is_active, priority)
     VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`,
    [
      action.institutionId,
      action.hospitalId,
      action.sectorId,
      action.name,
      action.startTime,
      action.endTime,
      action.priority,
    ],
  );
}

type NormalizationSummary = Readonly<{
  target: CorporateStructuralTarget;
  status: CorporateStructuralNormalizationPlan["status"];
  issueCodes: readonly string[];
  actionKinds: readonly CorporateStructuralAction["kind"][];
  appliedActions: number;
}>;

function summarizePlan(
  plan: CorporateStructuralNormalizationPlan,
  appliedActions: number,
): NormalizationSummary {
  return {
    target: plan.target,
    status: plan.status,
    issueCodes: plan.issues.map((issue) => issue.code),
    actionKinds: plan.actions.map((action) => action.kind),
    appliedActions,
  };
}

async function acquireApplyLock(connection: Connection): Promise<void> {
  const [rows] = await connection.execute<
    (RowDataPacket & { acquired: number | null })[]
  >("SELECT GET_LOCK(?, 10) AS acquired", [NORMALIZER_LOCK]);
  if (rows[0]?.acquired !== 1) {
    throw new Error(
      "Outra normalização estrutural corporativa está em andamento",
    );
  }
}

export async function runCorporateStructuralNormalizer(
  argv = process.argv.slice(2),
): Promise<
  Readonly<{
    mode: "DRY_RUN" | "APPLY";
    sectorActivityDefinition: string;
    corruptActiveSectorTopologies: readonly CorporateStructuralTarget[];
    sectors: readonly NormalizationSummary[];
  }>
> {
  const args = parseCorporateStructuralCliArgs(argv);
  const authorization = authorizeCorporateStructuralApply(args, process.env);
  const mode = authorization === null ? "DRY_RUN" : "APPLY";
  const apply = mode === "APPLY";
  const connection = await mysql.createConnection(buildConnectionOptions());
  let locked = false;
  try {
    if (apply) {
      await acquireApplyLock(connection);
      locked = true;
      await connection.beginTransaction();
    } else {
      // Garante no próprio servidor que uma regressão no script não transforma
      // o modo padrão em escrita. Não usa locks nem executa INSERT/UPDATE.
      await connection.query("SET TRANSACTION READ ONLY");
      await connection.beginTransaction();
    }

    // Uma única conexão mantém o snapshot e os locks da aplicação. As leituras
    // são deliberadamente sequenciais para não intercalar comandos no mesmo
    // protocolo MySQL.
    const targets = await listActiveSectorTargets(connection, apply);
    const corruptActiveSectorTopologies =
      await listCorruptActiveSectorTopologies(connection);
    const sectors: NormalizationSummary[] = [];
    for (const target of targets) {
      const contexts = await loadSectorContexts(connection, target, apply);
      const templates = await loadEffectiveTemplates(connection, target, apply);
      const plan = planCorporateStructuralNormalization({
        target,
        contexts,
        templates,
      });
      const appliedActions = await executeCorporateStructuralPlan(
        plan,
        authorization,
        (action) => applyAction(connection, action),
      );
      sectors.push(summarizePlan(plan, appliedActions));
    }

    if (apply) await connection.commit();
    else await connection.rollback();

    return {
      mode,
      // A tabela sectors não possui indicador autônomo de atividade. A regra é
      // explícita para evitar inferência por nome, calendário ou vínculo.
      sectorActivityDefinition:
        "sector belongs to an institution with institutions.is_active=TRUE and a matching hospital topology",
      corruptActiveSectorTopologies,
      sectors,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // A falha original é mais útil; a conexão será encerrada no finally.
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await connection.execute("SELECT RELEASE_LOCK(?)", [NORMALIZER_LOCK]);
      } catch {
        // O fechamento da conexão libera o lock, mesmo se a rede falhar aqui.
      }
    }
    await connection.end();
  }
}

async function main(): Promise<void> {
  const report = await runCorporateStructuralNormalizer();
  console.log(JSON.stringify(report, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      "Falha na normalização estrutural corporativa:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  });
}
