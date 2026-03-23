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
  professionalInstitutions,
  professionalAccess,
  managerScope,
  shiftInstances,
  shiftAssignmentsV2,
  shiftAuditLog,
  users,
  institutionConfig,
} from "../drizzle/schema";
import { and, eq, inArray } from "drizzle-orm";

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

  // Limpar dummy UTI assignments + professionals + users
  await db.execute("DELETE FROM shift_assignments_v2 WHERE professional_id IN (SELECT id FROM professionals WHERE name LIKE 'UTI Dummy%')");
  await db.execute("DELETE FROM professional_access WHERE professional_id IN (SELECT id FROM professionals WHERE name LIKE 'UTI Dummy%')");
  await db.execute("DELETE FROM professionals WHERE name LIKE 'UTI Dummy%'");
  await db.execute("DELETE FROM users WHERE openId LIKE 'uti-dummy-%'");

  // Limpar assignments vinculados a shifts de teste antes de remover shift_instances
  await db.execute(`
    DELETE sa FROM shift_assignments_v2 sa
    INNER JOIN shift_instances si ON si.id = sa.shift_instance_id
    WHERE si.label LIKE '%VAGO%'
       OR si.label LIKE '%OCUPADO%'
       OR si.label LIKE '%PENDENTE%'
       OR si.label LIKE '%Retroativo%'
       OR si.label LIKE '%UTI%'
       OR si.label LIKE '%Conflito%'
       OR si.label LIKE 'E2E Test%'
  `);
  await db.execute(`
    DELETE al FROM shift_audit_log al
    INNER JOIN shift_instances si ON si.id = al.shift_instance_id
    WHERE si.label LIKE '%VAGO%'
       OR si.label LIKE '%OCUPADO%'
       OR si.label LIKE '%PENDENTE%'
       OR si.label LIKE '%Retroativo%'
       OR si.label LIKE '%UTI%'
       OR si.label LIKE '%Conflito%'
       OR si.label LIKE 'E2E Test%'
  `);
  await db.delete(shiftAuditLog).where(eq(shiftAuditLog.event, "VACANCY_REQUESTED"));
  await db.delete(shiftAuditLog).where(eq(shiftAuditLog.event, "ASSIGNMENT_APPROVED"));
  await db.delete(shiftAuditLog).where(eq(shiftAuditLog.event, "ASSIGNMENT_REJECTED"));
  await db.execute(`DELETE FROM shift_assignments_v2 WHERE professional_id IN (SELECT id FROM professionals WHERE name IN (${nameList}))`);
  await db.execute("DELETE FROM shift_instances WHERE label LIKE '%VAGO%' OR label LIKE '%OCUPADO%' OR label LIKE '%PENDENTE%' OR label LIKE '%Retroativo%' OR label LIKE '%UTI%' OR label LIKE '%Conflito%' OR label LIKE 'E2E Test%'");
  await db.execute(`DELETE FROM professional_access WHERE professional_id IN (SELECT id FROM professionals WHERE name IN (${nameList}))`);
  await db.execute(`DELETE FROM manager_scope WHERE manager_professional_id IN (SELECT id FROM professionals WHERE name IN (${nameList}))`);
  await db.execute(`DELETE FROM professionals WHERE name IN (${nameList})`);

  console.log("✅ Dados de teste anteriores limpos!");

  // ── 1. Garantir instituição ──────────────────────────────────────────────
  let institution = await first(
    db.select().from(institutions).limit(1),
  );
  if (!institution) {
    await db.insert(institutions).values({
      name: "Hospital das Clínicas",
      cnpj: "11111111000191",
      legalName: "Hospital das Clínicas S.A.",
      tradeName: "HC",
      isActive: true,
    });
    institution = (await first(
      db.select().from(institutions).where(eq(institutions.cnpj, "11111111000191")).limit(1),
    ))!;
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
      institutionId: institution.id,
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

  // ── 3b. Garantir setor "UTI" (fora da jurisdição da Maria) ──────────────
  // Limpar dependências antes de recriar o setor para evitar erro de FK.
  await db.execute(`
    DELETE sa FROM shift_assignments_v2 sa
    INNER JOIN shift_instances si ON si.id = sa.shift_instance_id
    INNER JOIN sectors s ON s.id = si.sector_id
    WHERE s.hospital_id = ${hospital.id} AND s.name = 'UTI'
  `);
  await db.execute(`
    DELETE si FROM shift_instances si
    INNER JOIN sectors s ON s.id = si.sector_id
    WHERE s.hospital_id = ${hospital.id} AND s.name = 'UTI'
  `);
  await db.execute(`
    DELETE ms FROM manager_scope ms
    INNER JOIN sectors s ON s.id = ms.sector_id
    WHERE s.hospital_id = ${hospital.id} AND s.name = 'UTI'
  `);
  await db.execute(`
    DELETE pa FROM professional_access pa
    INNER JOIN sectors s ON s.id = pa.sector_id
    WHERE s.hospital_id = ${hospital.id} AND s.name = 'UTI'
  `);
  await db.execute(`DELETE FROM sectors WHERE hospital_id = ${hospital.id} AND name = 'UTI'`);
  await db.insert(sectors).values({
    institutionId: institution.id,
    hospitalId: hospital.id,
    name: "UTI",
    category: "internacao",
    color: "#4ECDC4",
  });
  const sectorUti = (await first(
    db
      .select()
      .from(sectors)
      .where(eq(sectors.name, "UTI"))
      .limit(1),
  ))!;
  console.log(`✅ Setor UTI criado: ${sectorUti.name}`);

  console.log(`✅ Instituição: ${institution.name}`);
  console.log(`✅ Hospital: ${hospital.name}`);
  console.log(`✅ Setor: ${sector.name}`);

  // ── 4. Garantir 4 users ──────────────────────────────────────────────────
  const testOpenIds = [
    "test-joao-openid",
    "test-maria-openid",
    "test-pedro-openid",
    "test-ana-openid",
  ];
  for (let i = 0; i < 4; i++) {
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.openId, testOpenIds[i]))
      .limit(1);
    if (!existingUser) {
      await db.insert(users).values({
        openId: testOpenIds[i],
        name: TEST_NAMES[i],
        email: `test${i + 1}@test.com`,
        loginMethod: "openid",
        role: "doctor",
      });
    }
  }

  const userByOpenId: Record<string, typeof users.$inferSelect> = {};
  for (const openId of testOpenIds) {
    const [resolved] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    if (!resolved) {
      throw new Error(`Falha ao resolver usuário de teste: ${openId}`);
    }
    userByOpenId[openId] = resolved;
  }

  const allUsers = testOpenIds.map((openId) => userByOpenId[openId]);
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
    const [existingProfessional] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, prof.userId))
      .limit(1);

    let professionalId = existingProfessional?.id;
    if (!professionalId) {
      const [proResult] = await db.insert(professionals).values(prof);
      professionalId = (proResult as any).insertId as number;
    }

    const [existingLink] = await db
      .select({ id: professionalInstitutions.id })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.professionalId, professionalId),
          eq(professionalInstitutions.institutionId, institution.id),
        ),
      )
      .limit(1);

    if (!existingLink) {
      await db.insert(professionalInstitutions).values({
        professionalId,
        userId: prof.userId,
        institutionId: institution.id,
        roleInInstitution: prof.userRole,
        isPrimary: true,
        active: true,
      });
    }
  }

  const testProfessionals = await db
    .select()
    .from(professionals)
    .where(inArray(professionals.userId, allUsers.map((u) => u.id)));

  console.log(`✅ Profissionais: ${testProfessionals.map((p) => p.name).join(", ")}`);

  // ── 6. Conceder acesso a todos os profissionais de teste ─────────────────
  for (const prof of testProfessionals) {
    await db.insert(professionalAccess).values({
      institutionId: institution.id,
      professionalId: prof.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
    });
    // Also give access to UTI sector (for validateAssignment limit tests)
    await db.insert(professionalAccess).values({
      institutionId: institution.id,
      professionalId: prof.id,
      hospitalId: hospital.id,
      sectorId: sectorUti.id,
    });
  }

  // ── 7. Jurisdição da Dra. Maria (GESTOR_MEDICO) sobre Centro Cirúrgico ──
  const maria = testProfessionals.find((p) => p.name === TEST_NAMES[1]);
  if (maria) {
    await db.insert(managerScope).values({
      institutionId: institution.id,
      managerProfessionalId: maria.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
    });
  }

  // ── 8. Criar turnos de teste ─────────────────────────────────────────────
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
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

  // Shift UTI (20 profissionais) — em setor UTI, fora da jurisdição da Maria
  await db.insert(shiftInstances).values({
    institutionId: institution.id,
    hospitalId: hospital.id,
    sectorId: sectorUti.id,
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

  // ── 10. Criar 20 dummy professionals + assignments para o turno UTI ────
  const [shiftUti] = await db
    .select()
    .from(shiftInstances)
    .where(eq(shiftInstances.label, "Plantão UTI (20 profissionais)"))
    .limit(1);

  if (shiftUti) {
    for (let i = 1; i <= 20; i++) {
      const openId = `uti-dummy-${i}`;
      // Ensure user exists
      const existing = await first(
        db.select().from(users).where(eq(users.openId, openId)).limit(1),
      );
      let userId: number;
      if (existing) {
        userId = existing.id;
      } else {
        await db.insert(users).values({ openId, name: `UTI Dummy ${i}` });
        userId = (await first(
          db.select().from(users).where(eq(users.openId, openId)).limit(1),
        ))!.id;
      }

      const [existingDummyProf] = await db
        .select()
        .from(professionals)
        .where(eq(professionals.userId, userId))
        .limit(1);

      let dummyProfId = existingDummyProf?.id;
      if (!dummyProfId) {
        const [dummyProResult] = await db.insert(professionals).values({
          userId,
          name: `UTI Dummy ${i}`,
          role: "Médico",
          userRole: "USER",
        });
        dummyProfId = (dummyProResult as any).insertId as number;
      }

      const [existingDummyLink] = await db
        .select({ id: professionalInstitutions.id })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.professionalId, dummyProfId),
            eq(professionalInstitutions.institutionId, institution.id),
          ),
        )
        .limit(1);

      if (!existingDummyLink) {
        await db.insert(professionalInstitutions).values({
          professionalId: dummyProfId,
          userId,
          institutionId: institution.id,
          roleInInstitution: "USER",
          isPrimary: false,
          active: true,
        });
      }

      await db.insert(professionalAccess).values({
        institutionId: institution.id,
        professionalId: dummyProfId,
        hospitalId: hospital.id,
        sectorId: sectorUti.id,
      });

      await db.insert(shiftAssignmentsV2).values({
        shiftInstanceId: shiftUti.id,
        institutionId: institution.id,
        hospitalId: hospital.id,
        sectorId: sectorUti.id,
        professionalId: dummyProfId,
        status: "CONFIRMADO",
        isActive: true,
      });
    }
    console.log("✅ 20 UTI dummy assignments criados!");
  }

  console.log("✅ Assignments de teste criados!");
  console.log("✅ Seed de dados de teste finalizado!");
}
