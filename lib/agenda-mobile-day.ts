export type MobileAgendaShift = {
  id: number;
  label: string;
  startAt: Date | string;
  endAt: Date | string;
  status: string;
  professionalNames: string[];
  isMine: boolean;
};

export type MobileAgendaGroup = {
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  scheduleContextId?: number | null;
  qualificationName?: string;
  shifts: MobileAgendaShift[];
};

export type MobileAgendaDay = {
  date: string;
  dow: number;
  groups: MobileAgendaGroup[];
};

export type MobileAgendaWeek = {
  weekStart: string;
  days: MobileAgendaDay[];
};

export function findMobileAgendaDay(
  weeks: readonly MobileAgendaWeek[],
  selectedDayKey: string,
): MobileAgendaDay | null {
  return (
    weeks
      .flatMap((week) => week.days)
      .find((day) => day.date === selectedDayKey) ?? null
  );
}
