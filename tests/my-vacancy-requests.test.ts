import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, like } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  hospitals,
  institutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { appRouter } from "../server/routers";

const FIXTURE_PREFIX = "my-vacancy-requests-test-";

describe("shiftAssignments.listMyVacancyRequests", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let requesterUserId: number;
  let requesterProfessionalId: number;
  let otherUserId: number;
  let otherProfessionalId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    await cleanupFixtures();

    const stamp = Date.now().toString().slice(-10);
    const [institutionResult] = await db.insert(institutions).values({
      name: `${FIXTURE_PREFIX}institution`,
      cnpj: stamp.padStart(14, "0"),
    });
    institutionId = (institutionResult as any).insertId as number;

    const [hospitalResult] = await db.insert(hospitals).values({
      institutionId,
      name: `${FIXTURE_PREFIX}hospital`,
    });
    hospitalId = (hospitalResult as any).insertId as number;

    const [sectorResult] = await db.insert(sectors).values({
      institutionId,
      hospitalId,
      name: `${FIXTURE_PREFIX}sector`,
      category: "cirurgico",
      color: "#2563EB",
    });
    sectorId = (sectorResult as any).insertId as number;

    const [requesterUserResult] = await db.insert(users).values({
      email: `${FIXTURE_PREFIX}requester-${stamp}@test.local`,
      name: `${FIXTURE_PREFIX}requester`,
      role: "doctor",
    });
    requesterUserId = (requesterUserResult as any).insertId as number;

    const [otherUserResult] = await db.insert(users).values({
      email: `${FIXTURE_PREFIX}other-${stamp}@test.local`,
      name: `${FIXTURE_PREFIX}other`,
      role: "doctor",
    });
    otherUserId = (otherUserResult as any).insertId as number;

    const [requesterProfessionalResult] = await db.insert(professionals).values({
      userId: requesterUserId,
      name: `${FIXTURE_PREFIX}requester`,
      role: "Médico",
      userRole: "USER",
    });
    requesterProfessionalId = (requesterProfessionalResult as any).insertId as number;

    const [otherProfessionalResult] = await db.insert(professionals).values({
      userId: otherUserId,
      name: `${FIXTURE_PREFIX}other`,
      role: "Médico",
      userRole: "USER",
    });
    otherProfessionalId = (otherProfessionalResult as any).insertId as number;

    await createRequestFixture({
      label: `${FIXTURE_PREFIX}pendente`,
      requesterUserId,
      professionalId: requesterProfessionalId,
      assignmentStatus: "PENDENTE",
      assignmentIsActive: true,
      shiftStatus: "PENDENTE",
      daysFromNow: 20,
    });

    await createRequestFixture({
      label: `${FIXTURE_PREFIX}aprovada`,
      requesterUserId,
      professionalId: requesterProfessionalId,
      assignmentStatus: "OCUPADO",
      assignmentIsActive: true,
      shiftStatus: "OCUPADO",
      daysFromNow: 21,
    });

    await createRequestFixture({
      label: `${FIXTURE_PREFIX}recusada`,
      requesterUserId,
      professionalId: requesterProfessionalId,
      assignmentStatus: "REJEITADO",
      assignmentIsActive: false,
      shiftStatus: "VAGO",
      daysFromNow: 22,
    });

    await createRequestFixture({
      label: `${FIXTURE_PREFIX}outro-usuario`,
      requesterUserId: otherUserId,
      professionalId: otherProfessionalId,
      assignmentStatus: "PENDENTE",
      assignmentIsActive: true,
      shiftStatus: "PENDENTE",
      daysFromNow: 23,
    });

    await createRequestFixture({
      label: `${FIXTURE_PREFIX}alocacao-direta`,
      requesterUserId: otherUserId,
      professionalId: requesterProfessionalId,
      assignmentStatus: "OCUPADO",
      assignmentIsActive: true,
      shiftStatus: "OCUPADO",
      daysFromNow: 24,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupFixtures();
  });

  async function createRequestFixture(input: {
    label: string;
    requesterUserId: number;
    professionalId: number;
    assignmentStatus: string;
    assignmentIsActive: boolean;
    shiftStatus: string;
    daysFromNow: number;
  }) {
    const startAt = new Date();
    startAt.setDate(startAt.getDate() + input.daysFromNow);
    startAt.setHours(7, 0, 0, 0);
    const endAt = new Date(startAt);
    endAt.setHours(13, 0, 0, 0);

    const [shiftResult] = await db.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      label: input.label,
      startAt,
      endAt,
      status: input.shiftStatus,
      modality: "PLANTAO",
      coverageType: "URGENCIA_EMERGENCIA",
      paymentModel: "FIXO",
      createdBy: input.requesterUserId,
    });
    const shiftInstanceId = (shiftResult as any).insertId as number;

    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: input.professionalId,
      assignmentType: "ON_DUTY",
      status: input.assignmentStatus,
      isActive: input.assignmentIsActive,
      createdBy: input.requesterUserId,
    });
  }

  async function cleanupFixtures(): Promise<void> {
    if (!db) return;

    const shiftRows = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(like(shiftInstances.label, `${FIXTURE_PREFIX}%`));
    if (shiftRows.length > 0) {
      const shiftIds = shiftRows.map((row) => row.id);
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }

    await db.delete(sectors).where(like(sectors.name, `${FIXTURE_PREFIX}%`));
    await db.delete(hospitals).where(like(hospitals.name, `${FIXTURE_PREFIX}%`));
    await db.delete(professionals).where(like(professionals.name, `${FIXTURE_PREFIX}%`));
    await db.delete(users).where(like(users.email, `${FIXTURE_PREFIX}%`));
    await db.delete(institutions).where(like(institutions.name, `${FIXTURE_PREFIX}%`));
  }

  function caller() {
    return appRouter.createCaller({
      user: {
        id: requesterUserId,
        role: "doctor",
        name: `${FIXTURE_PREFIX}requester`,
        email: `${FIXTURE_PREFIX}requester@test.local`,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
  }

  it("lista apenas solicitações de vaga feitas pelo usuário logado", async () => {
    const rows = await caller().shiftAssignments.listMyVacancyRequests();

    const labels = rows.map((row) => row.shiftLabel);
    expect(labels).toContain(`${FIXTURE_PREFIX}pendente`);
    expect(labels).toContain(`${FIXTURE_PREFIX}aprovada`);
    expect(labels).toContain(`${FIXTURE_PREFIX}recusada`);
    expect(labels).not.toContain(`${FIXTURE_PREFIX}outro-usuario`);
    expect(labels).not.toContain(`${FIXTURE_PREFIX}alocacao-direta`);
  });

  it("mantém dados suficientes para a tela explicar o andamento", async () => {
    const rows = await caller().shiftAssignments.listMyVacancyRequests();

    const pending = rows.find((row) => row.shiftLabel === `${FIXTURE_PREFIX}pendente`);
    expect(pending).toMatchObject({
      status: "PENDENTE",
      shiftStatus: "PENDENTE",
      hospitalName: `${FIXTURE_PREFIX}hospital`,
      sectorName: `${FIXTURE_PREFIX}sector`,
      modality: "PLANTAO",
      coverageType: "URGENCIA_EMERGENCIA",
      paymentModel: "FIXO",
    });
    expect(pending?.startAt).toBeInstanceOf(Date);
    expect(pending?.createdAt).toBeInstanceOf(Date);
  });
});
