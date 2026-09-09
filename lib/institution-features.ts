export const INSTITUTION_FEATURE_CODES = {
  crossScheduleRosterView: "CROSS_SCHEDULE_ROSTER_VIEW",
} as const;

/**
 * Recursos que fazem parte do produto-base. A tabela institucional registra
 * apenas a materialização/alteração da política; a ausência de uma linha não
 * pode retirar silenciosamente uma funcionalidade de uma instituição nova.
 */
export const INSTITUTION_FEATURE_DEFAULTS = {
  [INSTITUTION_FEATURE_CODES.crossScheduleRosterView]: true,
} as const satisfies Record<InstitutionFeatureCode, boolean>;

export type InstitutionFeatureCode =
  (typeof INSTITUTION_FEATURE_CODES)[keyof typeof INSTITUTION_FEATURE_CODES];

export const ROSTER_READ_POLICIES = {
  authorizedContextsOnly: "AUTHORIZED_CONTEXTS_ONLY",
  institutionWide: "INSTITUTION_WIDE",
} as const;

export type RosterReadPolicy =
  (typeof ROSTER_READ_POLICIES)[keyof typeof ROSTER_READ_POLICIES];
