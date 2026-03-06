/**
 * Seed script: Create VAGO (vacant) shifts for testing
 * 
 * Creates:
 * - 3 shifts for today (Morning 7-13h, Afternoon 13-19h, Night 19-7h)
 * - All in UTI Térreo sector
 * - Status: VAGO
 * 
 * Usage: tsx scripts/seed-vacancies.ts
 */

import { getDb } from "../server/db";
import { shiftInstances, hospitals, sectors, institutions } from "../drizzle/schema";
import { eq } from "drizzle-orm";

async function seedVacancies() {
  console.log("🌱 Starting seed-vacancies...");

  const db = await getDb();
  if (!db) {
    console.error("❌ Database not available");
    process.exit(1);
  }

  // 1. Get first institution
  const [institution] = await db
    .select()
    .from(institutions)
    .limit(1);

  if (!institution) {
    console.error("❌ Institution not found");
    process.exit(1);
  }

  console.log(`✅ Institution: ${institution.name} (ID: ${institution.id})`);

  // 2. Get hospital
  const [hospital] = await db
    .select()
    .from(hospitals)
    .where(eq(hospitals.institutionId, institution.id))
    .limit(1);

  if (!hospital) {
    console.error("❌ Hospital not found");
    process.exit(1);
  }

  console.log(`✅ Hospital: ${hospital.name} (ID: ${hospital.id})`);

  // 3. Get sector (UTI Térreo)
  const [sector] = await db
    .select()
    .from(sectors)
    .where(eq(sectors.name, "UTI Térreo"))
    .limit(1);

  if (!sector) {
    console.error("❌ Sector 'UTI Térreo' not found");
    process.exit(1);
  }

  console.log(`✅ Sector: ${sector.name} (ID: ${sector.id})`);

  // 4. Create 3 VAGO shifts for today
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const shifts = [
    {
      label: "Manhã",
      startHour: 7,
      endHour: 13,
      description: "Turno manhã (7h-13h)",
    },
    {
      label: "Tarde",
      startHour: 13,
      endHour: 19,
      description: "Turno tarde (13h-19h)",
    },
    {
      label: "Noite",
      startHour: 19,
      endHour: 7, // Next day
      description: "Turno noite (19h-7h)",
    },
  ];

  console.log("\n📅 Creating shifts for today:", today.toISOString().split("T")[0]);

  for (const shift of shifts) {
    const startAt = new Date(today);
    startAt.setHours(shift.startHour, 0, 0, 0);

    const endAt = new Date(today);
    if (shift.endHour < shift.startHour) {
      // Next day (for night shift)
      endAt.setDate(endAt.getDate() + 1);
    }
    endAt.setHours(shift.endHour, 0, 0, 0);

    // Check if shift already exists
    const existing = await db
      .select()
      .from(shiftInstances)
      .where(
        eq(shiftInstances.label, shift.label)
      )
      .limit(1);

    const existingShift = existing[0];

    if (existingShift) {
      console.log(`⏭️  Shift "${shift.label}" already exists (ID: ${existingShift.id})`);
      continue;
    }

    // Create shift
    await db
      .insert(shiftInstances)
      .values({
        institutionId: institution.id,
        hospitalId: hospital.id,
        sectorId: sector.id,
        label: shift.label,
        status: "VAGO",
        startAt,
        endAt,
        createdBy: 30001, // Dra. Maria Santos (GESTOR_MEDICO)
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const [created] = await db
      .select()
      .from(shiftInstances)
      .where(eq(shiftInstances.label, shift.label))
      .limit(1);

    console.log(
      `✅ Created shift "${shift.label}" (ID: ${created.id}) - ${startAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} to ${endAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    );
  }

  console.log("\n🎉 Seed completed successfully!");
  process.exit(0);
}

seedVacancies().catch((error) => {
  console.error("❌ Seed failed:", error);
  process.exit(1);
});
