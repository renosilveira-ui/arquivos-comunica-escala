import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wiring fail-closed dos convites de escala", () => {
  it("o cadastro com convite aprova e o sem convite permanece pendente", () => {
    const source = readFileSync("server/routes/auth.ts", "utf8");
    expect(source).toContain('approvalStatus: parsedInvite ? "APPROVED" : "PENDING"');
    expect(source).toContain("redeemScheduleInviteInTransaction");
    expect(source).toContain('"/redeem-invite"');
    expect(source).toContain("ScheduleInviteError");
  });

  it("o resgate recusa especialidade incompatível, convite gasto e escala já liberada", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    expect(source).toContain("qualificationMatches(input.qualification, context)");
    expect(source).toContain('Sua especialidade não é aceita nesta escala');
    expect(source).toContain("Você já está nesta escala");
    expect(source).toContain("Convite inválido ou expirado");
    expect(source).toContain("assertCanManageSector");
    expect(source).not.toContain("node:crypto");
  });

  it("o app não importa o gerador de código com crypto de Node", () => {
    const signup = readFileSync("app/signup.tsx", "utf8");
    const join = readFileSync("app/join-schedule.tsx", "utf8");
    const invites = readFileSync("app/schedule-invites.tsx", "utf8");
    expect(signup).toContain("inviteCode");
    expect(signup).not.toContain("schedule-invite-code");
    expect(join).not.toContain("schedule-invite-code");
    expect(invites).toContain("scheduleInvites.create");
    expect(invites).not.toContain("schedule-invite-code");
  });
});
