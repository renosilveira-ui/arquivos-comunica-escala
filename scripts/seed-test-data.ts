/**
 * Seed de Dados de Teste para Workflow de Vagas
 *
 * Auto-suficiente: cria instituição, hospital, setor, users e profissionais
 * se ainda não existirem. Idempotente (pode rodar várias vezes).
 */

import { getDb } from "./db";
import {
  institutions,
  hospitals,
  sectors,
  professionals,
  professionalAccess,
  managerScope,
  shiftInstances,
  shiftAssignmentsV2,
  users,
  institutionConfig,
} from "../drizzle/schema";
import { eq } from "drizzle-orm";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Retorna a primeira row ou null */
async function first<T>(promise: Promise<T[]>): Promise<T | undefined> {
  const rows = await promise;
  return rows[0];
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function seedTestData() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  console.log("🌱 Iniciando seed de dados de teste...");

  // ── 0. Limpar dados de teste anteriores ──────────────────────────────────
  const TEST_NAMES = [
    "Dr. João Silva",
    "Dra. Maria Santos",
    "Dr. Pedro Costa",
    "Dra. Ana Lima",
  ];
  const nameList = TEST_NAMES.map((n) => `'${n}'`).join(",");

  await db.execute(`DELETE FROM shift_assignments_v2 WHERE professional_id IN (SELECT id FROM professionals WHERE name IN (${nameList}))`);
  await db.execute("DELETE FROM shift_instances WHERE label LIKE '%VAGO%' OR label LIKE '%OCUPADO%' OR label LIKE '%PENDENTE%' OR label LIKE '%Retroativo%' OR label LIKE '%UTI%'");
  await db.execute(`DELETE FROM professional_access WHERE professional_id IN (SELECT id FROM professionals WHERE name IN (${nameList}))`);
  await db.execute(`DELETE FROM manager_scope WHERE manager_professional_id IN (SELECT id FROM professionals WHERE name IN (${nameList}))`);
  await db.execute(`DELETE FROM professionals WHERE name IN (${nameList})`);

  console.log("✅ Dados de teste anteriores limpos!");

  // ── 1. Garantir instituição ──────────────────────────────────────────────
  let institution = await first(
    db.select().from(institutions).limit(1),
  );
  if (!institution) {
    await db.insert(institutions).values({ name: "Instituição Teste" });
    institution = (await first(db.select().from(institutions).limit(1)))!;
    console.log("✅ Instituição criada:", institution.name);
  }

  // ── 1b. Garantir institution_config ──────────────────────────────────────
  const existingConfig = await first(
    db
      .select()
      .from(institutionConfig)
      .where(eq(institutionConfig.institutionId, institution.id))
      .limit(1),
  );
  if (!existingConfig) {
    await db.insert(institutionConfig).values({
      institutionId: institution.id,
      editWindowDays: 3,
    });
    console.log("✅ institutionConfig criada");
  }

  // ── 2. Garantir hospital ─────────────────────────────────────────────────
  let hospital = await first(
    db
      .select()
      .from(hospitals)
      .where(eq(hospitals.institutionId, institution.id))
      .limit(1),
  );
  if (!hospital) {
    await db.insert(hospitals).values({
      institutionId: institution.id,
      name: "Hospital Teste",
    });
    hospital = (await first(
      db
        .select()
        .from(hospitals)
        .where(eq(hospitals.institutionId, institution.id))
        .limit(1),
    ))!;
    console.log("✅ Hospital criado:", hospital.name);
  }

  // ── 3. Garantir setor "Centro Cirúrgico" ─────────────────────────────────
  let sector = await first(
    db
      .select()
      .from(sectors)
      .where(eq(sectors.hospitalId, hospital.id))
      .limit(1),
  );
  if (!sector) {
    await db.insert(sectors).values({
      hospitalId: hospital.id,
      name: "Centro Cirúrgico",
      category: "cirurgico",
      color: "#FF6B6B",
    });
    sector = (await first(
      db
        .select()
        .from(sectors)
        .where(eq(sectors.hospitalId, hospital.id))
        .limit(1),
    ))!;
    console.log("✅ Setor criado:", sector.name);
  }

  console.log(`✅ Instituição: ${institution.name}`);
  console.log(`✅ Hospital: ${hospital.name}`);
  console.log(`✅ Setor: ${sector.name}`);

  // ── 4. Garantir 4 users ──────────────────────────────────────────────────
  const existingUsers = await db.select().from(users).limit(4);

  const testOpenIds = [
    "test-joao-openid",
    "test-maria-openid",
    "test-pedro-openid",
    "test-ana-openid",
  ];

  if (existingUsers.length < 4) {
    const needed = 4 - existingUsers.length;
    console.log(`👤 Criando ${needed} users de teste...`);
    for (let i = existingUsers.length; i < 4; i++) {
      await db.insert(users).values({
        openId: testOpenIds[i],
        name: TEST_NAMES[i],
        email: `test${i + 1}@test.com`,
      });
    }
  }

  const allUsers = await db.select().from(users).limit(4);
  const [user1, user2, user3, user4] = allUsers;

  console.log(`✅ Users: ${allUsers.map((u) => u.name || u.openId).join(", ")}`);

  // ── 5. Criar profissionais de teste ──────────────────────────────────────
  const profsToCreate = [
    { userId: user1.id, name: TEST_NAMES[0], role: "Médico", userRole: "GESTOR_PLUS" as const },
    { userId: user2.id, name: TEST_NAMES[1], role: "Médico", userRole: "GESTOR_MEDICO" as const },
    { userId: user3.id, name: TEST_NAMES[2], role: "Médico", userRole: "USER" as const },
    { userId: user4.id, name: TEST_NAMES[3], role: "Médico", userRole: "USER" as const },
  ];

  for (const prof of profsToCreate) {
    await db.insert(professionals).values({
      ...prof,
      institutionId: institution.id,
    });
  }

  const testProfessionals = await db
    .select()
    .from(professionals)
    .where(eq(professionals.institutionId, institution.id));

  console.log(`✅ Profissionais: ${testProfessionals.map((p) => p.name).join(", ")}`);

  // ── 6. Conceder acesso a todos os profissionais de teste ─────────────────
  for (const prof of testProfessionals) {
    await db.insert(professionalAccess).values({
      professionalId: prof.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
    });
  }

  // ── 7. Jurisdição da Dra. Maria (GESTOR_MEDICO) sobre Centro Cirúrgico ──
  const maria = testProfessionals.find((p) => p.name === TEST_NAMES[1]);
  if (maria) {
    await db.insert(managerScope).values({
      managerProfessionalId: maria.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
    });
  }

  // ── 8. Criar turnos de teste ─────────────────────────────────────────────
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const fiveDaysAgo = new Date(now);
  fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

  const makeTime = (base: Date, h: number) => {
    const d = new Date(base);
    d.setHours(h, 0, 0, 0);
    return d;
  };

  const pedro = testProfessionals.find((p) => p.name === TEST_NAMES[2]);

  // Shift VAGO (amanhã 7h-13h)
  await db.insert(shiftInstances).values({
    institutionId: institution.id,
    hospitalId: hospital.id,
    sectorId: sector.id,
    label: "Plantão Manhã (VAGO)",
    startAt: makeTime(tomorrow, 7),
    endAt: makeTime(tomorrow, 13),
    status: "VAGO",
  });

  // Shift OCUPADO (hoje 13h-19h)
  await db.insert(shiftInstances).values({
    institutionId: institution.id,
    hospitalId: hospital.id,
    sectorId: sector.id,
    label: "Plantão Tarde (OCUPADO)",
    startAt: makeTime(now, 13),
    endAt: makeTime(now, 19),
    status: "OCUPADO",
  });

  // Shift PENDENTE (amanhã 19h-7h do dia seguinte)
  const dayAfterTomorrow = new Date(tomorrow);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);
  await db.insert(shiftInstances).values({
    institutionId: institution.id,
    hospitalId: hospital.id,
    sectorId: sector.id,
    label: "Plantão Noite (PENDENTE)",
    startAt: makeTime(tomorrow, 19),
    endAt: makeTime(dayAfterTomorrow, 7),
    status: "PENDENTE",
  });

  // Shift RETROATIVO (5 dias atrás 7h-13h)
  await db.insert(shiftInstances).values({
    institutionId: institution.id,
    hospitalId: hospital.id,
    sectorId: sector.id,
    label: "Plantão Retroativo (5 dias atrás)",
    startAt: makeTime(fiveDaysAgo, 7),
    endAt: makeTime(fiveDaysAgo, 13),
    status: "VAGO",
  });

  // Shift UTI (20 profissionais)
  await db.insert(shiftInstances).values({
    institutionId: institution.id,
    hospitalId: hospital.id,
    sectorId: sector.id,
    label: "Plantão UTI (20 profissionais)",
    startAt: makeTime(tomorrow, 7),
    endAt: makeTime(tomorrow, 19),
    status: "OCUPADO",
  });

  console.log("✅ Turnos de teste criados!");

  // ── 9. Criar assignments de teste ────────────────────────────────────────
  // Assignment OCUPADO → Pedro no turno da tarde
  const [shiftOcupado] = await db
    .select()
    .from(shiftInstances)
    .where(eq(shiftInstances.label, "Plantão Tarde (OCUPADO)"))
    .limit(1);

  if (shiftOcupado && pedro) {
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftOcupado.id,
      institutionId: institution.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
      professionalId: pedro.id,
      status: "CONFIRMADO",
      isActive: true,
    });
  }

  // Assignment PENDENTE → Pedro no turno da noite (aguardando aprovação)
  const [shiftPendente] = await db
    .select()
    .from(shiftInstances)
    .where(eq(shiftInstances.label, "Plantão Noite (PENDENTE)"))
    .limit(1);

  if (shiftPendente && pedro) {
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftPendente.id,
      institutionId: institution.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
      professionalId: pedro.id,
      status: "PENDENTE",
      isActive: false,
    });
  }

  console.log("✅ Assignments de teste criados!");
  console.log("✅ Seed de dados de teste finalizado!");
}