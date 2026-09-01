import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wiring fail-closed dos convites nominais", () => {
  it("o cadastro público não resgata convite e a conta sem instituição nasce aprovada", () => {
    const source = readFileSync("server/routes/auth.ts", "utf8");
    expect(source).toContain(
      'const nextApproval = awaitingApproval ? "PENDING" : "APPROVED"',
    );
    expect(source).toContain("approvalStatus: nextApproval");
    expect(source).toContain("let awaitingApproval = hasInstitution");
    expect(source).toContain("O cadastro não usa código de convite");
    expect(source).toContain('"/redeem-invite"');
    expect(source).toContain('"/decline-invite"');
    expect(source).toContain("declineScheduleInviteInTransaction");
    expect(source).toContain("ScheduleInviteError");
    expect(source).not.toContain("peekScheduleInviteInstitution");
  });

  it("o resgate exige topologia única, convite nominal e acesso setorial", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    expect(source).not.toContain("qualificationMatches");
    expect(source).not.toContain("Sua especialidade não é aceita nesta escala");
    expect(source).toContain("contexts.length !== 1");
    expect(source).toContain(
      "mais de uma escala ativa; regularize a topologia",
    );
    expect(source).toContain(
      "eq(professionalAccess.sectorId, invite.sectorId)",
    );
    expect(source).toContain("Você já está nesta escala");
    expect(source).toContain("Convite inválido ou expirado");
    expect(source).toContain("Este convite já foi recusado");
    expect(source).toContain("isNull(scheduleInvites.declinedAt)");
    expect(source).toContain("Este convite não foi emitido para a sua conta");
    expect(source).toContain("invitedUserId");
    expect(source).toContain("assertCanManageSector");
    expect(source).toContain("userIds");
    expect(source).not.toContain("node:crypto");
  });

  it("não confirma o convite se o correio não entregou, inclusive sem chave", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    expect(source).toContain("const delivery = await mailer.sendMail(mail)");
    expect(source).toContain("if (!delivery.delivered)");
    expect(source).toContain("O e-mail de convite não saiu. Tente novamente.");
    expect(source).not.toContain(
      'delivery.transport === "resend" && !delivery.delivered',
    );
  });

  it("a lista padrão inclui a sala de espera e filtra por nome sem acento", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    expect(source).toContain("foldCandidateSearch");
    expect(source).toContain("notExists");
    expect(source).toContain("eq(professionalInstitutions.active, true)");
    expect(source).toContain("name: z.string().trim().max(120).optional()");
    expect(source).toContain(
      'foldCandidateSearch(row.name ?? "").includes(nameNeedle)',
    );
  });

  it("o app não importa o gerador de código com crypto de Node", () => {
    const signup = readFileSync("app/signup.tsx", "utf8");
    const join = readFileSync("app/join-schedule.tsx", "utf8");
    const invites = readFileSync("app/schedule-invites.tsx", "utf8");
    expect(signup).not.toContain("inviteCode");
    expect(signup).not.toContain("Convite da escala");
    expect(signup).not.toContain("schedule-invite-code");
    expect(join).not.toContain("schedule-invite-code");
    expect(join).toContain("Recusar convite");
    expect(join).toContain("confirmDestructive");
    expect(join).toContain("authApi.declineInvite");
    expect(join).toContain("setDeclined(true)");
    expect(invites).toContain("scheduleInvites.create");
    expect(invites).toContain("userIds");
    expect(invites).toContain("Buscar por nome");
    expect(invites).not.toContain("schedule-invite-code");
    expect(invites).not.toContain("Share.share");
    expect(invites).not.toContain("Buscar e-mail");
  });
});
