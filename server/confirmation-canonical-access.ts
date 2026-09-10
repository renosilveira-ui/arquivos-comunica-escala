import { and, eq } from "drizzle-orm";
import { professionalAccess, scheduleContexts } from "../drizzle/schema";
import { plantonistaAccessCoversShiftSql } from "./plantonista-shift-eligibility";
import { accessCoversScheduleContext } from "./schedule-contexts";

export { plantonistaAccessCoversShiftSql as confirmationAccessCoversShiftSql };

type ConfirmationAccessPolicy =
  | "QUALIFICATION_ALLOWLIST"
  | "ALL_CFM_SPECIALTIES"
  | "ALL_CFM_EXCEPT_GENERALIST"
  | "PINNED_QUALIFICATION";

/**
 * Access clínico canônico para confirmação de presença.
 *
 * Espelha `accessCoversScheduleContext` (#317/#422):
 * QUALIFICATION_ALLOWLIST exige sector_id exato; hospital-wide (NULL) só
 * cobre contextos que não são allowlist. Papel, manager_scope, convite e
 * qualification não entram.
 *
 * Plantão sem schedule_context_id usa a política legado (hospital-wide
 * ou setor exato) para não invalidar confirmação já persistida em turno
 * sem escala classificada.
 */
export async function findCanonicalConfirmationAccessId(
  db: {
    select: (...args: never[]) => unknown;
  },
  input: {
    professionalId: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    scheduleContextId: number | null;
    accessId?: number;
    lockForUpdate?: boolean;
  },
): Promise<number | null> {
  const conn = db as {
    select: (arg: Record<string, unknown>) => {
      from: (table: unknown) => {
        where: (condition: unknown) => {
          orderBy: (col: unknown) => {
            limit: (n: number) => Promise<unknown> & {
              for: (kind: string) => Promise<unknown>;
            };
          };
          limit: (n: number) => Promise<unknown> & {
            for: (kind: string) => Promise<unknown>;
          };
        };
      };
    };
  };

  let admissionPolicy: ConfirmationAccessPolicy = "ALL_CFM_SPECIALTIES";
  if (input.scheduleContextId != null) {
    const [context] = (await conn
      .select({
        admissionPolicy: scheduleContexts.admissionPolicy,
      })
      .from(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.id, input.scheduleContextId),
          eq(scheduleContexts.institutionId, input.institutionId),
          eq(scheduleContexts.hospitalId, input.hospitalId),
          eq(scheduleContexts.sectorId, input.sectorId),
          eq(scheduleContexts.active, true),
        ),
      )
      .limit(1)) as { admissionPolicy: ConfirmationAccessPolicy }[];
    if (!context) return null;
    admissionPolicy = context.admissionPolicy;
  }

  const accessQuery = conn
    .select({
      id: professionalAccess.id,
      institutionId: professionalAccess.institutionId,
      professionalId: professionalAccess.professionalId,
      hospitalId: professionalAccess.hospitalId,
      sectorId: professionalAccess.sectorId,
      canAccess: professionalAccess.canAccess,
    })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.professionalId, input.professionalId),
        eq(professionalAccess.institutionId, input.institutionId),
        eq(professionalAccess.hospitalId, input.hospitalId),
        eq(professionalAccess.canAccess, true),
        input.accessId != null
          ? eq(professionalAccess.id, input.accessId)
          : undefined,
      ),
    )
    .orderBy(professionalAccess.id)
    .limit(64);
  const rows = (
    input.lockForUpdate ? await accessQuery.for("update") : await accessQuery
  ) as {
    id: number;
    institutionId: number;
    professionalId: number;
    hospitalId: number;
    sectorId: number | null;
    canAccess: boolean;
  }[];

  const context = {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    sectorId: input.sectorId,
    admissionPolicy,
  };
  const match = rows.find((row) =>
    accessCoversScheduleContext(
      {
        institutionId: row.institutionId,
        professionalId: row.professionalId,
        hospitalId: row.hospitalId,
        sectorId: row.sectorId,
        canAccess: row.canAccess,
      },
      input.professionalId,
      context,
    ),
  );
  return match?.id ?? null;
}
