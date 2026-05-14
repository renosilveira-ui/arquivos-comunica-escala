export type ShiftTemplateOption = {
  id: number;
  hospitalId: number;
  sectorId: number | null;
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

  const selectedSector = sectors.find((sector) => sector.id === selectedSectorId);
  if (!selectedSector) return [];

  return templates
    .filter(
      (template) =>
        template.hospitalId === selectedSector.hospitalId &&
        (template.sectorId === null || template.sectorId === selectedSector.id),
    )
    .sort((a, b) => {
      const aSpecificity = a.sectorId === selectedSector.id ? 0 : 1;
      const bSpecificity = b.sectorId === selectedSector.id ? 0 : 1;
      if (aSpecificity !== bSpecificity) return aSpecificity - bSpecificity;

      const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
      if (priorityDiff !== 0) return priorityDiff;

      return a.name.localeCompare(b.name, "pt-BR");
    });
}
