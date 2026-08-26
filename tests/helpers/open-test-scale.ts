import { and, eq } from "drizzle-orm";
import {
  medicalSpecialties,
  scheduleContexts,
} from "../../drizzle/schema";
import { getDb } from "../../server/db";

type ScaleDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function ensureTestAnesthesiaSpecialty(
  db: ScaleDb,
): Promise<number> {
  await db.insert(medicalSpecialties).values({
    code: "ANESTESIOLOGIA",
    name: "Anestesiologia",
    sourceVersion: "CFM_2380_2024",
    active: true,
    sortOrder: 3,
  }).onDuplicateKeyUpdate({ set: { active: true } });
  const [row] = await db
    .select({ id: medicalSpecialties.id })
    .from(medicalSpecialties)
    .where(eq(medicalSpecialties.code, "ANESTESIOLOGIA"));
  return row.id;
}

/** Abre uma escala de teste aceitando qualquer especialidade CFM. */
export async function openTestScale(
  db: ScaleDb,
  input: { institutionId: number; hospitalId: number; sectorId: number },
): Promise<number> {
  const [existing] = await db
    .select({ id: scheduleContexts.id })
    .from(scheduleContexts)
    .where(
      and(
        eq(scheduleContexts.institutionId, input.institutionId),
        eq(scheduleContexts.hospitalId, input.hospitalId),
        eq(scheduleContexts.sectorId, input.sectorId),
      ),
    );
  if (existing) return existing.id;
  const [row] = await db
    .insert(scheduleContexts)
    .values({
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      sectorId: input.sectorId,
      admissionPolicy: "ALL_CFM_SPECIALTIES",
      medicalSpecialtyId: null,
      operationalProfileCode: null,
      active: true,
    })
    .$returningId();
  return row.id;
}
