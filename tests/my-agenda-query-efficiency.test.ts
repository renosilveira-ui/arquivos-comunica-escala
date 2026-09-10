import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { shiftsRouter } from "../server/shifts-crud";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";

const DAY = "2026-09-14";
const START = new Date(`${DAY}T07:00:00-03:00`);
const END = new Date(`${DAY}T13:00:00-03:00`);
const OTHER_SHIFTS = 180;
type Fixture = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number;
};
type Person = { userId: number; professionalId: number };
type CapturedQuery = { sql: string; params: unknown[]; rowCount: number };

describe("Minha agenda filtra ownership no SQL sem mudar o contrato", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let a: Fixture;
  let b: Fixture;
  let reader: Person;
  let emptyReader: Person;
  let peers: Person[];
  let ownIds: number[];
  let foreignOwnId: number;
  const personIds: Person[] = [];
  const stamp = Date.now();

  function caller(person = reader, fixture = a) {
    return shiftsRouter.createCaller({
      user: {
        id: person.userId,
        role: "doctor",
        name: "Efficiency",
        email: "fixture@test.local",
        sessionVersion: 1,
      },
      institutionId: fixture.institutionId,
      tenantProfessionalId: person.professionalId,
      allowedInstitutionIds: [a.institutionId, b.institutionId],
    } as any);
  }

  const flatten = (
    result: Awaited<ReturnType<ReturnType<typeof caller>["listAgenda"]>>,
  ) =>
    result.weeks
      .flatMap((week) =>
        week.days.flatMap((day) => day.groups.flatMap((group) => group.shifts)),
      )
      .sort((left, right) => left.id - right.id);

  // Observa a execução real do query builder; não substitui banco nem rows.
  function captureAgendaQuery(beforeExecute?: () => Promise<void>) {
    const captured: CapturedQuery[] = [];
    const originalSelect = db.select.bind(db);
    const spy = vi.spyOn(db, "select").mockImplementation(((fields?: any) => {
      const builder = originalSelect(fields);
      if (!fields?.actorProfessionalId) return builder;
      const originalFrom = builder.from.bind(builder);
      builder.from = ((table: any) => {
        const query = originalFrom(table);
        const execute = query.execute.bind(query);
        query.execute = async (...args: Parameters<typeof execute>) => {
          const sql = query.toSQL();
          await beforeExecute?.();
          const rows = await execute(...args);
          captured.push({ ...sql, rowCount: rows.length });
          return rows;
        };
        return query;
      }) as typeof builder.from;
      return builder;
    }) as typeof db.select);
    return { captured, restore: () => spy.mockRestore() };
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;
    const specialtyId = await ensureTestAnesthesiaSpecialty(db);
    async function tenant(tag: string): Promise<Fixture> {
      const [institution] = await db
        .insert(institutions)
        .values({
          name: `Efficiency ${tag} ${stamp}`,
          cnpj: `${stamp + (tag === "A" ? 20 : 21)}`.padStart(14, "0"),
          legalName: `Efficiency ${tag}`,
          tradeName: `Efficiency ${tag}`,
          isActive: true,
        })
        .$returningId();
      const [hospital] = await db
        .insert(hospitals)
        .values({ institutionId: institution.id, name: `Hospital ${tag}` })
        .$returningId();
      const [sector] = await db
        .insert(sectors)
        .values({
          institutionId: institution.id,
          hospitalId: hospital.id,
          name: "Centro cirúrgico",
          category: "cirurgico",
          color: "#2563EB",
        })
        .$returningId();
      const scope = {
        institutionId: institution.id,
        hospitalId: hospital.id,
        sectorId: sector.id,
      };
      const scheduleContextId = await openTestScale(db, scope);
      await db.insert(monthlyRosters).values({
        institutionId: institution.id,
        hospitalId: hospital.id,
        yearMonth: "2026-09",
        status: "PUBLISHED",
      });
      return { ...scope, scheduleContextId };
    }
    a = await tenant("A");
    b = await tenant("B");
    async function link(person: Person, fixture: Fixture, primary: boolean) {
      await db.insert(professionalInstitutions).values({
        ...person,
        institutionId: fixture.institutionId,
        roleInInstitution: "USER",
        active: true,
        isPrimary: primary,
      });
      await db.insert(professionalAccess).values({
        institutionId: fixture.institutionId,
        hospitalId: fixture.hospitalId,
        sectorId: fixture.sectorId,
        professionalId: person.professionalId,
        canAccess: true,
      });
    }
    async function person(tag: string, fixture = a): Promise<Person> {
      const [user] = await db
        .insert(users)
        .values({
          name: tag,
          email: `${tag}-${stamp}@test.local`,
          passwordHash: "fixture",
          role: "doctor",
          approvalStatus: "APPROVED",
        })
        .$returningId();
      const [professional] = await db
        .insert(professionals)
        .values({
          userId: user.id,
          name: tag,
          role: "Médico",
          userRole: "USER",
          medicalSpecialtyId: specialtyId,
          specialty: "Anestesiologia",
        })
        .$returningId();
      const result = { userId: user.id, professionalId: professional.id };
      personIds.push(result);
      await link(result, fixture, true);
      return result;
    }
    reader = await person("eff-reader");
    emptyReader = await person("eff-empty");
    peers = await Promise.all([
      person("eff-peer-1"),
      person("eff-peer-2"),
      person("eff-peer-3"),
    ]);
    await link(reader, b, false);
    const foreignPeer = await person("eff-peer-b", b);
    const shifts = await db
      .insert(shiftInstances)
      .values(
        Array.from({ length: OTHER_SHIFTS + 4 }, (_, index) => ({
          ...a,
          label: "Manhã",
          startAt: new Date(START.getTime() + index * 60_000),
          endAt: new Date(END.getTime() + index * 60_000),
          status: "OCUPADO" as const,
          requiredCapacity: 4,
        })),
      )
      .$returningId();
    ownIds = [shifts[OTHER_SHIFTS].id, shifts[OTHER_SHIFTS + 1].id];
    const [foreign] = await db
      .insert(shiftInstances)
      .values({
        ...b,
        label: "Manhã",
        startAt: START,
        endAt: END,
        status: "OCUPADO",
        requiredCapacity: 4,
      })
      .$returningId();
    foreignOwnId = foreign.id;
    const assignment = (id: number, professionalId: number, fixture = a) => ({
      institutionId: fixture.institutionId,
      hospitalId: fixture.hospitalId,
      sectorId: fixture.sectorId,
      shiftInstanceId: id,
      professionalId,
      isActive: true,
      status: "CONFIRMADO",
    });
    await db.insert(shiftAssignmentsV2).values([
      ...shifts
        .slice(0, OTHER_SHIFTS)
        .flatMap((shift) =>
          peers.map((peer) => assignment(shift.id, peer.professionalId)),
        ),
      ...ownIds.flatMap((id) =>
        [reader, ...peers.slice(0, 2)].map((person) =>
          assignment(id, person.professionalId),
        ),
      ),
      // Duas assignments próprias não devem multiplicar os joins dos colegas.
      assignment(ownIds[0], reader.professionalId),
      ...peers.map((peer) =>
        assignment(shifts[OTHER_SHIFTS + 2].id, peer.professionalId),
      ),
      {
        ...assignment(shifts[OTHER_SHIFTS + 2].id, reader.professionalId),
        isActive: false,
      },
      ...peers.map((peer) =>
        assignment(shifts[OTHER_SHIFTS + 3].id, peer.professionalId),
      ),
      // FK individual aceita a contaminação; a subquery exige a tupla inteira.
      assignment(shifts[OTHER_SHIFTS + 3].id, reader.professionalId, b),
      assignment(foreignOwnId, reader.professionalId, b),
      assignment(foreignOwnId, foreignPeer.professionalId, b),
    ]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (!db || !a || !b) return;
    const tenants = [a.institutionId, b.institutionId];
    await db
      .delete(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.institutionId, tenants));
    await db
      .delete(shiftInstances)
      .where(inArray(shiftInstances.institutionId, tenants));
    await db
      .delete(monthlyRosters)
      .where(inArray(monthlyRosters.institutionId, tenants));
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.institutionId, tenants));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.institutionId, tenants));
    await db.delete(professionals).where(
      inArray(
        professionals.id,
        personIds.map((person) => person.professionalId),
      ),
    );
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.institutionId, tenants));
    await db.delete(sectors).where(inArray(sectors.institutionId, tenants));
    await db.delete(hospitals).where(inArray(hospitals.institutionId, tenants));
    await db.delete(institutions).where(inArray(institutions.id, tenants));
    await db.delete(users).where(
      inArray(
        users.id,
        personIds.map((person) => person.userId),
      ),
    );
  });

  it("reduz 553 rows a 7, preserva nomes/contagem e mantém Geral intacto", async () => {
    const trace = captureAgendaQuery();
    try {
      const general = flatten(
        await caller().listAgenda({ startDate: DAY, weeks: 1, scope: "geral" }),
      );
      const mine = flatten(
        await caller().listAgenda({ startDate: DAY, weeks: 1, scope: "minha" }),
      );
      expect(general).toHaveLength(OTHER_SHIFTS + 4);
      expect(mine).toEqual(general.filter((shift) => shift.isMine));
      expect(mine.map((shift) => shift.id)).toEqual(ownIds);
      expect(mine.map((shift) => shift.activeCount)).toEqual([4, 3]);
      expect(mine[0].professionalNames).toEqual([
        "eff-reader",
        "eff-peer-1",
        "eff-peer-2",
        "eff-reader",
      ]);
      expect(trace.captured.map((query) => query.rowCount)).toEqual([553, 7]);
      expect(trace.captured[0].sql).not.toContain("agenda_own_assignments");
      const sql = trace.captured[1].sql;
      const shiftJoin = sql.slice(
        sql.indexOf("left join `shift_instances`"),
        sql.indexOf("left join `schedule_contexts`"),
      );
      expect(shiftJoin).toContain("exists (select 1");
      expect(shiftJoin).toContain(
        "`agenda_own_assignments`.`professional_id` = `professional_institutions`.`professional_id`",
      );
      for (const column of ["institution_id", "hospital_id", "sector_id"]) {
        expect(shiftJoin).toContain(
          `\`agenda_own_assignments\`.\`${column}\` = \`shift_instances\`.\`${column}\``,
        );
      }
      expect(shiftJoin).toContain("`agenda_own_assignments`.`is_active` = ?");
      // EXPLAIN é leitura no mesmo MySQL de testes; o índice já existe no schema.
      const [explained] = await db.$client
        .promise()
        .query(`EXPLAIN FORMAT=JSON ${sql}`, trace.captured[1].params);
      const plan = JSON.parse(
        (explained as unknown as { EXPLAIN: string }[])[0].EXPLAIN,
      );
      const ownershipAccess: { access_type: string; key?: string }[] = [];
      function inspectPlan(node: unknown) {
        if (!node || typeof node !== "object") return;
        const entry = node as Record<string, unknown>;
        if (entry.table_name === "agenda_own_assignments") {
          ownershipAccess.push({
            access_type: String(entry.access_type),
            key: entry.key as string | undefined,
          });
        }
        Object.values(entry).forEach(inspectPlan);
      }
      inspectPlan(plan);
      expect(ownershipAccess).toHaveLength(1);
      console.info("[my-agenda-query]", {
        generalRows: 553,
        mineRows: 7,
        ownShifts: 2,
        ownershipAccess,
      });
    } finally {
      trace.restore();
    }
  });

  it("zero próprias conserva uma sentinela e não vira vínculo revogado", async () => {
    const trace = captureAgendaQuery();
    try {
      expect(
        flatten(
          await caller(emptyReader).listAgenda({
            startDate: DAY,
            weeks: 1,
            scope: "minha",
          }),
        ),
      ).toEqual([]);
      expect(trace.captured.map((query) => query.rowCount)).toEqual([1]);
    } finally {
      trace.restore();
    }
    // Revoga entre o preflight canônico e a query final, não antes do actor.
    const revokedTrace = captureAgendaQuery(async () => {
      await db
        .update(professionalInstitutions)
        .set({ active: false })
        .where(
          and(
            eq(
              professionalInstitutions.professionalId,
              emptyReader.professionalId,
            ),
            eq(professionalInstitutions.institutionId, a.institutionId),
          ),
        );
    });
    try {
      await expect(
        caller(emptyReader).listAgenda({
          startDate: DAY,
          weeks: 1,
          scope: "minha",
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Usuário sem vínculo ativo para a instituição",
      });
      expect(revokedTrace.captured.map((query) => query.rowCount)).toEqual([0]);
    } finally {
      revokedTrace.restore();
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(
              professionalInstitutions.professionalId,
              emptyReader.professionalId,
            ),
            eq(professionalInstitutions.institutionId, a.institutionId),
          ),
        );
    }
  });

  it("mesma conta em outro tenant retorna só o plantão daquele tenant", async () => {
    const mine = flatten(
      await caller(reader, b).listAgenda({
        startDate: DAY,
        weeks: 1,
        scope: "minha",
      }),
    );
    expect(mine.map((shift) => shift.id)).toEqual([foreignOwnId]);
    expect(mine[0].professionalNames).toEqual(["eff-reader", "eff-peer-b"]);
  });

  it.each(["DRAFT", "LOCKED"] as const)(
    "a otimização preserva a cerca %s",
    async (status) => {
      await db
        .update(monthlyRosters)
        .set({ status })
        .where(eq(monthlyRosters.institutionId, a.institutionId));
      try {
        const mine = flatten(
          await caller().listAgenda({
            startDate: DAY,
            weeks: 1,
            scope: "minha",
          }),
        );
        expect(mine.map((shift) => shift.id)).toEqual(
          status === "DRAFT" ? [] : ownIds,
        );
      } finally {
        await db
          .update(monthlyRosters)
          .set({ status: "PUBLISHED" })
          .where(eq(monthlyRosters.institutionId, a.institutionId));
      }
    },
  );
});
