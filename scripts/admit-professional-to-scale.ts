/**
 * Admite um médico da sala de espera numa escala (instituição + hospital +
 * setor), gravando o mesmo par de linhas que o resgate do convite nominal:
 * professional_institutions + professional_access setorial.
 *
 * Uso (dry-run):
 *   DATABASE_URL='mysql://...' DATABASE_SSL=require \
 *     pnpm exec tsx scripts/admit-professional-to-scale.ts \
 *       --email ananda.arruda@gmail.com \
 *       --hospital "Hospital São Carlos" \
 *       --sector "Sala de Recuperação"
 *
 * Gravar:
 *   ... --apply
 *
 * Sem --apply só mostra o plano. Idempotente: vínculo e acesso já
 * existentes não são duplicados.
 */
import "dotenv/config";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { resolveSslConfig } from "../server/_core/db-ssl";

type Args = {
  email: string;
  hospitalName: string;
  sectorName: string;
  apply: boolean;
};

type UserRow = RowDataPacket & {
  id: number;
  name: string;
  email: string;
  approvalStatus: "PENDING" | "APPROVED";
  deletedAt: Date | null;
};

type ProfessionalRow = RowDataPacket & {
  id: number;
  userId: number;
  name: string;
};

type HospitalRow = RowDataPacket & {
  id: number;
  name: string;
  institutionId: number;
  institutionName: string;
};

type SectorRow = RowDataPacket & {
  id: number;
  name: string;
  institutionId: number;
  hospitalId: number;
};

type MembershipRow = RowDataPacket & {
  id: number;
  active: number | boolean;
  isPrimary: number | boolean;
};

type AccessRow = RowDataPacket & {
  id: number;
  canAccess: number | boolean;
};

function parseArgs(argv: string[]): Args {
  let email: string | undefined;
  let hospitalName: string | undefined;
  let sectorName: string | undefined;
  let apply = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--email") email = argv[++i];
    else if (arg === "--hospital") hospitalName = argv[++i];
    else if (arg === "--sector") sectorName = argv[++i];
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }

  if (!email?.trim()) throw new Error("Informe --email");
  if (!hospitalName?.trim()) throw new Error("Informe --hospital");
  if (!sectorName?.trim()) throw new Error("Informe --sector");

  return {
    email: email.trim().toLowerCase(),
    hospitalName: hospitalName.trim(),
    sectorName: sectorName.trim(),
    apply,
  };
}

function requireDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL é obrigatória");
  return raw;
}

function buildConnectionOptions() {
  const url = new URL(requireDatabaseUrl());
  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL deve usar protocolo mysql://");
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("DATABASE_URL deve informar o banco");
  const ssl = resolveSslConfig(process.env);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    timezone: "Z" as const,
    ...(ssl ? { ssl } : {}),
  };
}

async function one<T extends RowDataPacket>(
  conn: Connection,
  sql: string,
  params: unknown[],
): Promise<T | null> {
  const [rows] = await conn.query<T[]>(sql, params);
  return rows[0] ?? null;
}

export async function admitProfessionalToScale(argv = process.argv): Promise<{
  applied: boolean;
  alreadyInScale: boolean;
  userId: number;
  professionalId: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
}> {
  const args = parseArgs(argv);
  const conn = await mysql.createConnection(buildConnectionOptions());

  try {
    const user = await one<UserRow>(
      conn,
      `SELECT id, name, email, approval_status AS approvalStatus, deleted_at AS deletedAt
       FROM users
       WHERE LOWER(email) = ? AND deleted_at IS NULL
       LIMIT 1`,
      [args.email],
    );
    if (!user) {
      throw new Error(`Usuário não encontrado: ${args.email}`);
    }
    if (user.approvalStatus !== "APPROVED") {
      throw new Error(
        `Usuário #${user.id} não está APPROVED (status=${user.approvalStatus})`,
      );
    }

    const professional = await one<ProfessionalRow>(
      conn,
      `SELECT id, user_id AS userId, name
       FROM professionals
       WHERE user_id = ?
       LIMIT 1`,
      [user.id],
    );
    if (!professional) {
      throw new Error(`Profissional não encontrado para o usuário #${user.id}`);
    }

    const hospital = await one<HospitalRow>(
      conn,
      `SELECT h.id, h.name, h.institution_id AS institutionId, i.name AS institutionName
       FROM hospitals h
       INNER JOIN institutions i
         ON i.id = h.institution_id AND i.is_active = TRUE
       WHERE h.name = ?
       LIMIT 2`,
      [args.hospitalName],
    );
    if (!hospital) {
      throw new Error(`Hospital não encontrado: ${args.hospitalName}`);
    }
    const hospitalCount = await one<RowDataPacket & { n: number }>(
      conn,
      `SELECT COUNT(*) AS n FROM hospitals WHERE name = ?`,
      [args.hospitalName],
    );
    if (Number(hospitalCount?.n ?? 0) !== 1) {
      throw new Error(
        `Hospital "${args.hospitalName}" não é único — recuse o nome ambíguo`,
      );
    }

    const sector = await one<SectorRow>(
      conn,
      `SELECT id, name, institution_id AS institutionId, hospital_id AS hospitalId
       FROM sectors
       WHERE name = ? AND hospital_id = ? AND institution_id = ?
       LIMIT 1`,
      [args.sectorName, hospital.id, hospital.institutionId],
    );
    if (!sector) {
      throw new Error(
        `Setor "${args.sectorName}" não encontrado em ${hospital.name}`,
      );
    }

    const membership = await one<MembershipRow>(
      conn,
      `SELECT id, active, is_primary AS isPrimary
       FROM professional_institutions
       WHERE user_id = ? AND institution_id = ?
       LIMIT 1`,
      [user.id, hospital.institutionId],
    );
    const otherActiveHouse = await one<RowDataPacket & { n: number }>(
      conn,
      `SELECT COUNT(*) AS n
       FROM professional_institutions
       WHERE user_id = ? AND institution_id <> ? AND active = TRUE`,
      [user.id, hospital.institutionId],
    );
    if (Number(otherActiveHouse?.n ?? 0) > 0 && !membership?.active) {
      throw new Error(
        `Usuário #${user.id} já tem vínculo ativo em outra instituição`,
      );
    }

    const access = await one<AccessRow>(
      conn,
      `SELECT id, can_access AS canAccess
       FROM professional_access
       WHERE professional_id = ?
         AND institution_id = ?
         AND hospital_id = ?
         AND sector_id = ?
       LIMIT 1`,
      [professional.id, hospital.institutionId, hospital.id, sector.id],
    );

    const needMembership = !membership || !membership.active;
    const needAccess = !access || !access.canAccess;
    const alreadyInScale = !needMembership && !needAccess;

    const plan = {
      userId: user.id,
      name: user.name,
      email: user.email,
      professionalId: professional.id,
      institutionId: hospital.institutionId,
      institutionName: hospital.institutionName,
      hospitalId: hospital.id,
      hospitalName: hospital.name,
      sectorId: sector.id,
      sectorName: sector.name,
      needMembership,
      needAccess,
      alreadyInScale,
    };
    console.log("[admit-to-scale] plano:");
    console.log(JSON.stringify(plan, null, 2));

    if (alreadyInScale) {
      console.log("[admit-to-scale] já está nesta escala — nada a fazer.");
      return {
        applied: false,
        alreadyInScale: true,
        userId: user.id,
        professionalId: professional.id,
        institutionId: hospital.institutionId,
        hospitalId: hospital.id,
        sectorId: sector.id,
      };
    }

    if (!args.apply) {
      console.log("[admit-to-scale] dry-run: repita com --apply para gravar.");
      return {
        applied: false,
        alreadyInScale: false,
        userId: user.id,
        professionalId: professional.id,
        institutionId: hospital.institutionId,
        hospitalId: hospital.id,
        sectorId: sector.id,
      };
    }

    const actor = await one<
      RowDataPacket & { id: number; name: string; role: string }
    >(
      conn,
      `SELECT u.id, u.name, u.role
       FROM users u
       WHERE u.id = (
         SELECT si.created_by_user_id
         FROM schedule_invites si
         WHERE si.invited_user_id = ?
           AND si.institution_id = ?
           AND si.hospital_id = ?
           AND si.sector_id = ?
         ORDER BY si.id DESC
         LIMIT 1
       )
       LIMIT 1`,
      [user.id, hospital.institutionId, hospital.id, sector.id],
    );
    const actorUserId = actor?.id ?? user.id;
    const actorRole =
      actor?.role === "admin" || actor?.role === "manager"
        ? "GESTOR_PLUS"
        : "USER";

    await conn.beginTransaction();
    try {
      if (!membership) {
        const isPrimary = Number(otherActiveHouse?.n ?? 0) === 0;
        await conn.execute(
          `INSERT INTO professional_institutions
             (professional_id, user_id, institution_id, role_in_institution, is_primary, active)
           VALUES (?, ?, ?, 'USER', ?, TRUE)`,
          [professional.id, user.id, hospital.institutionId, isPrimary],
        );
      } else if (!membership.active) {
        await conn.execute(
          `UPDATE professional_institutions
           SET active = TRUE
           WHERE id = ? AND user_id = ? AND institution_id = ? AND active = FALSE`,
          [membership.id, user.id, hospital.institutionId],
        );
      }

      if (!access) {
        await conn.execute(
          `INSERT INTO professional_access
             (institution_id, professional_id, hospital_id, sector_id, can_access)
           VALUES (?, ?, ?, ?, TRUE)`,
          [hospital.institutionId, professional.id, hospital.id, sector.id],
        );
      } else if (!access.canAccess) {
        await conn.execute(
          `UPDATE professional_access
           SET can_access = TRUE
           WHERE id = ? AND professional_id = ? AND can_access = FALSE`,
          [access.id, professional.id],
        );
      }

      await conn.execute(
        `INSERT INTO audit_trail
           (actor_user_id, actor_role, actor_name, action, entity_type, entity_id,
            description, metadata, institution_id, hospital_id, sector_id)
         VALUES (?, ?, ?, 'USER_UPDATED', 'USER', ?,
                 ?, ?, ?, ?, ?)`,
        [
          actorUserId,
          actorRole,
          "admit-professional-to-scale",
          user.id,
          `Acesso operacional concedido à escala ${hospital.name} / ${sector.name}`,
          JSON.stringify({
            professionalId: professional.id,
            hospitalId: hospital.id,
            sectorId: sector.id,
            source: "admit-professional-to-scale",
          }),
          hospital.institutionId,
          hospital.id,
          sector.id,
        ],
      );

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }

    console.log("[admit-to-scale] gravado com sucesso.");
    return {
      applied: true,
      alreadyInScale: false,
      userId: user.id,
      professionalId: professional.id,
      institutionId: hospital.institutionId,
      hospitalId: hospital.id,
      sectorId: sector.id,
    };
  } finally {
    await conn.end();
  }
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  admitProfessionalToScale().catch((error) => {
    console.error("[admit-to-scale] falhou:", error);
    process.exit(1);
  });
}
