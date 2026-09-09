type InvalidateHandle = {
  invalidate: () => Promise<unknown>;
};

/**
 * Mutations that change occupancy or vacancy existence must refresh Agenda
 * (official scale) and Vacancies from the same generation. One side without
 * the other lets the two tabs disagree until background resume.
 */
export type OfficialScaleVacancyQueryUtils = {
  shifts: { listAgenda: InvalidateHandle };
  shiftInstances: { listVacancies: InvalidateHandle };
  filters: {
    actionableVacancyCounts: InvalidateHandle;
    summaryCounts: InvalidateHandle;
  };
};

export function officialScaleAndVacancyQueryInvalidations(
  utils: OfficialScaleVacancyQueryUtils,
): Promise<unknown>[] {
  return [
    utils.shifts.listAgenda.invalidate(),
    utils.shiftInstances.listVacancies.invalidate(),
    utils.filters.actionableVacancyCounts.invalidate(),
    utils.filters.summaryCounts.invalidate(),
  ];
}

export async function invalidateOfficialScaleAndVacancyQueries(
  utils: OfficialScaleVacancyQueryUtils,
): Promise<void> {
  await Promise.all(officialScaleAndVacancyQueryInvalidations(utils));
}
