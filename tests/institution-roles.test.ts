import { describe, expect, it } from "vitest";
import {
  canManageScheduleInvites,
  profileRoleBadgeLabel,
  SCHEDULE_INVITE_SUBTITLE,
} from "../lib/institution-roles";

describe("profileRoleBadgeLabel", () => {
  it("prioriza admin global sobre papel institucional", () => {
    expect(
      profileRoleBadgeLabel({
        isGlobalAdmin: true,
        roleInInstitution: "USER",
        legacyGlobalRole: "doctor",
      }),
    ).toBe("Administrador");
  });

  it("usa roleInInstitution quando capabilities estão disponíveis", () => {
    expect(
      profileRoleBadgeLabel({
        isGlobalAdmin: false,
        roleInInstitution: "GESTOR_MEDICO",
        legacyGlobalRole: "doctor",
      }),
    ).toBe("Gestor médico");
  });

  it("cai no legado apenas sem capability institucional", () => {
    expect(
      profileRoleBadgeLabel({
        legacyGlobalRole: "nurse",
      }),
    ).toBe("Enfermeiro(a)");
  });
});

describe("canManageScheduleInvites", () => {
  it("libera convites para admin global", () => {
    expect(canManageScheduleInvites({ isGlobalAdmin: true, roleInInstitution: "USER" })).toBe(
      true,
    );
  });

  it("libera convites para gestores institucionais", () => {
    expect(canManageScheduleInvites({ roleInInstitution: "GESTOR_MEDICO" })).toBe(true);
    expect(canManageScheduleInvites({ roleInInstitution: "GESTOR_PLUS" })).toBe(true);
  });

  it("nega convites para usuário comum", () => {
    expect(canManageScheduleInvites({ roleInInstitution: "USER" })).toBe(false);
    expect(canManageScheduleInvites({})).toBe(false);
  });
});

describe("SCHEDULE_INVITE_SUBTITLE", () => {
  it("descreve o fluxo nominal por e-mail", () => {
    expect(SCHEDULE_INVITE_SUBTITLE).toContain("e-mail");
    expect(SCHEDULE_INVITE_SUBTITLE).toContain("24h");
  });
});
