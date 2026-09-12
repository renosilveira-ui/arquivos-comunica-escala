/**
 * Localização dos hospitais existentes, via código.
 *
 * Enquanto o cadastro de instituição não pede estado e endereço (issue #473),
 * as instituições que já existem recebem coordenada por aqui — e não por
 * UPDATE à mão, para que produção receba exatamente o mesmo dado que o
 * staging, e para que a origem de cada coordenada fique registrada.
 *
 * Cada coordenada abaixo é o ponto que o OpenStreetMap identifica como o
 * PRÓPRIO hospital (POI `amenity=hospital`), conferido pela geocodificação
 * reversa — não o meio de uma rua. Um hospital com mais de uma frente
 * (issue #470) leva a entrada principal como ponto e as demais no texto.
 *
 * Padrão do repositório: somente leitura por padrão; escrita exige `--apply`
 * e a frase de confirmação. Toda linha só é tocada se o nome atual for o
 * esperado — se o dado mudou desde que este arquivo foi escrito, o script
 * recusa em vez de sobrescrever o que não conhece.
 *
 * Dry-run:
 *   DATABASE_URL='mysql://…' DATABASE_SSL=insecure pnpm provision:hospital-locations
 * Aplicar:
 *   … HOSPITAL_LOCATIONS_CONFIRM=FORTALEZA_2026_09 pnpm provision:hospital-locations --apply
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { resolveSslConfig } from "../server/_core/db-ssl";

export const CONFIRM_PHRASE = "FORTALEZA_2026_09";
export const FORTALEZA_TIME_ZONE = "America/Fortaleza";

export type HospitalLocationSpec = Readonly<{
  hospitalId: number;
  /** Nome que a linha precisa ter HOJE para ser tocada. */
  expectedName: string;
  /** Nome depois da provisão. Igual ao esperado quando não há renome. */
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  /** Fonte da coordenada, para auditoria humana. */
  source: string;
}>;

export type InstitutionRenameSpec = Readonly<{
  institutionId: number;
  expectedName: string;
  name: string;
  legalName: string;
  tradeName: string;
}>;

/**
 * Hospital Regional Unimed existe em duas instituições (1 e 2) com o mesmo
 * nome. A linha 1 pertence à instituição que passa a se chamar São Camilo, e
 * o prédio ali é o Cura d'Ars — não a Unimed. Por isso as duas linhas de
 * mesmo nome recebem localizações diferentes, e o nome da 1 muda.
 */
export const HOSPITAL_LOCATIONS: readonly HospitalLocationSpec[] = [
  {
    hospitalId: 1,
    expectedName: "Hospital Regional Unimed",
    name: "Hospital São Camilo - Fortaleza",
    address:
      "Rua Costa Barros, 833 — Centro, Fortaleza - CE, 60160-280 (Hospital Cura d'Ars; o prédio também tem frente para a Rua Nogueira Acioli)",
    latitude: "-3.7283340",
    longitude: "-38.5160312",
    source:
      "OSM amenity=hospital 'Hospital Cura d'Ars', reverso conferido 2026-09-11",
  },
  {
    hospitalId: 2,
    expectedName: "Hospital Regional Unimed",
    name: "Hospital Regional Unimed",
    address:
      "Av. Visconde do Rio Branco, 4000 — São João do Tauape, Fortaleza - CE, 60120-065",
    latitude: "-3.7562976",
    longitude: "-38.5206666",
    source:
      "OSM amenity=hospital 'Hospital Regional Unimed Fortaleza', reverso conferido 2026-09-11",
  },
  {
    hospitalId: 4,
    expectedName: "Hospital São Carlos",
    name: "Hospital São Carlos",
    address:
      "Av. Pontes Vieira, 2531 — Dionísio Torres, Fortaleza - CE, 60170-190 (o mesmo prédio também é acessível pela Rua Araken Silva)",
    latitude: "-3.7507478",
    longitude: "-38.4988790",
    source:
      "OSM amenity=hospital 'Hospital São Carlos', reverso conferido 2026-09-11",
  },
  {
    hospitalId: 5,
    expectedName: "Hospital Unimed Sul",
    name: "Hospital Unimed Sul",
    address:
      "Av. Almirante Maximiano da Fonseca, 44 — Engenheiro Luciano Cavalcante, Fortaleza - CE, 60811-020",
    latitude: "-3.7705869",
    longitude: "-38.4903542",
    source:
      "OSM amenity=hospital 'Hospital Unimed Sul', reverso conferido 2026-09-11",
  },
];

export const INSTITUTION_RENAMES: readonly InstitutionRenameSpec[] = [
  {
    institutionId: 1,
    expectedName: "Hospital das Clínicas",
    name: "Hospital São Camilo - Fortaleza",
    legalName: "Hospital São Camilo - Fortaleza",
    tradeName: "São Camilo Fortaleza",
  },
];

function requireNonEmpty(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} é obrigatório`);
  return value;
}

function buildConnectionOptions() {
  const url = new URL(requireNonEmpty("DATABASE_URL"));
  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL deve usar protocolo mysql://");
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("DATABASE_URL deve informar o banco");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: resolveSslConfig(process.env),
  };
}

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (apply && process.env.HOSPITAL_LOCATIONS_CONFIRM !== CONFIRM_PHRASE) {
    throw new Error(
      `--apply exige HOSPITAL_LOCATIONS_CONFIRM=${CONFIRM_PHRASE}`,
    );
  }
  const actorUserId = Number(
    process.env.HOSPITAL_LOCATIONS_ACTOR_USER_ID ?? "1",
  );
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new Error("HOSPITAL_LOCATIONS_ACTOR_USER_ID inválido");
  }

  const conn = await mysql.createConnection(buildConnectionOptions());
  try {
    const hospitalIds = HOSPITAL_LOCATIONS.map((spec) => spec.hospitalId);
    const [hospitals] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT id, name, latitude, longitude FROM hospitals WHERE id IN (?) ORDER BY id",
      [hospitalIds],
    );
    const byId = new Map<number, Row>(
      hospitals.map((row) => [Number(row.id), row as Row]),
    );

    const plan: string[] = [];
    const refusals: string[] = [];
    for (const spec of HOSPITAL_LOCATIONS) {
      const current = byId.get(spec.hospitalId);
      if (!current) {
        refusals.push(`hospital ${spec.hospitalId}: não existe`);
        continue;
      }
      if (current.name !== spec.expectedName) {
        refusals.push(
          `hospital ${spec.hospitalId}: nome atual "${String(current.name)}" ≠ esperado "${spec.expectedName}"`,
        );
        continue;
      }
      const same =
        current.latitude === spec.latitude &&
        current.longitude === spec.longitude &&
        current.name === spec.name;
      plan.push(
        `${same ? "= " : "→ "}hospital ${spec.hospitalId} "${spec.expectedName}"` +
          (spec.name !== spec.expectedName ? ` → "${spec.name}"` : "") +
          ` @ ${spec.latitude}, ${spec.longitude}${same ? " (já igual)" : ""}`,
      );
    }

    const institutionIds = INSTITUTION_RENAMES.map((s) => s.institutionId);
    const [institutions] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT id, name FROM institutions WHERE id IN (?) ORDER BY id",
      [institutionIds],
    );
    const instById = new Map<number, Row>(
      institutions.map((row) => [Number(row.id), row as Row]),
    );
    for (const spec of INSTITUTION_RENAMES) {
      const current = instById.get(spec.institutionId);
      if (!current) {
        refusals.push(`instituição ${spec.institutionId}: não existe`);
        continue;
      }
      if (current.name === spec.name) {
        plan.push(`= instituição ${spec.institutionId} já é "${spec.name}"`);
        continue;
      }
      if (current.name !== spec.expectedName) {
        refusals.push(
          `instituição ${spec.institutionId}: nome atual "${String(current.name)}" ≠ esperado "${spec.expectedName}"`,
        );
        continue;
      }
      plan.push(
        `→ instituição ${spec.institutionId} "${spec.expectedName}" → "${spec.name}"`,
      );
    }

    console.log(apply ? "APLICANDO:" : "DRY-RUN (nada será gravado):");
    for (const line of plan) console.log("  " + line);
    if (refusals.length) {
      console.log("RECUSADO — dado atual difere do esperado:");
      for (const line of refusals) console.log("  " + line);
      process.exitCode = 2;
      return;
    }
    if (!apply) return;

    await conn.beginTransaction();
    try {
      for (const spec of HOSPITAL_LOCATIONS) {
        const [result] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE hospitals
              SET name = ?, address = ?, latitude = ?, longitude = ?, time_zone = ?,
                  location_updated_at = UTC_TIMESTAMP(), location_updated_by_user_id = ?
            WHERE id = ? AND name = ?`,
          [
            spec.name,
            spec.address,
            spec.latitude,
            spec.longitude,
            FORTALEZA_TIME_ZONE,
            actorUserId,
            spec.hospitalId,
            spec.expectedName,
          ],
        );
        if (result.affectedRows !== 1) {
          throw new Error(
            `hospital ${spec.hospitalId}: esperava 1 linha, afetou ${result.affectedRows}`,
          );
        }
      }
      // `COALESCE(time_zone, ?)` aqui era um no-op silencioso: a coluna é
      // NOT NULL DEFAULT 'America/Sao_Paulo', então nunca esteve nula e o
      // fuso de Fortaleza nunca foi gravado. As três instituições ficaram
      // meses dizendo São Paulo, sendo todas de Fortaleza (12/09/2026).
      for (const spec of INSTITUTION_RENAMES) {
        const [result] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE institutions
              SET name = ?, legal_name = ?, trade_name = ?, time_zone = ?
            WHERE id = ? AND name IN (?, ?)`,
          [
            spec.name,
            spec.legalName,
            spec.tradeName,
            FORTALEZA_TIME_ZONE,
            spec.institutionId,
            spec.expectedName,
            spec.name,
          ],
        );
        if (result.affectedRows !== 1) {
          throw new Error(
            `instituição ${spec.institutionId}: esperava 1 linha, afetou ${result.affectedRows}`,
          );
        }
      }
      await conn.commit();
      console.log("OK — gravado em uma transação.");
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && /provision-hospital-locations/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(
      "Falha:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  });
}
