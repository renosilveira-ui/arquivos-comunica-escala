import { buildKnownSectorServiceSpecialtyPlan } from "./known-sector-service-specialty-plan";
import type { MedicalSpecialtyCode } from "./medical-specialties";

export type UnimedSectorCategory = "internacao" | "cirurgico" | "servico";

export type UnimedSectorBlueprint = Readonly<{
  name: string;
  category: UnimedSectorCategory;
  color: string;
  medicalSpecialtyCodes: readonly MedicalSpecialtyCode[];
}>;

export type UnimedHospitalBlueprint = Readonly<{
  code: "HRU" | "HUS";
  name: string;
  sectors: readonly UnimedSectorBlueprint[];
}>;

type SectorPresentation = Readonly<{
  category: UnimedSectorCategory;
  color: string;
}>;

const HOSPITAL_ORDER: readonly UnimedHospitalBlueprint["code"][] = [
  "HRU",
  "HUS",
];

const SECTOR_PRESENTATION: Readonly<Record<string, SectorPresentation>> = {
  "HRU:Anestesia": { category: "cirurgico", color: "#2563EB" },
  "HRU:Cirurgia Geral": { category: "cirurgico", color: "#7C3AED" },
  "HRU:UTI": { category: "internacao", color: "#DC2626" },
  "HRU:Traumatologia e Ortopedia": {
    category: "cirurgico",
    color: "#D97706",
  },
  "HRU:Emergência": { category: "servico", color: "#059669" },
  "HUS:Pediatria": { category: "internacao", color: "#0EA5E9" },
  "HUS:Anestesia": { category: "cirurgico", color: "#2563EB" },
  "HUS:Ginecologia e Obstetrícia": {
    category: "internacao",
    color: "#DB2777",
  },
};

function key(hospitalCode: string, sectorName: string): string {
  return `${hospitalCode}:${sectorName}`;
}

/**
 * Única fonte do cruzamento clínico confirmado para HRU e HUS. As
 * especialidades vêm do plano descritivo versionado; categoria/cor existem
 * apenas para criar o nó de setor quando ele ainda não existe.
 */
export function buildUnimedHospitalProvisionBlueprint(): readonly UnimedHospitalBlueprint[] {
  const known = buildKnownSectorServiceSpecialtyPlan();
  const knownByCode = new Map(
    known.map((hospital) => [hospital.code, hospital]),
  );

  return HOSPITAL_ORDER.map((hospitalCode) => {
    const hospital = knownByCode.get(hospitalCode);
    if (!hospital) {
      throw new Error(
        `Hospital Unimed ausente do plano clínico: ${hospitalCode}`,
      );
    }
    return {
      code: hospital.code,
      name: hospital.hospitalName,
      sectors: hospital.sectors.map((sector) => {
        const presentation =
          SECTOR_PRESENTATION[key(hospital.code, sector.sectorName)];
        if (!presentation) {
          throw new Error(
            `Apresentação operacional ausente para ${hospital.code}/${sector.sectorName}`,
          );
        }
        return {
          name: sector.sectorName,
          category: presentation.category,
          color: presentation.color,
          medicalSpecialtyCodes: sector.specialties.map(
            (specialty) => specialty.code,
          ),
        };
      }),
    };
  });
}

export const UNIMED_HOSPITAL_PROVISION_BLUEPRINT =
  buildUnimedHospitalProvisionBlueprint();

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase("pt-BR");
}

/**
 * Falha antes de acessar o banco se o mapa clínico/topológico deixar de ser
 * completo. A validação não normaliza nem aceita aliases: os nomes gravados
 * continuam sendo os nomes exatamente confirmados pelo gestor.
 */
export function assertUnimedHospitalProvisionBlueprint(
  blueprint: readonly UnimedHospitalBlueprint[] = UNIMED_HOSPITAL_PROVISION_BLUEPRINT,
): void {
  if (blueprint.length !== 2) {
    throw new Error("O provisionamento Unimed exige exatamente HRU e HUS.");
  }

  const hospitalCodes = new Set<string>();
  const hospitalNames = new Set<string>();
  let relationCount = 0;

  for (const hospital of blueprint) {
    if (!HOSPITAL_ORDER.includes(hospital.code)) {
      throw new Error(`Código de hospital Unimed inválido: ${hospital.code}`);
    }
    if (hospitalCodes.has(hospital.code)) {
      throw new Error(`Código de hospital Unimed duplicado: ${hospital.code}`);
    }
    hospitalCodes.add(hospital.code);

    const hospitalName = normalizedName(hospital.name);
    if (!hospitalName || hospitalNames.has(hospitalName)) {
      throw new Error(
        `Nome de hospital Unimed duplicado/inválido: ${hospital.name}`,
      );
    }
    hospitalNames.add(hospitalName);

    const sectorNames = new Set<string>();
    for (const sector of hospital.sectors) {
      const sectorName = normalizedName(sector.name);
      if (!sectorName || sectorNames.has(sectorName)) {
        throw new Error(
          `Setor duplicado/inválido em ${hospital.name}: ${sector.name}`,
        );
      }
      sectorNames.add(sectorName);

      if (!/^#[0-9A-F]{6}$/.test(sector.color)) {
        throw new Error(
          `Cor de setor inválida em ${hospital.name}/${sector.name}`,
        );
      }
      if (sector.medicalSpecialtyCodes.length === 0) {
        throw new Error(
          `Setor sem especialidade assistencial: ${hospital.name}/${sector.name}`,
        );
      }
      const specialtyCodes = new Set(sector.medicalSpecialtyCodes);
      if (specialtyCodes.size !== sector.medicalSpecialtyCodes.length) {
        throw new Error(
          `Especialidade assistencial duplicada em ${hospital.name}/${sector.name}`,
        );
      }
      relationCount += sector.medicalSpecialtyCodes.length;
    }
  }

  if (
    hospitalCodes.size !== HOSPITAL_ORDER.length ||
    !HOSPITAL_ORDER.every((hospitalCode) => hospitalCodes.has(hospitalCode))
  ) {
    throw new Error("O mapa Unimed precisa conter HRU e HUS uma única vez.");
  }
  if (relationCount !== 8) {
    throw new Error(
      `O mapa Unimed precisa conter oito relações setor-especialidade; encontrou ${relationCount}.`,
    );
  }
}
