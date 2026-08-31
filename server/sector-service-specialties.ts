import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  medicalSpecialties,
  sectorServiceSpecialties,
} from "../drizzle/schema";
import { assertInstitutionHierarchy } from "./_core/tenant";
import { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type ReadDb = Pick<Db, "select">;
type WriteDb = Pick<Db, "select" | "insert" | "delete">;

export type SectorServiceSpecialtyDescriptor = {
  medicalSpecialtyId: number;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
};

export type SectorServiceSpecialtyChange = {
  specialties: SectorServiceSpecialtyDescriptor[];
  addedCodes: string[];
  removedCodes: string[];
  changed: boolean;
};

type SectorTopology = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
};

export function sectorServiceSpecialtyTopologyKey(
  input: SectorTopology,
): string {
  return `${input.institutionId}:${input.hospitalId}:${input.sectorId}`;
}

function invalidServiceSpecialtyInput(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message });
}

/**
 * Códigos são apenas identificadores de catálogo. Esta normalização não os
 * converte em regra de admissão nem consulta schedule_contexts.
 */
export function normalizeSectorServiceSpecialtyCodes(
  values: readonly string[],
): string[] {
  if (values.length > 55) {
    throw invalidServiceSpecialtyInput(
      "Informe no máximo 55 especialidades assistenciais por setor.",
    );
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string") {
      throw invalidServiceSpecialtyInput(
        "Cada especialidade assistencial deve ser um código válido.",
      );
    }
    const code = value.trim();
    if (!code || code.length > 64 || !/^[A-Z0-9_]+$/.test(code)) {
      throw invalidServiceSpecialtyInput(
        "Código de especialidade assistencial inválido.",
      );
    }
    return code;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw invalidServiceSpecialtyInput(
      "A mesma especialidade assistencial não pode ser informada duas vezes.",
    );
  }
  return normalized.sort((left, right) => left.localeCompare(right, "pt-BR"));
}

async function resolveActiveServiceSpecialties(
  db: ReadDb,
  codes: readonly string[],
): Promise<SectorServiceSpecialtyDescriptor[]> {
  if (codes.length === 0) return [];
  const rows = await db
    .select({
      medicalSpecialtyId: medicalSpecialties.id,
      code: medicalSpecialties.code,
      name: medicalSpecialties.name,
      sortOrder: medicalSpecialties.sortOrder,
      active: medicalSpecialties.active,
    })
    .from(medicalSpecialties)
    .where(
      and(
        inArray(medicalSpecialties.code, [...codes]),
        eq(medicalSpecialties.active, true),
      ),
    )
    .orderBy(asc(medicalSpecialties.sortOrder), asc(medicalSpecialties.code))
    .for("share");
  const found = new Set(rows.map((row) => row.code));
  const missing = codes.filter((code) => !found.has(code));
  if (missing.length > 0) {
    throw invalidServiceSpecialtyInput(
      "Especialidade assistencial inexistente ou inativa no catálogo.",
    );
  }
  return rows;
}

export async function listSectorServiceSpecialties(
  db: ReadDb,
  input: SectorTopology,
): Promise<SectorServiceSpecialtyDescriptor[]> {
  return db
    .select({
      medicalSpecialtyId: medicalSpecialties.id,
      code: medicalSpecialties.code,
      name: medicalSpecialties.name,
      sortOrder: medicalSpecialties.sortOrder,
      active: medicalSpecialties.active,
    })
    .from(sectorServiceSpecialties)
    .innerJoin(
      medicalSpecialties,
      eq(medicalSpecialties.id, sectorServiceSpecialties.medicalSpecialtyId),
    )
    .where(
      and(
        eq(sectorServiceSpecialties.institutionId, input.institutionId),
        eq(sectorServiceSpecialties.hospitalId, input.hospitalId),
        eq(sectorServiceSpecialties.sectorId, input.sectorId),
      ),
    )
    .orderBy(asc(medicalSpecialties.sortOrder), asc(medicalSpecialties.code));
}

/**
 * Carrega descritores sem multiplicar as linhas de schedule_contexts. O mapa
 * é usado somente na projeção de leitura; não deve alimentar
 * qualificationMatches ou qualquer decisão de autorização.
 */
export async function loadSectorServiceSpecialtiesByTopology(
  db: ReadDb,
  topologies: readonly SectorTopology[],
): Promise<Map<string, SectorServiceSpecialtyDescriptor[]>> {
  if (topologies.length === 0) return new Map();
  const institutionId = topologies[0]!.institutionId;
  if (topologies.some((topology) => topology.institutionId !== institutionId)) {
    throw new TypeError(
      "As especialidades assistenciais devem ser lidas dentro de uma única instituição.",
    );
  }
  const sectorIds = [...new Set(topologies.map((item) => item.sectorId))];
  const expected = new Set(topologies.map(sectorServiceSpecialtyTopologyKey));
  const rows = await db
    .select({
      institutionId: sectorServiceSpecialties.institutionId,
      hospitalId: sectorServiceSpecialties.hospitalId,
      sectorId: sectorServiceSpecialties.sectorId,
      medicalSpecialtyId: medicalSpecialties.id,
      code: medicalSpecialties.code,
      name: medicalSpecialties.name,
      sortOrder: medicalSpecialties.sortOrder,
      active: medicalSpecialties.active,
    })
    .from(sectorServiceSpecialties)
    .innerJoin(
      medicalSpecialties,
      eq(medicalSpecialties.id, sectorServiceSpecialties.medicalSpecialtyId),
    )
    .where(
      and(
        eq(sectorServiceSpecialties.institutionId, institutionId),
        inArray(sectorServiceSpecialties.sectorId, sectorIds),
      ),
    )
    .orderBy(
      asc(sectorServiceSpecialties.hospitalId),
      asc(sectorServiceSpecialties.sectorId),
      asc(medicalSpecialties.sortOrder),
      asc(medicalSpecialties.code),
    );

  const result = new Map<string, SectorServiceSpecialtyDescriptor[]>();
  for (const row of rows) {
    const key = sectorServiceSpecialtyTopologyKey(row);
    if (!expected.has(key)) continue;
    const specialties = result.get(key) ?? [];
    specialties.push({
      medicalSpecialtyId: row.medicalSpecialtyId,
      code: row.code,
      name: row.name,
      sortOrder: row.sortOrder,
      active: row.active,
    });
    result.set(key, specialties);
  }
  return result;
}

/**
 * Substitui somente os descritores do setor informado. A topologia é
 * revalidada sob lock; a função não lê nem escreve schedule_contexts,
 * professional_access ou a qualificação profissional.
 */
export async function replaceSectorServiceSpecialties(
  db: WriteDb,
  input: SectorTopology & { medicalSpecialtyCodes: readonly string[] },
): Promise<SectorServiceSpecialtyChange> {
  await assertInstitutionHierarchy(input, { db, lockForShare: true });
  const requestedCodes = normalizeSectorServiceSpecialtyCodes(
    input.medicalSpecialtyCodes,
  );
  const requested = await resolveActiveServiceSpecialties(db, requestedCodes);
  const current = await db
    .select({
      medicalSpecialtyId: sectorServiceSpecialties.medicalSpecialtyId,
      code: medicalSpecialties.code,
    })
    .from(sectorServiceSpecialties)
    .innerJoin(
      medicalSpecialties,
      eq(medicalSpecialties.id, sectorServiceSpecialties.medicalSpecialtyId),
    )
    .where(
      and(
        eq(sectorServiceSpecialties.institutionId, input.institutionId),
        eq(sectorServiceSpecialties.hospitalId, input.hospitalId),
        eq(sectorServiceSpecialties.sectorId, input.sectorId),
      ),
    )
    .for("update");

  const requestedByCode = new Map(
    requested.map((specialty) => [specialty.code, specialty] as const),
  );
  const currentByCode = new Map(
    current.map((specialty) => [specialty.code, specialty] as const),
  );
  const added = requested.filter(
    (specialty) => !currentByCode.has(specialty.code),
  );
  const removed = current.filter(
    (specialty) => !requestedByCode.has(specialty.code),
  );

  if (removed.length > 0) {
    await db.delete(sectorServiceSpecialties).where(
      and(
        eq(sectorServiceSpecialties.institutionId, input.institutionId),
        eq(sectorServiceSpecialties.hospitalId, input.hospitalId),
        eq(sectorServiceSpecialties.sectorId, input.sectorId),
        inArray(
          sectorServiceSpecialties.medicalSpecialtyId,
          removed.map((specialty) => specialty.medicalSpecialtyId),
        ),
      ),
    );
  }
  if (added.length > 0) {
    await db.insert(sectorServiceSpecialties).values(
      added.map((specialty) => ({
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        medicalSpecialtyId: specialty.medicalSpecialtyId,
      })),
    );
  }

  return {
    specialties: await listSectorServiceSpecialties(db, input),
    addedCodes: added.map((specialty) => specialty.code),
    removedCodes: removed.map((specialty) => specialty.code),
    changed: added.length > 0 || removed.length > 0,
  };
}
