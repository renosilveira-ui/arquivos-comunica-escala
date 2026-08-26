export type ScheduleContextOption = Readonly<{
  id: number;
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  medicalSpecialtyId: number | null;
  medicalSpecialtyCode: string | null;
  medicalSpecialtyName: string | null;
  qualificationKind: "SPECIALTY" | "OPERATIONAL_PROFILE" | "SECTOR_POLICY";
  qualificationCode: string;
  qualificationName: string;
  operationalProfileCode: string | null;
  displayName: string;
  canManage: boolean;
}>;

export type ScheduleContextSectorGroup = Readonly<{
  sectorId: number;
  sectorName: string;
  contexts: readonly ScheduleContextOption[];
}>;

export type ScheduleContextHospitalGroup = Readonly<{
  hospitalId: number;
  hospitalName: string;
  sectors: readonly ScheduleContextSectorGroup[];
}>;

const STORAGE_PREFIX = "escala.schedule-context.v1";

export function scheduleContextStorageKey(
  userId: number,
  institutionId: number,
): string {
  return `${STORAGE_PREFIX}.${userId}.${institutionId}`;
}

export function parseStoredScheduleContextId(
  raw: string | null,
): number | null {
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Revalida a preferência persistida contra os contextos que o servidor
 * autorizou para a sessão/tenant atuais.
 *
 * - nenhum contexto: não há escala selecionável;
 * - um contexto: seleção automática, sem passo desnecessário;
 * - vários: restaura somente um id ainda autorizado; caso contrário a UI
 *   permanece em "Todos os meus setores" até a pessoa escolher.
 */
export function resolveScheduleContextId(
  contexts: readonly Pick<ScheduleContextOption, "id">[],
  persistedContextId: number | null,
): number | null {
  if (contexts.length === 0) return null;
  if (contexts.length === 1) return contexts[0].id;
  return persistedContextId !== null &&
    contexts.some((context) => context.id === persistedContextId)
    ? persistedContextId
    : null;
}

export function groupScheduleContexts(
  contexts: readonly ScheduleContextOption[],
): ScheduleContextHospitalGroup[] {
  const hospitals = new Map<
    number,
    {
      hospitalId: number;
      hospitalName: string;
      sectors: Map<
        number,
        {
          sectorId: number;
          sectorName: string;
          contexts: ScheduleContextOption[];
        }
      >;
    }
  >();

  for (const context of contexts) {
    let hospital = hospitals.get(context.hospitalId);
    if (!hospital) {
      hospital = {
        hospitalId: context.hospitalId,
        hospitalName: context.hospitalName,
        sectors: new Map(),
      };
      hospitals.set(context.hospitalId, hospital);
    }

    let sector = hospital.sectors.get(context.sectorId);
    if (!sector) {
      sector = {
        sectorId: context.sectorId,
        sectorName: context.sectorName,
        contexts: [],
      };
      hospital.sectors.set(context.sectorId, sector);
    }

    if (!sector.contexts.some((candidate) => candidate.id === context.id)) {
      sector.contexts.push(context);
    }
  }

  return [...hospitals.values()]
    .sort((a, b) => a.hospitalName.localeCompare(b.hospitalName, "pt-BR"))
    .map((hospital) => ({
      hospitalId: hospital.hospitalId,
      hospitalName: hospital.hospitalName,
      sectors: [...hospital.sectors.values()]
        .sort((a, b) => a.sectorName.localeCompare(b.sectorName, "pt-BR"))
        .map((sector) => ({
          sectorId: sector.sectorId,
          sectorName: sector.sectorName,
          contexts: [...sector.contexts].sort((a, b) =>
            a.qualificationName.localeCompare(b.qualificationName, "pt-BR"),
          ),
        })),
    }));
}

export function agendaScheduleContextId(
  scope: "geral" | "minha",
  selectedContextId: number | null,
): number | undefined {
  return scope === "geral" && selectedContextId !== null
    ? selectedContextId
    : undefined;
}

export function scheduleContextMutationFields(
  context: Pick<ScheduleContextOption, "id" | "sectorId">,
): { scheduleContextId: number; sectorId: number } {
  return {
    scheduleContextId: context.id,
    // Compatibilidade temporária com clientes/servidores anteriores. O
    // servidor novo revalida que o setor pertence ao contexto selecionado.
    sectorId: context.sectorId,
  };
}
