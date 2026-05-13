import { describe, expect, it } from "vitest";
import {
  assertCanEditScheduleDate,
  type TenantActor,
} from "../server/_core/policy";

const now = new Date("2026-05-13T12:00:00-03:00");

function actor(roleInInstitution: TenantActor["roleInInstitution"], isGlobalAdmin = false): TenantActor {
  return {
    userId: 1,
    institutionId: 2,
    professionalId: 3,
    roleInInstitution,
    isGlobalAdmin,
  };
}

describe("policy - current month schedule editing", () => {
  it("permite gestor medico editar dia anterior dentro do mes corrente", () => {
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2026-05-01T07:00:00-03:00"), now),
    ).not.toThrow();
  });

  it("bloqueia gestor medico em mes anterior", () => {
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2026-04-30T19:00:00-03:00"), now),
    ).toThrow(/mês corrente/i);
  });

  it("bloqueia gestor medico em mes futuro", () => {
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2026-06-01T07:00:00-03:00"), now),
    ).toThrow(/mês corrente/i);
  });

  it("permite gestor plus em qualquer mes", () => {
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_PLUS"), new Date("2026-04-01T07:00:00-03:00"), now),
    ).not.toThrow();
  });

  it("permite admin global em qualquer mes", () => {
    expect(() =>
      assertCanEditScheduleDate(actor("USER", true), new Date("2026-04-01T07:00:00-03:00"), now),
    ).not.toThrow();
  });

  it("mantem usuario comum bloqueado para gestao de escala", () => {
    expect(() =>
      assertCanEditScheduleDate(actor("USER"), new Date("2026-05-13T07:00:00-03:00"), now),
    ).toThrow(/gestores/i);
  });
});
