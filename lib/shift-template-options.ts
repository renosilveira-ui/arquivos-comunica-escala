export type ShiftTemplateOption = {
  id: number;
  hospitalId: number;
  sectorId?: number | null;
  name: string;
  startTime: string;
  endTime: string;
  priority?: number | null;
};

export type SectorOption = {
  id: number;
  hospitalId: number;
};

function toTimeLabel(value: string): string {
  return value.slice(0, 5);
}

export function formatShiftTemplateTimeRange(template: ShiftTemplateOption): string {
  return `${toTimeLabel(template.startTime)} - ${toTimeLabel(template.endTime)}`;
}

function sortTemplatesByPriority(
  templates: ShiftTemplateOption[],
): ShiftTemplateOption[] {
  return [...templates].sort((a, b) => {
    const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return a.name.localeCompare(b.name, "pt-BR");
  });
}

/**
 * Modelos do setor, se existirem; senão, os gerais do hospital.
 * Usado para abrir o primeiro mês sem escala anterior.
 */
export function pickShiftTemplatesForSector(
  templates: ShiftTemplateOption[] | undefined,
  hospitalId: number,
  sectorId: number,
): ShiftTemplateOption[] {
  if (!templates?.length) return [];
  const hospital = Number(hospitalId);
  const sector = Number(sectorId);
  const sectorTemplates = templates.filter(
    (template) =>
      Number(template.hospitalId) === hospital &&
      Number(template.sectorId) === sector,
  );
  if (sectorTemplates.length > 0) return sortTemplatesByPriority(sectorTemplates);
  return sortTemplatesByPriority(
    templates.filter(
      (template) =>
        Number(template.hospitalId) === hospital && template.sectorId == null,
    ),
  );
}

export function getShiftTemplatesForSector(
  templates: ShiftTemplateOption[] | undefined,
  sectors: SectorOption[] | undefined,
  selectedSectorId: number | undefined,
): ShiftTemplateOption[] {
  if (!templates?.length || !sectors?.length || !selectedSectorId) return [];

  const selectedSectorIdNumber = Number(selectedSectorId);
  const selectedSector = sectors.find((sector) => Number(sector.id) === selectedSectorIdNumber);
  if (!selectedSector) return [];

  const selectedHospitalId = Number(selectedSector.hospitalId);

  return templates
    .filter(
      (template) =>
        Number(template.hospitalId) === selectedHospitalId &&
        (template.sectorId == null || Number(template.sectorId) === selectedSectorIdNumber),
    )
    .sort((a, b) => {
      const aSpecificity = Number(a.sectorId) === selectedSectorIdNumber ? 0 : 1;
      const bSpecificity = Number(b.sectorId) === selectedSectorIdNumber ? 0 : 1;
      if (aSpecificity !== bSpecificity) return aSpecificity - bSpecificity;

      const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
      if (priorityDiff !== 0) return priorityDiff;

      return a.name.localeCompare(b.name, "pt-BR");
    });
}
