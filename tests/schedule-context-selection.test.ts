import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agendaScheduleContextId,
  groupScheduleContexts,
  parseStoredScheduleContextId,
  resolveScheduleContextId,
  scheduleContextMutationFields,
  scheduleContextStorageKey,
  type ScheduleContextOption,
} from "@/lib/schedule-context-selection";

const contexts: ScheduleContextOption[] = [
  {
    id: 31,
    hospitalId: 7,
    hospitalName: "Hospital São Carlos",
    sectorId: 71,
    sectorName: "Sala de Recuperação",
    medicalSpecialtyId: 1,
    medicalSpecialtyCode: "ANESTESIOLOGIA",
    medicalSpecialtyName: "Anestesiologia",
    qualificationKind: "SPECIALTY",
    qualificationCode: "ANESTESIOLOGIA",
    qualificationName: "Anestesiologia",
    operationalProfileCode: "ASSISTENCIAL",
    displayName: "Hospital São Carlos — Sala de Recuperação — Anestesiologia",
    canManage: true,
  },
  {
    id: 32,
    hospitalId: 7,
    hospitalName: "Hospital São Carlos",
    sectorId: 72,
    sectorName: "Emergência",
    medicalSpecialtyId: 2,
    medicalSpecialtyCode: "CLINICA_MEDICA",
    medicalSpecialtyName: "Clínica Médica",
    qualificationKind: "SPECIALTY",
    qualificationCode: "CLINICA_MEDICA",
    qualificationName: "Clínica Médica",
    operationalProfileCode: "ASSISTENCIAL",
    displayName: "Hospital São Carlos — Emergência — Clínica Médica",
    canManage: true,
  },
  {
    id: 33,
    hospitalId: 8,
    hospitalName: "Hospital Regional",
    sectorId: 81,
    sectorName: "TRR",
    medicalSpecialtyId: 2,
    medicalSpecialtyCode: "CLINICA_MEDICA",
    medicalSpecialtyName: "Clínica Médica",
    qualificationKind: "SPECIALTY",
    qualificationCode: "CLINICA_MEDICA",
    qualificationName: "Clínica Médica",
    operationalProfileCode: "ASSISTENCIAL",
    displayName: "Hospital Regional — TRR — Clínica Médica",
    canManage: false,
  },
];

describe("seleção de contexto de escala", () => {
  it("isola a preferência persistida por usuário e instituição", () => {
    expect(scheduleContextStorageKey(9, 4)).toBe(
      "escala.schedule-context.v1.9.4",
    );
    expect(scheduleContextStorageKey(10, 4)).not.toBe(
      scheduleContextStorageKey(9, 4),
    );
    expect(scheduleContextStorageKey(9, 5)).not.toBe(
      scheduleContextStorageKey(9, 4),
    );
    expect(scheduleContextStorageKey(9, 4, "roster")).toBe(
      "escala.schedule-context.roster.v1.9.4",
    );
    expect(scheduleContextStorageKey(9, 4, "roster")).not.toBe(
      scheduleContextStorageKey(9, 4),
    );
  });

  it("aplica a regra 0 vazio, 1 automático e vários com último válido", () => {
    expect(resolveScheduleContextId([], 31)).toBeNull();
    expect(resolveScheduleContextId([contexts[0]], null)).toBe(31);
    expect(resolveScheduleContextId(contexts, 32)).toBe(32);
    expect(resolveScheduleContextId(contexts, 999)).toBeNull();
    expect(resolveScheduleContextId(contexts, null)).toBeNull();
  });

  it("rejeita ids persistidos inválidos", () => {
    expect(parseStoredScheduleContextId(null)).toBeNull();
    expect(parseStoredScheduleContextId("0")).toBeNull();
    expect(parseStoredScheduleContextId("3.5")).toBeNull();
    expect(parseStoredScheduleContextId("abc")).toBeNull();
    expect(parseStoredScheduleContextId("32")).toBe(32);
  });

  it("mantém hospital, setor e qualificação em níveis distintos", () => {
    const hierarchy = groupScheduleContexts(contexts);

    expect(hierarchy.map((hospital) => hospital.hospitalName)).toEqual([
      "Hospital Regional",
      "Hospital São Carlos",
    ]);
    const saoCarlos = hierarchy.find((hospital) => hospital.hospitalId === 7);
    expect(saoCarlos?.sectors.map((sector) => sector.sectorName)).toEqual([
      "Emergência",
      "Sala de Recuperação",
    ]);
    expect(saoCarlos?.sectors[1].contexts[0].qualificationName).toBe(
      "Anestesiologia",
    );
  });

  it("Minha agrega todos e Geral envia somente o contexto escolhido", () => {
    expect(agendaScheduleContextId("minha", 31)).toBeUndefined();
    expect(agendaScheduleContextId("geral", null)).toBeUndefined();
    expect(agendaScheduleContextId("geral", 31)).toBe(31);
  });

  it("criação envia contexto canônico e setor legado derivados juntos", () => {
    expect(scheduleContextMutationFields(contexts[0])).toEqual({
      scheduleContextId: 31,
      sectorId: 71,
    });
  });
});

describe("wiring da UI multi-setorial", () => {
  it("mantém o seletor na Agenda e o fluxo hierárquico na criação", () => {
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const createShift = readFileSync("app/create-shift.tsx", "utf8");

    expect(agenda).toContain("<ScheduleContextSelector");
    expect(agenda).toContain('visibility: "roster"');
    expect(agenda).toContain("Todos os setores");
    expect(agenda).toContain("scheduleContextId: selectedAgendaContextId");
    expect(agenda).toContain("Nenhuma escala configurada para você");
    expect(agenda).toContain("scheduleContext.contexts.length === 0");
    expect(agenda).toContain("{ scheduleContextId: selectedAgendaContextId }");
    expect(createShift).toContain('title="Destino da escala"');
    expect(createShift).toContain("1. Hospital");
    expect(createShift).toContain("2. Setor");
    expect(createShift).toContain("3. Qualificação");
    expect(createShift).toContain(
      "...scheduleContextMutationFields(selectedScheduleContext)",
    );
  });
});
