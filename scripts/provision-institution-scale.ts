/**
 * Garante a escala operacional de um setor em qualquer instituição.
 *
 * Mesmo caminho da Agenda ("Criar escala do setor"): setor + contexto +
 * templates padrão. Não é exclusivo de São Carlos nem exige token HSC.
 *
 * Dry-run:
 *   pnpm provision:institution-scale -- --institution-id 4 --hospital-id 7
 *
 * Aplicar:
 *   pnpm provision:institution-scale -- --institution-id 4 --hospital-id 7 \
 *     --sector-name "Centro Cirúrgico" --apply
 *
 * Resolver por nome (sem id hardcoded):
 *   --institution-name "Cooperativa dos Médicos de Fortaleza - Unimed" \
 *   --hospital-name "Hospital Regional Unimed" --apply
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { hospitals, institutions, sectors } from "../drizzle/schema";
import { getDb } from "../server/db";
import { ensureDefaultSectorScale } from "../server/sector-scale";

type CliArgs = {
  apply: boolean;
  institutionId?: number;
  institutionName?: string;
  hospitalId?: number;
  hospitalName?: string;
  sectorId?: number;
  sectorName?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (!next || next.startsWith("--")) continue;
    if (token === "--institution-id") args.institutionId = Number(next);
    if (token === "--hospital-id") args.hospitalId = Number(next);
    if (token === "--sector-id") args.sectorId = Number(next);
    if (token === "--institution-name") args.institutionName = next;
    if (token === "--hospital-name") args.hospitalName = next;
    if (token === "--sector-name") args.sectorName = next;
    if (
      token === "--institution-id" ||
      token === "--hospital-id" ||
      token === "--sector-id" ||
      token === "--institution-name" ||
      token === "--hospital-name" ||
      token === "--sector-name"
    ) {
      i += 1;
    }
  }
  return args;
}

function requirePositive(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || !value || value <= 0) {
    throw new Error(`${label} deve ser um inteiro positivo`);
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL é obrigatório");

  let institutionId = args.institutionId;
  if (!institutionId && args.institutionName) {
    const [row] = await db
      .select({ id: institutions.id, name: institutions.name })
      .from(institutions)
      .where(eq(institutions.name, args.institutionName))
      .limit(1);
    if (!row) {
      throw new Error(`Instituição não encontrada: ${args.institutionName}`);
    }
    institutionId = row.id;
  }
  institutionId = requirePositive(institutionId, "--institution-id ou --institution-name");

  let hospitalId = args.hospitalId;
  if (!hospitalId && args.hospitalName) {
    const hospitalRows = await db
      .select({ id: hospitals.id, name: hospitals.name })
      .from(hospitals)
      .where(eq(hospitals.institutionId, institutionId));
    const needle = args.hospitalName.trim().toLocaleLowerCase("pt-BR");
    const match = hospitalRows.find(
      (hospital) => hospital.name.trim().toLocaleLowerCase("pt-BR") === needle,
    );
    if (!match) {
      throw new Error(`Hospital não encontrado nesta instituição: ${args.hospitalName}`);
    }
    hospitalId = match.id;
  }
  hospitalId = requirePositive(hospitalId, "--hospital-id ou --hospital-name");

  if (args.hospitalName && args.hospitalId) {
    const [hospital] = await db
      .select({ name: hospitals.name })
      .from(hospitals)
      .where(eq(hospitals.id, hospitalId))
      .limit(1);
    if (!hospital || hospital.name !== args.hospitalName) {
      throw new Error("Hospital informado não confere com o nome");
    }
  }
  if (args.institutionName && args.institutionId) {
    const [institution] = await db
      .select({ name: institutions.name })
      .from(institutions)
      .where(eq(institutions.id, institutionId))
      .limit(1);
    if (!institution || institution.name !== args.institutionName) {
      throw new Error("Instituição informada não confere com o nome");
    }
  }

  if (!args.sectorId && !args.sectorName) {
    const hospitalSectors = await db
      .select({ id: sectors.id, name: sectors.name })
      .from(sectors)
      .where(eq(sectors.hospitalId, hospitalId));
    if (hospitalSectors.length === 1) {
      args.sectorId = hospitalSectors[0].id;
      args.sectorName = hospitalSectors[0].name;
    } else if (hospitalSectors.length === 0) {
      throw new Error("Informe --sector-name para criar o primeiro setor.");
    } else {
      throw new Error(
        `Este hospital tem ${hospitalSectors.length} setores. Informe --sector-id ou --sector-name.`,
      );
    }
  }

  if (!args.apply) {
    console.log("Dry-run — nenhuma escrita. Use --apply para criar a escala.");
    console.log(
      JSON.stringify(
        {
          institutionId,
          hospitalId,
          sectorId: args.sectorId ?? null,
          sectorName: args.sectorName ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await ensureDefaultSectorScale(db, {
    institutionId,
    hospitalId,
    sectorId: args.sectorId,
    sectorName: args.sectorName,
  });
  console.log("Escala do setor pronta:");
  console.log(
    JSON.stringify(
      {
        ...result,
        next: "Na Agenda, escolha este setor e toque em Abrir os turnos do mês.",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("Falha ao provisionar escala da instituição:", (err as Error).message);
  process.exit(1);
});
