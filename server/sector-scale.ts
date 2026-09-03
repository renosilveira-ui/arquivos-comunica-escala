/**
 * Operação compartilhada: garantir escala padrão de um setor.
 *
 * Qualquer instituição com hospital pode criar o mesmo conjunto
 * (setor + contexto + templates Manhã/Tarde/Noite). São Carlos e Unimed
 * passam por aqui — não há script exclusivo por hospital.
 */

import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_SECTOR_CATEGORY,
  DEFAULT_SECTOR_COLOR,
  DEFAULT_SECTOR_SHIFT_TEMPLATES,
} from "../lib/default-sector-shift-blueprint";
import {
  hospitals,
  managerScope,
  scheduleContexts,
  sectors,
  shiftTemplates,
} from "../drizzle/schema";
import { getDb } from "./db";
import type { TenantActor } from "./_core/policy";

type ScaleDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ScaleTx = Parameters<Parameters<ScaleDb["transaction"]>[0]>[0];
type ScaleConn = ScaleDb | ScaleTx;

export type EnsureDefaultSectorScaleInput = {
  institutionId: number;
  hospitalId: number;
  sectorId?: number;
  sectorName?: string;
};

export type EnsureDefaultSectorScaleResult = {
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  scheduleContextId: number;
  createdSector: boolean;
  createdContext: boolean;
  createdTemplates: number;
};

export type ManageableSector = {
  id: number;
  name: string;
  hospitalId: number;
  hasSchedule: boolean;
};

export type ManageableHospital = {
  id: number;
  name: string;
  canCreateSector: boolean;
  sectors: ManageableSector[];
};

export type ManageableTopology = {
  hospitals: ManageableHospital[];
  /** Há hospital cadastrado no tenant — distinto de “o ator não tem escopo”. */
  institutionHasHospitals: boolean;
};

export type PlannedDefaultShiftTemplate = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  name: string;
  startTime: string;
  endTime: string;
  priority: number;
};

function normalizeSectorName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

async function requireHospital(
  db: ScaleConn,
  input: { institutionId: number; hospitalId: number },
): Promise<{ id: number; name: string }> {
  const [hospital] = await db
    .select({ id: hospitals.id, name: hospitals.name })
    .from(hospitals)
    .where(
      and(
        eq(hospitals.id, input.hospitalId),
        eq(hospitals.institutionId, input.institutionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!hospital) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Hospital inexistente ou fora da instituição ativa.",
    });
  }
  return hospital;
}

async function findSectorByName(
  db: ScaleConn,
  input: { institutionId: number; hospitalId: number; name: string },
): Promise<{ id: number; name: string } | null> {
  const rows = await db
    .select({ id: sectors.id, name: sectors.name })
    .from(sectors)
    .where(
      and(
        eq(sectors.institutionId, input.institutionId),
        eq(sectors.hospitalId, input.hospitalId),
      ),
    );
  const needle = input.name.toLocaleLowerCase("pt-BR");
  return (
    rows.find((row) => row.name.trim().toLocaleLowerCase("pt-BR") === needle) ??
    null
  );
}

function clockFromExisting(value: string): string {
  const clock = value.length === 5 ? `${value}:00` : value;
  return clock.slice(0, 8);
}

export function planMissingDefaultShiftTemplates(
  existing: readonly {
    hospitalId: number;
    sectorId: number | null;
    name: string;
    startTime: string;
    endTime: string;
    priority: number | null;
  }[],
  input: { institutionId: number; hospitalId: number; sectorId: number },
): PlannedDefaultShiftTemplate[] {
  // Só o que já é do setor conta. pickShiftTemplatesForSector cai no
  // hospital quando o setor está vazio; se inserirmos Tarde/Noite do
  // blueprint, o picker deixa de ver o Manhã hospitalar e a abertura quebra.
  const sectorRows = existing.filter(
    (row) => Number(row.sectorId) === Number(input.sectorId),
  );
  const hospitalByName = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    if (row.sectorId != null) continue;
    if (!hospitalByName.has(row.name)) hospitalByName.set(row.name, row);
  }
  const have = new Set(sectorRows.map((row) => row.name));
  const planned: PlannedDefaultShiftTemplate[] = [];
  for (const template of DEFAULT_SECTOR_SHIFT_TEMPLATES) {
    if (have.has(template.name)) continue;
    const hospital = hospitalByName.get(template.name);
    planned.push({
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      sectorId: input.sectorId,
      name: template.name,
      startTime: hospital
        ? clockFromExisting(hospital.startTime)
        : template.startTime,
      endTime: hospital ? clockFromExisting(hospital.endTime) : template.endTime,
      priority: hospital?.priority ?? template.priority,
    });
    have.add(template.name);
  }
  return planned;
}

export async function ensureDefaultShiftTemplates(
  db: ScaleConn,
  input: { institutionId: number; hospitalId: number; sectorId: number },
): Promise<number> {
  const existing = await db
    .select({
      id: shiftTemplates.id,
      hospitalId: shiftTemplates.hospitalId,
      sectorId: shiftTemplates.sectorId,
      name: shiftTemplates.name,
      startTime: shiftTemplates.startTime,
      endTime: shiftTemplates.endTime,
      priority: shiftTemplates.priority,
    })
    .from(shiftTemplates)
    .where(
      and(
        eq(shiftTemplates.institutionId, input.institutionId),
        eq(shiftTemplates.hospitalId, input.hospitalId),
        eq(shiftTemplates.isActive, true),
      ),
    );
  const missing = planMissingDefaultShiftTemplates(existing, input);
  for (const template of missing) {
    await db.insert(shiftTemplates).values({
      institutionId: template.institutionId,
      hospitalId: template.hospitalId,
      sectorId: template.sectorId,
      name: template.name,
      startTime: template.startTime,
      endTime: template.endTime,
      isActive: true,
      priority: template.priority,
    });
  }
  return missing.length;
}

async function findActiveSectorContextId(
  db: ScaleConn,
  input: { institutionId: number; hospitalId: number; sectorId: number },
): Promise<number | null> {
  const rows = await db
    .select({ id: scheduleContexts.id })
    .from(scheduleContexts)
    .where(
      and(
        eq(scheduleContexts.institutionId, input.institutionId),
        eq(scheduleContexts.hospitalId, input.hospitalId),
        eq(scheduleContexts.sectorId, input.sectorId),
        eq(scheduleContexts.active, true),
      ),
    )
    .orderBy(scheduleContexts.id)
    .limit(2);
  return resolveActiveSectorContextId(rows);
}

export function resolveActiveSectorContextId(
  rows: readonly Readonly<{ id: number }>[],
): number | null {
  if (rows.length > 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Setor com mais de uma escala operacional ativa; regularize a topologia antes de continuar.",
    });
  }
  return rows[0]?.id ?? null;
}

export async function ensureDefaultSectorScale(
  db: ScaleDb,
  input: EnsureDefaultSectorScaleInput,
): Promise<EnsureDefaultSectorScaleResult> {
  return db.transaction(async (tx) => {
    const hospital = await requireHospital(tx, input);
    let createdSector = false;
    let sectorId = input.sectorId;
    let sectorName = input.sectorName
      ? normalizeSectorName(input.sectorName)
      : "";

    if (sectorId) {
      const [sector] = await tx
        .select({ id: sectors.id, name: sectors.name })
        .from(sectors)
        .where(
          and(
            eq(sectors.id, sectorId),
            eq(sectors.institutionId, input.institutionId),
            eq(sectors.hospitalId, input.hospitalId),
          ),
        )
        .limit(1)
        .for("update");
      if (!sector) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Setor inexistente ou fora deste hospital.",
        });
      }
      sectorName = sector.name;
    } else {
      if (sectorName.length < 2) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Informe o nome do setor (pelo menos 2 caracteres).",
        });
      }
      if (sectorName.length > 255) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Nome do setor é longo demais.",
        });
      }
      const existing = await findSectorByName(tx, {
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        name: sectorName,
      });
      if (existing) {
        sectorId = existing.id;
        sectorName = existing.name;
      } else {
        const [inserted] = await tx
          .insert(sectors)
          .values({
            institutionId: input.institutionId,
            hospitalId: input.hospitalId,
            name: sectorName,
            category: DEFAULT_SECTOR_CATEGORY,
            color: DEFAULT_SECTOR_COLOR,
          })
          .$returningId();
        sectorId = inserted.id;
        createdSector = true;
      }
    }

    if (!sectorId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Informe o setor para criar a escala.",
      });
    }

    let createdContext = false;
    let scheduleContextId = await findActiveSectorContextId(tx, {
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      sectorId,
    });
    if (!scheduleContextId) {
      const [inserted] = await tx
        .insert(scheduleContexts)
        .values({
          institutionId: input.institutionId,
          hospitalId: input.hospitalId,
          sectorId,
          admissionPolicy: "ALL_CFM_SPECIALTIES",
          medicalSpecialtyId: null,
          operationalProfileCode: null,
          active: true,
        })
        .$returningId();
      scheduleContextId = inserted.id;
      createdContext = true;
    }

    const createdTemplates = await ensureDefaultShiftTemplates(tx, {
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      sectorId,
    });

    return {
      hospitalId: hospital.id,
      hospitalName: hospital.name,
      sectorId,
      sectorName,
      scheduleContextId,
      createdSector,
      createdContext,
      createdTemplates,
    };
  });
}

async function loadActorHospitalScopes(
  db: ScaleConn,
  actor: TenantActor,
): Promise<{ hospitalId: number; sectorId: number | null }[]> {
  if (!actor.professionalId) return [];
  return db
    .select({
      hospitalId: managerScope.hospitalId,
      sectorId: managerScope.sectorId,
    })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.institutionId, actor.institutionId),
        eq(managerScope.managerProfessionalId, actor.professionalId),
        eq(managerScope.active, true),
      ),
    );
}

export function actorCanManageHospital(
  actor: TenantActor,
  hospitalId: number,
  scopes: readonly { hospitalId: number; sectorId: number | null }[],
): boolean {
  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") {
    return true;
  }
  return scopes.some((scope) => scope.hospitalId === hospitalId);
}

export function actorCanCreateSectorInHospital(
  actor: TenantActor,
  hospitalId: number,
  scopes: readonly { hospitalId: number; sectorId: number | null }[],
): boolean {
  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") {
    return true;
  }
  return scopes.some(
    (scope) => scope.hospitalId === hospitalId && scope.sectorId === null,
  );
}

export function actorCanManageSector(
  actor: TenantActor,
  hospitalId: number,
  sectorId: number,
  scopes: readonly { hospitalId: number; sectorId: number | null }[],
): boolean {
  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") {
    return true;
  }
  return scopes.some(
    (scope) =>
      scope.hospitalId === hospitalId &&
      (scope.sectorId === null || scope.sectorId === sectorId),
  );
}

export async function listManageableTopology(
  db: ScaleConn,
  actor: TenantActor,
): Promise<ManageableTopology> {
  const [hospitalRows, sectorRows, contextRows, scopes] = await Promise.all([
    db
      .select({ id: hospitals.id, name: hospitals.name })
      .from(hospitals)
      .where(eq(hospitals.institutionId, actor.institutionId)),
    db
      .select({
        id: sectors.id,
        name: sectors.name,
        hospitalId: sectors.hospitalId,
      })
      .from(sectors)
      .where(eq(sectors.institutionId, actor.institutionId)),
    db
      .select({
        hospitalId: scheduleContexts.hospitalId,
        sectorId: scheduleContexts.sectorId,
      })
      .from(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.institutionId, actor.institutionId),
          eq(scheduleContexts.active, true),
        ),
      ),
    actor.roleInInstitution === "GESTOR_MEDICO"
      ? loadActorHospitalScopes(db, actor)
      : Promise.resolve([]),
  ]);

  const scheduled = new Set(
    contextRows.map((row) => `${row.hospitalId}:${row.sectorId}`),
  );

  return {
    institutionHasHospitals: hospitalRows.length > 0,
    hospitals: hospitalRows
      .filter((hospital) => actorCanManageHospital(actor, hospital.id, scopes))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((hospital) => ({
        id: hospital.id,
        name: hospital.name,
        canCreateSector: actorCanCreateSectorInHospital(actor, hospital.id, scopes),
        sectors: sectorRows
          .filter(
            (sector) =>
              sector.hospitalId === hospital.id &&
              actorCanManageSector(actor, hospital.id, sector.id, scopes),
          )
          .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
          .map((sector) => ({
            id: sector.id,
            name: sector.name,
            hospitalId: hospital.id,
            hasSchedule: scheduled.has(`${hospital.id}:${sector.id}`),
          })),
      })),
  };
}
