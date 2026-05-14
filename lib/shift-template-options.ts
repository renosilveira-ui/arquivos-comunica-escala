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
