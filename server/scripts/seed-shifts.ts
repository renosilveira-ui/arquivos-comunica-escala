/**
 * Seed shift data for development / testing.
 * Creates shift templates, shift instances for the next 7 days,
 * and allocates test professionals (Ana, Pedro) to some shifts.
 *
 * Usage: DATABASE_URL="..." npx tsx server/scripts/seed-shifts.ts
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, and, inArray } from "drizzle-orm";
import {
  institutions,
  hospitals,
  sectors,
  shiftTemplates,
  shiftInstances,
  shiftAssignmentsV2,
  users,
  professionals,
} from "../../drizzle/schema";

const TEST_PROFESSIONALS = [
  { email: "ana@hospital.com", name: "Dra. Ana", role: "Médico" },
  { email: "pedro@hospital.com", name: "Enf. Pedro", role: "Enfermeiro" },
];

const TEMPLATES = [
  { name: "Manhã", startTime: "07:00:00", endTime: "13:00:00" },
  { name: "Tarde", startTime: "13:00:00", endTime: "19:00:00" },
  { name: "Noite", startTime: "19:00:00", endTime: "07:00:00" },
];

// Returns YYYY-MM-DD strings for today + the next n days
function nextNDays(n: number): string[] {
  const days: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function buildTimestamps(date: string, startTime: string, endTime: string): [Date, Date] {
  const startAt = new Date(`${date}T${startTime}`);
  const endAt = new Date(`${date}T${endTime}`);
  if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1);
  return [startAt, endAt];
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL not set");
    process.exit(1);
  }

  const db = drizzle(databaseUrl);

  // ── 1. Ensure default institution ────────────────────────────────────
  await db
    .insert(institutions)
    .values({ id: 1, name: "Instituto Padrão" })
    .onDuplicateKeyUpdate({ set: { name: "Instituto Padrão" } });
  console.log("✓ Institution 1 ready");

  // ── 2. Ensure default hospital ───────────────────────────────────────
  await db
    .insert(hospitals)
    .values({ id: 1, institutionId: 1, name: "Hospital Central" })
    .onDuplicateKeyUpdate({ set: { name: "Hospital Central" } });
  console.log("✓ Hospital 1 ready");

  // ── 3. Ensure default sector ─────────────────────────────────────────
  await db
    .insert(sectors)
    .values({
      id: 1,
      hospitalId: 1,
      name: "Clínica Médica",
      category: "internacao",
      color: "#3B82F6",
      minStaffCount: 2,
    })
    .onDuplicateKeyUpdate({ set: { name: "Clínica Médica" } });
  console.log("✓ Sector 1 ready");

  // ── 4. Upsert 3 shift templates ──────────────────────────────────────
  const templateIds: number[] = [];
  for (const tmpl of TEMPLATES) {
    // Check if already exists
    const [existing] = await db
      .select()
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.hospitalId, 1),
          eq(shiftTemplates.sectorId, 1),
          eq(shiftTemplates.name, tmpl.name),
        ),
      );
    if (existing) {
      templateIds.push(existing.id);
      console.log(`✓ Template "${tmpl.name}" already exists (id=${existing.id})`);
    } else {
      const [result] = await db.insert(shiftTemplates).values({
        institutionId: 1,
        hospitalId: 1,
        sectorId: 1,
        name: tmpl.name,
        startTime: tmpl.startTime,
        endTime: tmpl.endTime,
        isActive: true,
        priority: TEMPLATES.indexOf(tmpl),
      });
      const newId = (result as any).insertId as number;
      templateIds.push(newId);
      console.log(`✓ Template "${tmpl.name}" created (id=${newId})`);
    }
  }

  // ── 5. Create 10 shift instances spread across next 7 days ──────────
  // Distribution: 2 per day for first 4 days, then 1 on day 5 and 1 on day 6 = 10
  const days = nextNDays(7);
  const STATUSES: Array<"VAGO" | "PENDENTE" | "OCUPADO"> = [
    "VAGO", "VAGO", "VAGO", "VAGO", "VAGO",
    "PENDENTE", "PENDENTE", "PENDENTE",
    "OCUPADO", "OCUPADO",
  ];
  const plan: Array<{ date: string; templateIdx: number }> = [
    { date: days[0], templateIdx: 0 },
    { date: days[0], templateIdx: 1 },
    { date: days[1], templateIdx: 2 },
    { date: days[1], templateIdx: 0 },
    { date: days[2], templateIdx: 1 },
    { date: days[2], templateIdx: 2 },
    { date: days[3], templateIdx: 0 },
    { date: days[3], templateIdx: 1 },
    { date: days[4], templateIdx: 2 },
    { date: days[5], templateIdx: 0 },
  ];

  const shiftInstanceIds: number[] = [];
  for (let i = 0; i < plan.length; i++) {
    const { date, templateIdx } = plan[i];
    const tmpl = TEMPLATES[templateIdx];
    const [startAt, endAt] = buildTimestamps(date, tmpl.startTime, tmpl.endTime);
    const label = tmpl.name;
    const status = STATUSES[i];
    const [result] = await db.insert(shiftInstances).values({
      institutionId: 1,
      hospitalId: 1,
      sectorId: 1,
      label,
      startAt,
      endAt,
      status,
    });
    const newId = (result as any).insertId as number;
    shiftInstanceIds.push(newId);
    console.log(`  → ShiftInstance #${newId} "${label}" ${date} [${status}]`);
  }
  console.log(`✓ Created ${shiftInstanceIds.length} shift instances`);

  // ── 6. Ensure professional records for test users ────────────────────
  const professionalIds: Map<string, number> = new Map();
  for (const tp of TEST_PROFESSIONALS) {
    const [user] = await db.select().from(users).where(eq(users.email, tp.email));
    if (!user) {
      console.warn(`  ⚠ User ${tp.email} not found — run seed-admin + register test users first`);
      continue;
    }

    const [existingPro] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, user.id));

    let proId: number;
    if (existingPro) {
      proId = existingPro.id;
      console.log(`✓ Professional for ${tp.email} already exists (id=${proId})`);
    } else {
      const [result] = await db.insert(professionals).values({
        userId: user.id,
        institutionId: 1,
        name: tp.name,
        role: tp.role,
        userRole: "USER",
      });
      proId = (result as any).insertId as number;
      console.log(`✓ Professional for ${tp.email} created (id=${proId})`);
    }
    professionalIds.set(tp.email, proId);
  }

  // ── 7. Allocate Ana to shifts #0 and #1, Pedro to shifts #2 and #3 ──
  const allocs: Array<{ email: string; shiftIdx: number }> = [
    { email: "ana@hospital.com", shiftIdx: 0 },
    { email: "ana@hospital.com", shiftIdx: 1 },
    { email: "pedro@hospital.com", shiftIdx: 2 },
    { email: "pedro@hospital.com", shiftIdx: 3 },
  ];

  for (const alloc of allocs) {
    const proId = professionalIds.get(alloc.email);
    if (!proId) continue;
    const instanceId = shiftInstanceIds[alloc.shiftIdx];

    // Check if assignment already exists
    const [existing] = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, proId),
          eq(shiftAssignmentsV2.shiftInstanceId, instanceId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );

    if (existing) {
      console.log(`  ✓ Assignment already exists: ${alloc.email} → instance #${instanceId}`);
      continue;
    }

    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: instanceId,
      institutionId: 1,
      hospitalId: 1,
      sectorId: 1,
      professionalId: proId,
      assignmentType: "ON_DUTY",
      status: "PENDENTE",
      isActive: true,
    });
    console.log(`  ✓ Assigned ${alloc.email} → instance #${instanceId}`);
  }

  console.log("\n✅ seed-shifts complete");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
