import { describe, expect, it } from "vitest";
import {
  assertCanCreateHospital,
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

describe("policy - janela de edição de escala do gestor", () => {
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

  it("permite gestor medico no proximo mes", () => {
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2026-06-01T07:00:00-03:00"), now),
    ).not.toThrow();
  });

  it("permite gestor medico ate o quarto mes seguinte", () => {
    // Janela de 5 meses a partir de maio: maio a setembro.
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2026-07-01T07:00:00-03:00"), now),
    ).not.toThrow();
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2026-09-30T19:00:00-03:00"), now),
    ).not.toThrow();
  });

  it("o horizonte de 4 meses da repeticao cabe na janela do gestor", () => {
    // Repetir por 4 meses a partir de uma data de maio cai em setembro. Se
    // esta expectativa quebrar, a opcao "4 meses" da tela vira recusa para
    // o gestor de hospital — que e exatamente o que ela nao pode ser.
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2026-09-13T12:00:00-03:00"), now),
    ).not.toThrow();
  });

  it("bloqueia gestor medico no quinto mes seguinte", () => {
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2026-10-01T07:00:00-03:00"), now),
    ).toThrow(/mês corrente e dos 4 seguintes/i);
  });

  it("a janela atravessa a virada do ano", () => {
    const dezembro = new Date("2026-12-15T12:00:00-03:00");
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2027-04-01T07:00:00-03:00"), dezembro),
    ).not.toThrow();
    expect(() =>
      assertCanEditScheduleDate(actor("GESTOR_MEDICO"), new Date("2027-05-01T07:00:00-03:00"), dezembro),
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

describe("policy - cadastrar hospital", () => {
  it("permite Gestor+ e admin; recusa gestor de setor e plantonista", () => {
    expect(() => assertCanCreateHospital(actor("GESTOR_PLUS"))).not.toThrow();
    expect(() => assertCanCreateHospital(actor("USER", true))).not.toThrow();
    expect(() => assertCanCreateHospital(actor("GESTOR_MEDICO"))).toThrow(
      /Gestor\+|administrador/i,
    );
    expect(() => assertCanCreateHospital(actor("USER"))).toThrow(/gestores/i);
  });
});
