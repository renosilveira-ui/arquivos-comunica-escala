import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TenantActor } from "../server/_core/policy";
import {
  resolveSwapReadViewsFromSnapshot,
  type SwapReadBatchSnapshot,
} from "../server/swap-read-batch";
import type { SwapRow } from "../server/swap-domain";

const routerSource = readFileSync("server/swap-router.ts", "utf8");
const batchSource = readFileSync("server/swap-read-batch.ts", "utf8");

function actor(overrides: Partial<TenantActor> = {}): TenantActor {
  return {
    userId: 900,
    professionalId: 900,
    institutionId: 1,
    roleInInstitution: "GESTOR_MEDICO",
    isGlobalAdmin: false,
    ...overrides,
  };
}

function swap(overrides: Partial<SwapRow> = {}): SwapRow {
  return {
    id: 1,
    institutionId: 1,
    hospitalId: 1,
    sectorId: 10,
    type: "TRANSFER",
    status: "PENDING",
    fromProfessionalId: 101,
    fromUserId: 201,
    fromShiftInstanceId: 1001,
    fromAssignmentId: 5001,
    toProfessionalId: null,
    toUserId: null,
    toShiftInstanceId: null,
    toAssignmentId: null,
    createdAt: new Date("2026-09-10T10:00:00Z"),
    updatedAt: new Date("2026-09-10T10:00:00Z"),
    expiresAt: null,
    version: 1,
    reason: null,
    reviewedAt: null,
    reviewedByUserId: null,
    reviewNote: null,
    ...overrides,
  } as SwapRow;
}

function snapshot(): SwapReadBatchSnapshot {
  const contexts = [
    {
      id: 301,
      institutionId: 1,
      hospitalId: 1,
      sectorId: 10,
      admissionPolicy: "QUALIFICATION_ALLOWLIST",
      allowedQualifications: [],
      active: true,
    },
    {
      id: 302,
      institutionId: 1,
      hospitalId: 2,
      sectorId: 20,
      admissionPolicy: "QUALIFICATION_ALLOWLIST",
      allowedQualifications: [],
      active: true,
    },
  ];
  const shifts = [
    {
      id: 1001,
      institutionId: 1,
      hospitalId: 1,
      sectorId: 10,
      scheduleContextId: 301,
    },
    {
      id: 1002,
      institutionId: 1,
      hospitalId: 2,
      sectorId: 20,
      scheduleContextId: 302,
    },
  ];
  const professionals = [101, 102].map((professionalId, index) => ({
    professionalId,
    userId: 201 + index,
    medicalSpecialtyId: 1,
    operationalProfileCode: null,
    roleInInstitution: "USER",
  }));
  return {
    contexts: new Map(contexts.map((context) => [context.id, context])),
    contextCountsByTopology: new Map([
      ["1:1:10", 1],
      ["1:2:20", 1],
    ]),
    shifts: new Map(shifts.map((shift) => [shift.id, shift])),
    professionals: new Map(
      professionals.map((professional) => [
        professional.professionalId,
        professional,
      ]),
    ),
    accesses: [
      { professionalId: 101, hospitalId: 1, sectorId: 10 },
      { professionalId: 102, hospitalId: 2, sectorId: 20 },
    ],
    scopes: [{ professionalId: 900, hospitalId: 1, sectorId: 10 }],
    invites: [],
    assignments: [
      {
        id: 5001,
        shiftInstanceId: 1001,
        institutionId: 1,
        hospitalId: 1,
        sectorId: 10,
        professionalId: 101,
        isActive: true,
        status: "OCUPADO",
      },
      {
        id: 5002,
        shiftInstanceId: 1002,
        institutionId: 1,
        hospitalId: 2,
        sectorId: 20,
        professionalId: 102,
        isActive: true,
        status: "OCUPADO",
      },
    ],
  } as unknown as SwapReadBatchSnapshot;
}

describe("swaps.list — leitura canônica em lote", () => {
  it("não soma escopo de um hospital ao hospital irmão do mesmo tenant", () => {
    const batch = snapshot();
    const hospitalA = swap();
    const hospitalB = swap({
      id: 2,
      hospitalId: 2,
      sectorId: 20,
      fromProfessionalId: 102,
      fromUserId: 202,
      fromShiftInstanceId: 1002,
      fromAssignmentId: 5002,
    });

    const visible = resolveSwapReadViewsFromSnapshot(batch, actor(), [
      hospitalA,
      hospitalB,
    ]);

    expect(visible.map((entry) => entry.swap.id)).toEqual([hospitalA.id]);
  });

  it("preserva somente o residual mínimo de ACCEPTED para o participante", () => {
    const accepted = swap({ status: "ACCEPTED" });
    const participant = actor({
      userId: accepted.fromUserId,
      professionalId: accepted.fromProfessionalId,
      roleInInstitution: "USER",
    });
    const empty = {
      contexts: new Map(),
      contextCountsByTopology: new Map(),
      shifts: new Map(),
      professionals: new Map(),
      accesses: [],
      scopes: [],
      invites: [],
      assignments: [],
    } as SwapReadBatchSnapshot;

    expect(
      resolveSwapReadViewsFromSnapshot(empty, participant, [accepted]),
    ).toEqual([{ swap: accepted, view: "STALE_ACCEPTED_PARTICIPANT" }]);
    expect(
      resolveSwapReadViewsFromSnapshot(empty, actor(), [accepted]),
    ).toEqual([]);
  });

  it("falha fechado quando a origem tem duas alocações ativas", () => {
    const batch = snapshot();
    batch.assignments.push({
      ...batch.assignments[0]!,
      id: 5999,
    });
    const pending = swap();
    const participant = actor({
      userId: pending.fromUserId,
      professionalId: pending.fromProfessionalId,
      roleInInstitution: "USER",
    });

    expect(() =>
      resolveSwapReadViewsFromSnapshot(batch, participant, [pending]),
    ).toThrow("alocações ativas duplicadas");
  });

  it("valida o ocupante de uma contrapartida aberta fora da própria linha", () => {
    const batch = snapshot();
    batch.accesses.push({
      professionalId: 101,
      hospitalId: 2,
      sectorId: 20,
    });
    const openSwap = swap({ type: "SWAP", toShiftInstanceId: 1002 });
    const participant = actor({
      userId: openSwap.fromUserId,
      professionalId: openSwap.fromProfessionalId,
      roleInInstitution: "USER",
    });

    expect(
      resolveSwapReadViewsFromSnapshot(batch, participant, [openSwap]),
    ).toEqual([{ swap: openSwap, view: "FULL" }]);
  });

  it("exige que o destinatário direcionado também seja dono canônico da contrapartida", () => {
    const batch = snapshot();
    batch.accesses.push(
      { professionalId: 101, hospitalId: 2, sectorId: 20 },
      { professionalId: 102, hospitalId: 1, sectorId: 10 },
    );
    const directedSwap = swap({
      type: "SWAP",
      toProfessionalId: 102,
      toUserId: 202,
      toShiftInstanceId: 1002,
    });
    batch.accesses = batch.accesses.filter(
      (access) =>
        !(
          access.professionalId === 102 &&
          access.hospitalId === 2 &&
          access.sectorId === 20
        ),
    );

    expect(
      resolveSwapReadViewsFromSnapshot(batch, actor(), [directedSwap]),
    ).toEqual([]);

    batch.accesses.push({
      professionalId: 102,
      hospitalId: 2,
      sectorId: 20,
    });
    expect(
      resolveSwapReadViewsFromSnapshot(batch, actor(), [directedSwap]),
    ).toEqual([{ swap: directedSwap, view: "FULL" }]);
  });

  it("aceita manager_scope como admissão sem substituir o acesso clínico", () => {
    const batch = snapshot();
    batch.accesses.push({
      professionalId: 102,
      hospitalId: 1,
      sectorId: null,
    });
    batch.scopes.push({
      professionalId: 102,
      hospitalId: 1,
      sectorId: 10,
    });
    const directedTransfer = swap({
      toProfessionalId: 102,
      toUserId: 202,
    });

    expect(
      resolveSwapReadViewsFromSnapshot(batch, actor(), [directedTransfer]),
    ).toEqual([{ swap: directedTransfer, view: "FULL" }]);

    batch.accesses = batch.accesses.filter(
      (access) => access.professionalId !== 102,
    );
    expect(
      resolveSwapReadViewsFromSnapshot(batch, actor(), [directedTransfer]),
    ).toEqual([]);
  });

  it("preserva admissão por GESTOR_PLUS ou convite nominal com acesso hospitalar", () => {
    const batch = snapshot();
    const directedTransfer = swap({
      toProfessionalId: 102,
      toUserId: 202,
    });
    batch.accesses = batch.accesses.filter(
      (access) => access.professionalId !== 102,
    );
    batch.accesses.push({
      professionalId: 102,
      hospitalId: 1,
      sectorId: null,
    });

    expect(
      resolveSwapReadViewsFromSnapshot(batch, actor(), [directedTransfer]),
    ).toEqual([]);

    batch.professionals.get(102)!.roleInInstitution = "GESTOR_PLUS";
    expect(
      resolveSwapReadViewsFromSnapshot(batch, actor(), [directedTransfer]),
    ).toEqual([{ swap: directedTransfer, view: "FULL" }]);

    batch.professionals.get(102)!.roleInInstitution = "USER";
    batch.invites.push({ userId: 202, hospitalId: 1, sectorId: 10 });
    expect(
      resolveSwapReadViewsFromSnapshot(batch, actor(), [directedTransfer]),
    ).toEqual([{ swap: directedTransfer, view: "FULL" }]);

    batch.accesses = batch.accesses.filter(
      (access) => access.professionalId !== 102,
    );
    expect(
      resolveSwapReadViewsFromSnapshot(batch, actor(), [directedTransfer]),
    ).toEqual([]);
  });

  it("recusa topologia com mais de um contexto ativo no mesmo setor", () => {
    const batch = snapshot();
    batch.contexts.set(303, {
      ...batch.contexts.get(301)!,
      id: 303,
    });
    batch.contextCountsByTopology.set("1:1:10", 2);
    const pending = swap();
    const participant = actor({
      userId: pending.fromUserId,
      professionalId: pending.fromProfessionalId,
      roleInInstitution: "USER",
    });

    expect(() =>
      resolveSwapReadViewsFromSnapshot(batch, participant, [pending]),
    ).toThrow("mais de uma escala operacional ativa");
  });

  it("pagina depois da legibilidade e não executa validador por linha", () => {
    const pageSource = batchSource.slice(
      batchSource.indexOf("export async function listReadableSwapPage"),
      batchSource.indexOf("export async function loadSwapListDisplayRows"),
    );
    const routeSource = routerSource.slice(
      routerSource.indexOf("list: protectedProcedure"),
      routerSource.indexOf("getById: protectedProcedure"),
    );

    expect(pageSource).toContain(
      "const readable = await resolveSwapReadViewsBatch",
    );
    expect(pageSource).toContain("readableToSkip -= 1");
    expect(pageSource).toContain("selected.length === input.limit");
    expect(pageSource).toContain("SWAP_LIST_MAX_CANDIDATES_SCANNED");
    expect(pageSource).toContain('code: "TOO_MANY_REQUESTS"');
    expect(pageSource).toContain("restrinja os filtros");
    expect(pageSource).not.toContain(".offset(");
    expect(batchSource).toContain("await Promise.all([");
    expect(batchSource).toContain("inArray(shiftInstances.id, shiftIds)");
    expect(batchSource).toContain(
      "typedAssignments.map((assignment) => assignment.professionalId)",
    );
    expect(batchSource).not.toContain("await resolveSwapReadView(");
    expect(routeSource).toContain(
      "const readablePage = await listReadableSwapPage",
    );
    expect(routeSource).not.toContain("LIMIT ${input.limit}");
  });
});
