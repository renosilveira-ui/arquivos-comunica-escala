/**
 * Provisiona templates de horário, calendário mensal e gestor médico da
 * Sala de Recuperação (Hospital São Carlos). Idempotente; escrita exige
 * `--apply` e confirmação explícita.
 *
 * Dry-run:
 *   HSC_INSTITUTION_ID=... HSC_INSTITUTION_NAME='...' \
 *   HSC_HOSPITAL_ID=... HSC_HOSPITAL_NAME='Hospital São Carlos' \
 *   pnpm exec tsx scripts/provision-sala-recuperacao-schedule.ts
 *
 * Aplicar templates + gestor:
 *   HSC_PROVISION_CONFIRM=SAO_CARLOS_SALA_RECUPERACAO --apply ...
 *
 * Semear calendário de um mês (DRAFT):
 *   HSC_SEED_MONTH=2026-09 HSC_PROVISION_CONFIRM=SAO_CARLOS_SALA_RECUPERACAO \
 *     --apply --seed-month ...
 *
 * Corrigir instantes UTC de um mês já semeado (ex.: script rodou sem timezone Z):
 *   HSC_SEED_MONTH=2026-09 HSC_PROVISION_CONFIRM=SAO_CARLOS_SALA_RECUPERACAO \
 *     --apply --repair-month ...
 */
import "dotenv/config";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { resolveSslConfig } from "../server/_core/db-ssl";
import {
  SALA_RECUPERACAO_GESTOR_MEDICO_NAME,
  SALA_RECUPERACAO_SECTOR_NAME,
  SALA_RECUPERACAO_SHIFT_TEMPLATES,
  salaRecuperacaoCalendarDaysForMonth,
  type SalaRecuperacaoShiftTemplate,
} from "../lib/sala-recuperacao-shift-blueprint";
import { buildShiftTimestamps } from "../lib/hospital-time";
import { dayKeyBrt, monthWindowBrt } from "../server/local-time";
import { assertExactSaoCarlosSectorTopology } from "./provision-sao-carlos-contexts";

const PROVISION_CONFIRM = "SAO_CARLOS_SALA_RECUPERACAO";

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

type TemplateRow = RowDataPacket & {
  id: number;
  name: string;
  isActive: number | boolean;
};

type ProfessionalRow = RowDataPacket & {
  id: number;
  userId: number;
  name: string;
};

type MembershipRow = RowDataPacket & {
  id: number;
  roleInInstitution: string;
};

type ContextRow = RowDataPacket & {
  id: number;
  admissionPolicy: string;
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
    // Instantes no banco são UTC; sem timezone Z o mysql2 grava no fuso do
    // processo (3h errado se o script rodar de uma máquina em -03:00).
    timezone: "Z",
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

async function ensureShiftTemplate(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    template: SalaRecuperacaoShiftTemplate;
    apply: boolean;
  },
): Promise<"create" | "exists" | "reactivate"> {
  const [rows] = await connection.execute<TemplateRow[]>(
    `SELECT id, name, is_active AS isActive
       FROM shift_templates
      WHERE institution_id = ?
        AND hospital_id = ?
        AND sector_id = ?
        AND name = ?
      ORDER BY id
      FOR UPDATE`,
    [
      input.institutionId,
      input.hospitalId,
      input.sectorId,
      input.template.name,
    ],
  );
  if (rows.length > 1) {
    throw new Error(`Template duplicado: ${input.template.name}`);
  }
  const existing = rows[0];
  if (existing) {
    if (existing.isActive) return "exists";
    if (input.apply) {
      await connection.execute(
        `UPDATE shift_templates
            SET is_active = TRUE,
                start_time = ?,
                end_time = ?,
                priority = ?
          WHERE id = ?`,
        [
          input.template.startTime,
          input.template.endTime,
          input.template.priority,
          existing.id,
        ],
      );
    }
    return "reactivate";
  }
  if (input.apply) {
    await connection.execute(
      `INSERT INTO shift_templates
        (institution_id, hospital_id, sector_id, name, start_time, end_time, is_active, priority)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`,
      [
        input.institutionId,
        input.hospitalId,
        input.sectorId,
        input.template.name,
        input.template.startTime,
        input.template.endTime,
        input.template.priority,
      ],
    );
  }
  return "create";
}

async function resolveUnifiedSectorContextId(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
  },
): Promise<number> {
  const [rows] = await connection.execute<ContextRow[]>(
    `SELECT sc.id, sc.admission_policy AS admissionPolicy
       FROM schedule_contexts sc
      WHERE sc.institution_id = ?
        AND sc.hospital_id = ?
        AND sc.sector_id = ?
        AND sc.active = TRUE
      ORDER BY sc.id
      FOR SHARE`,
    [input.institutionId, input.hospitalId, input.sectorId],
  );
  if (rows.length === 0) {
    throw new Error(
      "Escala unificada da Sala de Recuperação ainda não foi provisionada — rode provision:sao-carlos --apply",
    );
  }
  if (rows.length !== 1) {
    throw new Error(
      "Sala de Recuperação possui mais de uma escala operacional ativa; regularize a topologia antes de semear o calendário",
    );
  }
  const context = rows[0]!;
  if (context.admissionPolicy !== "QUALIFICATION_ALLOWLIST") {
    throw new Error(
      "A escala unificada da Sala de Recuperação não usa a política configurada pelo piloto",
    );
  }
  const [allowlist] = await connection.execute<
    (RowDataPacket & { id: number })[]
  >(
    `SELECT id
       FROM schedule_context_allowed_qualifications
      WHERE schedule_context_id = ?
      FOR SHARE`,
    [context.id],
  );
  if (allowlist.length === 0) {
    throw new Error(
      "A escala unificada da Sala de Recuperação está sem metadado clínico de allowlist; regularize antes de semear o calendário",
    );
  }
  return context.id;
}

async function findProfessionalByName(
  connection: Connection,
  name: string,
): Promise<ProfessionalRow | null> {
  const [rows] = await connection.execute<ProfessionalRow[]>(
    `SELECT id, user_id AS userId, name
       FROM professionals
      WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
      ORDER BY id
      LIMIT 2
      FOR SHARE`,
    [name],
  );
  if (rows.length > 1) {
    throw new Error(`Profissional homônimo: ${name}`);
  }
  return rows[0] ?? null;
}

async function ensureGestorMedico(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    gestorName: string;
    apply: boolean;
  },
): Promise<string> {
  const professional = await findProfessionalByName(
    connection,
    input.gestorName,
  );
  if (!professional) {
    return `gestor=missing (${input.gestorName} não encontrado — cadastre no Admin e reexecute)`;
  }

  const [memberships] = await connection.execute<MembershipRow[]>(
    `SELECT id, role_in_institution AS roleInInstitution
       FROM professional_institutions
      WHERE professional_id = ?
        AND institution_id = ?
      ORDER BY id
      FOR UPDATE`,
    [professional.id, input.institutionId],
  );
  if (memberships.length > 1) {
    throw new Error("Vínculo institucional duplicado para o gestor");
  }
  const membership = memberships[0];
  let roleAction = "exists";
  if (!membership) {
    roleAction = "create-membership";
    if (input.apply) {
      await connection.execute(
        `INSERT INTO professional_institutions
          (professional_id, user_id, institution_id, role_in_institution, is_primary, active)
         VALUES (?, ?, ?, 'GESTOR_MEDICO', FALSE, TRUE)`,
        [professional.id, professional.userId, input.institutionId],
      );
      await connection.execute(
        "UPDATE professionals SET user_role = 'GESTOR_MEDICO' WHERE id = ? AND user_role = 'USER'",
        [professional.id],
      );
      await connection.execute(
        "UPDATE users SET role = 'manager' WHERE id = ? AND role = 'doctor'",
        [professional.userId],
      );
    }
  } else if (
    membership.roleInInstitution !== "GESTOR_MEDICO" &&
    membership.roleInInstitution !== "GESTOR_PLUS"
  ) {
    roleAction = "promote";
    if (input.apply) {
      await connection.execute(
        `UPDATE professional_institutions
            SET role_in_institution = 'GESTOR_MEDICO', active = TRUE
          WHERE id = ?`,
        [membership.id],
      );
      await connection.execute(
        "UPDATE professionals SET user_role = 'GESTOR_MEDICO' WHERE id = ? AND user_role = 'USER'",
        [professional.id],
      );
      await connection.execute(
        "UPDATE users SET role = 'manager' WHERE id = ? AND role = 'doctor'",
        [professional.userId],
      );
    }
  }

  const [scopes] = await connection.execute<
    (RowDataPacket & { id: number; active: number | boolean })[]
  >(
    `SELECT id, active FROM manager_scope
      WHERE institution_id = ?
        AND manager_professional_id = ?
        AND hospital_id = ?
        AND sector_id = ?
      ORDER BY id
      FOR UPDATE`,
    [input.institutionId, professional.id, input.hospitalId, input.sectorId],
  );
  let scopeAction = "exists";
  if (!scopes[0]) {
    scopeAction = "create";
    if (input.apply) {
      await connection.execute(
        `INSERT INTO manager_scope
          (institution_id, manager_professional_id, hospital_id, sector_id, active)
         VALUES (?, ?, ?, ?, TRUE)`,
        [
          input.institutionId,
          professional.id,
          input.hospitalId,
          input.sectorId,
        ],
      );
    }
  } else if (!scopes[0].active) {
    scopeAction = "reactivate";
    if (input.apply) {
      await connection.execute(
        "UPDATE manager_scope SET active = TRUE WHERE id = ?",
        [scopes[0].id],
      );
    }
  }

  return `gestor=${professional.name} membership=${roleAction} scope=${scopeAction}`;
}

async function seedMonthCalendar(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    scheduleContextId: number;
    yearMonth: string;
    apply: boolean;
  },
): Promise<{ created: number; skipped: number }> {
  const calendar = salaRecuperacaoCalendarDaysForMonth(input.yearMonth);
  let created = 0;
  let skipped = 0;

  const [rosterRows] = await connection.execute<
    (RowDataPacket & { id: number; status: string })[]
  >(
    `SELECT id, status FROM monthly_rosters
      WHERE institution_id = ? AND hospital_id = ? AND \`year_month\` = ?
      FOR UPDATE`,
    [input.institutionId, input.hospitalId, input.yearMonth],
  );
  if (!rosterRows[0]) {
    if (input.apply) {
      await connection.execute(
        `INSERT INTO monthly_rosters (institution_id, hospital_id, \`year_month\`, status)
         VALUES (?, ?, ?, 'DRAFT')`,
        [input.institutionId, input.hospitalId, input.yearMonth],
      );
    }
  } else if (rosterRows[0].status !== "DRAFT") {
    throw new Error(
      `Mês ${input.yearMonth} está ${rosterRows[0].status}; só semeamos em DRAFT`,
    );
  }

  for (const day of calendar) {
    for (const template of day.templates) {
      const [startAt, endAt] = buildShiftTimestamps(
        day.dayKey,
        template.startTime,
        template.endTime,
      );
      const [existing] = await connection.execute<
        (RowDataPacket & { id: number })[]
      >(
        `SELECT id FROM shift_instances
          WHERE institution_id = ?
            AND hospital_id = ?
            AND sector_id = ?
            AND label = ?
            AND start_at = ?
            AND end_at = ?
          LIMIT 1
          FOR SHARE`,
        [
          input.institutionId,
          input.hospitalId,
          input.sectorId,
          template.name,
          startAt,
          endAt,
        ],
      );
      if (existing[0]) {
        skipped += 1;
        continue;
      }
      if (input.apply) {
        await connection.execute(
          `INSERT INTO shift_instances
            (institution_id, hospital_id, sector_id, schedule_context_id,
             label, start_at, end_at, status, modality, payment_model)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'VAGO', 'PLANTAO', 'FIXO')`,
          [
            input.institutionId,
            input.hospitalId,
            input.sectorId,
            input.scheduleContextId,
            template.name,
            startAt,
            endAt,
          ],
        );
      }
      created += 1;
    }
  }
  return { created, skipped };
}

async function repairMonthCalendar(
  connection: Connection,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    yearMonth: string;
    apply: boolean;
  },
): Promise<{ repaired: number; alreadyCorrect: number; missing: number }> {
  const calendar = salaRecuperacaoCalendarDaysForMonth(input.yearMonth);
  const { start: monthStart, end: monthEnd } = monthWindowBrt(input.yearMonth);
  let repaired = 0;
  let alreadyCorrect = 0;
  let missing = 0;

  const [rows] = await connection.execute<
    (RowDataPacket & {
      id: number;
      label: string;
      startAt: Date;
      endAt: Date;
    })[]
  >(
    `SELECT id, label, start_at AS startAt, end_at AS endAt
       FROM shift_instances
      WHERE institution_id = ?
        AND hospital_id = ?
        AND sector_id = ?
        AND start_at >= ?
        AND start_at < ?
      FOR UPDATE`,
    [
      input.institutionId,
      input.hospitalId,
      input.sectorId,
      monthStart,
      monthEnd,
    ],
  );

  const byDayLabel = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const dayKey = dayKeyBrt(row.startAt);
    byDayLabel.set(`${dayKey}:${row.label}`, row);
  }

  for (const day of calendar) {
    for (const template of day.templates) {
      const [expectedStart, expectedEnd] = buildShiftTimestamps(
        day.dayKey,
        template.startTime,
        template.endTime,
      );
      const existing = byDayLabel.get(`${day.dayKey}:${template.name}`);
      if (!existing) {
        missing += 1;
        continue;
      }
      const startOk = existing.startAt.getTime() === expectedStart.getTime();
      const endOk = existing.endAt.getTime() === expectedEnd.getTime();
      if (startOk && endOk) {
        alreadyCorrect += 1;
        continue;
      }
      if (input.apply) {
        await connection.execute(
          `UPDATE shift_instances
              SET start_at = ?, end_at = ?
            WHERE id = ?`,
          [expectedStart, expectedEnd, existing.id],
        );
      }
      repaired += 1;
    }
  }

  return { repaired, alreadyCorrect, missing };
}

export async function provisionSalaRecuperacaoSchedule(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const seedMonth = process.argv.includes("--seed-month")
    ? process.env.HSC_SEED_MONTH?.trim()
    : undefined;
  const repairMonth = process.argv.includes("--repair-month")
    ? process.env.HSC_SEED_MONTH?.trim()
    : undefined;

  if (apply && process.env.HSC_PROVISION_CONFIRM !== PROVISION_CONFIRM) {
    throw new Error(`--apply exige HSC_PROVISION_CONFIRM=${PROVISION_CONFIRM}`);
  }
  if (seedMonth && !/^\d{4}-\d{2}$/.test(seedMonth)) {
    throw new Error("HSC_SEED_MONTH deve ser YYYY-MM");
  }
  if (repairMonth && !/^\d{4}-\d{2}$/.test(repairMonth)) {
    throw new Error("HSC_SEED_MONTH deve ser YYYY-MM para --repair-month");
  }
  if (seedMonth && repairMonth) {
    throw new Error("Use --seed-month ou --repair-month, não os dois");
  }

  const target = {
    institutionId: requirePositiveInteger("HSC_INSTITUTION_ID"),
    institutionName: requireNonEmpty("HSC_INSTITUTION_NAME"),
    hospitalId: requirePositiveInteger("HSC_HOSPITAL_ID"),
    hospitalName: requireNonEmpty("HSC_HOSPITAL_NAME"),
  };
  const gestorName =
    process.env.HSC_GESTOR_NAME?.trim() || SALA_RECUPERACAO_GESTOR_MEDICO_NAME;

  const connection = await mysql.createConnection(buildConnectionOptions());
  const lockName = `escala:hsc-sala-recuperacao:${target.institutionId}:${target.hospitalId}`;
  let locked = false;
  try {
    const [lockRows] = await connection.execute<
      (RowDataPacket & { acquired: number | null })[]
    >("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    if (lockRows[0]?.acquired !== 1) {
      throw new Error(
        "Outra configuração da Sala de Recuperação está em andamento",
      );
    }
    locked = true;
    await connection.beginTransaction();
    await assertTarget(connection, target);

    const sector = await findSector(
      connection,
      target.institutionId,
      target.hospitalId,
      SALA_RECUPERACAO_SECTOR_NAME,
    );
    if (!sector) {
      throw new Error(
        `${SALA_RECUPERACAO_SECTOR_NAME} ainda não foi criada — rode provision:sao-carlos primeiro`,
      );
    }

    const templateActions: string[] = [];
    for (const template of SALA_RECUPERACAO_SHIFT_TEMPLATES) {
      const action = await ensureShiftTemplate(connection, {
        institutionId: target.institutionId,
        hospitalId: target.hospitalId,
        sectorId: sector.id,
        template,
        apply,
      });
      templateActions.push(`${template.name}=${action}`);
    }

    const gestorLine = await ensureGestorMedico(connection, {
      institutionId: target.institutionId,
      hospitalId: target.hospitalId,
      sectorId: sector.id,
      gestorName,
      apply,
    });

    let seedLine = "seed=skipped";
    if (seedMonth || repairMonth) {
      const yearMonth = seedMonth ?? repairMonth!;
      const scheduleContextId = await resolveUnifiedSectorContextId(
        connection,
        {
          institutionId: target.institutionId,
          hospitalId: target.hospitalId,
          sectorId: sector.id,
        },
      );
      if (repairMonth) {
        const repair = await repairMonthCalendar(connection, {
          institutionId: target.institutionId,
          hospitalId: target.hospitalId,
          sectorId: sector.id,
          yearMonth,
          apply,
        });
        seedLine = `repair=${yearMonth} repaired=${repair.repaired} ok=${repair.alreadyCorrect} missing=${repair.missing}`;
      } else {
        const seed = await seedMonthCalendar(connection, {
          institutionId: target.institutionId,
          hospitalId: target.hospitalId,
          sectorId: sector.id,
          scheduleContextId,
          yearMonth,
          apply,
        });
        seedLine = `seed=${yearMonth} created=${seed.created} skipped=${seed.skipped}`;
      }
    }

    if (apply) await connection.commit();
    else await connection.rollback();

    console.log(
      apply
        ? "Sala de Recuperação — configuração aplicada:"
        : "Sala de Recuperação — dry-run; nenhuma escrita:",
    );
    console.log(`- templates: ${templateActions.join(", ")}`);
    console.log(`- ${gestorLine}`);
    console.log(`- ${seedLine}`);
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // A falha original é mais informativa.
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
  provisionSalaRecuperacaoSchedule().catch((error) => {
    console.error(
      "Falha ao provisionar Sala de Recuperação:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  });
}
