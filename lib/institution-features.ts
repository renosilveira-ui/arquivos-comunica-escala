export const INSTITUTION_FEATURE_CODES = {
  crossScheduleRosterView: "CROSS_SCHEDULE_ROSTER_VIEW",
} as const;

export type InstitutionFeatureCode =
  (typeof INSTITUTION_FEATURE_CODES)[keyof typeof INSTITUTION_FEATURE_CODES];

export const ROSTER_READ_POLICIES = {
  authorizedContextsOnly: "AUTHORIZED_CONTEXTS_ONLY",
  institutionWide: "INSTITUTION_WIDE",
} as const;

export type RosterReadPolicy =
  (typeof ROSTER_READ_POLICIES)[keyof typeof ROSTER_READ_POLICIES];
