import {
  getMedicalSpecialtyByCode,
  type MedicalSpecialtyCode,
} from "./medical-specialties";

type KnownSectorServiceSpecialtyInput = {
  sectorName: string;
  medicalSpecialtyCodes: readonly MedicalSpecialtyCode[];
};

type KnownHospitalServiceSpecialtyInput = {
  code: "HUS" | "HRU";
  hospitalName: string;
  sectors: readonly KnownSectorServiceSpecialtyInput[];
};

export type KnownSectorServiceSpecialtyPlan = {
  code: "HUS" | "HRU";
  hospitalName: string;
  sectors: {
    sectorName: string;
    specialties: {
      code: MedicalSpecialtyCode;
      name: string;
    }[];
  }[];
};

/**
 * Plano clínico confirmado para a Unimed. Ele não identifica IDs de banco nem
 * tenta resolver nomes livres de hospitais/setores: a aplicação efetiva
 * continuará exigindo seleção explícita da topologia pelo gestor autorizado.
 */
const KNOWN_UNIMED_SERVICE_SPECIALTIES: readonly KnownHospitalServiceSpecialtyInput[] =
  [
    {
      code: "HUS",
      hospitalName: "Hospital Unimed Sul",
      sectors: [
        { sectorName: "Pediatria", medicalSpecialtyCodes: ["PEDIATRIA"] },
        {
          sectorName: "Anestesia",
          medicalSpecialtyCodes: ["ANESTESIOLOGIA"],
        },
        {
          sectorName: "Ginecologia e Obstetrícia",
          medicalSpecialtyCodes: ["GINECOLOGIA_E_OBSTETRICIA"],
        },
      ],
    },
    {
      code: "HRU",
      hospitalName: "Hospital Regional Unimed",
      sectors: [
        {
          sectorName: "Anestesia",
          medicalSpecialtyCodes: ["ANESTESIOLOGIA"],
        },
        {
          sectorName: "Cirurgia Geral",
          medicalSpecialtyCodes: ["CIRURGIA_GERAL"],
        },
        {
          sectorName: "UTI",
          medicalSpecialtyCodes: ["MEDICINA_INTENSIVA"],
        },
        {
          sectorName: "Traumatologia e Ortopedia",
          medicalSpecialtyCodes: ["ORTOPEDIA_E_TRAUMATOLOGIA"],
        },
        {
          sectorName: "Emergência",
          medicalSpecialtyCodes: ["MEDICINA_DE_EMERGENCIA"],
        },
      ],
    },
  ];

/**
 * Resolve apenas o catálogo TypeScript versionado. Falha cedo se um código
 * conhecido deixar de existir, para que nenhum plano dependa de rótulo livre.
 */
export function buildKnownSectorServiceSpecialtyPlan(): KnownSectorServiceSpecialtyPlan[] {
  return KNOWN_UNIMED_SERVICE_SPECIALTIES.map((hospital) => ({
    code: hospital.code,
    hospitalName: hospital.hospitalName,
    sectors: hospital.sectors.map((sector) => ({
      sectorName: sector.sectorName,
      specialties: sector.medicalSpecialtyCodes.map((code) => {
        const specialty = getMedicalSpecialtyByCode(code);
        if (!specialty) {
          throw new Error(
            `Especialidade canônica ausente do catálogo: ${code}`,
          );
        }
        return { code: specialty.code, name: specialty.name };
      }),
    })),
  }));
}
