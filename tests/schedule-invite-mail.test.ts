import { describe, expect, it } from "vitest";
import { buildScheduleInviteMail } from "../server/schedule-invite-mail";

describe("e-mail de convite nominal", () => {
  it("monta link na origem pública e não inclui dado clínico", () => {
    const mail = buildScheduleInviteMail({
      to: "medico@test.local",
      hospitalName: "Hospital São Carlos",
      sectorName: "Sala de Recuperação",
      code: "ABCD-2345",
      expiresAt: new Date("2026-08-27T21:00:00-03:00"),
    });
    expect(mail).toMatchObject({
      to: "medico@test.local",
      subject: "Convite para a escala Hospital São Carlos — Sala de Recuperação",
    });
    expect(mail?.text).toContain("/join-schedule?invite=ABCD-2345");
    expect(mail?.text).toContain("24 horas");
    expect(mail?.text).not.toMatch(/paciente|leito|diagn[oó]stico|procedimento/i);
  });
});
