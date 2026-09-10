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

  it("resgate prova um único professional e recusa não resolve identidade ambígua", () => {
    const source = readFileSync("server/routes/auth.ts", "utf8");
    const redeem = source.slice(
      source.indexOf('"/redeem-invite"'),
      source.indexOf('"/decline-invite"'),
    );
    const decline = source.slice(source.indexOf('"/decline-invite"'));
    expect(redeem).toContain("requireSingleInviteProfessionalId");
    expect(redeem).toContain("const professionalRows = await tx");
    expect(redeem).not.toMatch(/from\(professionals\)[\s\S]{0,180}limit\(1\)/);
    expect(redeem).toContain("await lockCurrentInviteActor(tx, authUser)");
    expect(decline).toContain("await lockCurrentInviteActor(tx, authUser)");
    expect(decline).not.toContain("requireSingleInviteProfessionalId");
  });

  it("não confirma o convite sem ACCEPTED e preserva o estado tri-state", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    expect(source).toContain("const delivery = await mailer.sendMail(mail, {");
    expect(source).toContain("idempotencyKey: codeHash");
    expect(source).toContain('if (delivery.kind === "REJECTED")');
    expect(source).toContain('if (delivery.kind === "UNKNOWN")');
    expect(source).toContain(
      "O provedor não aceitou o pedido de envio. Tente novamente.",
    );
    expect(source).toContain(
      "entrega na caixa postal não é comprovada nesta integração",
    );
    expect(source).toContain(
      "O resultado do pedido de envio foi inconclusivo; o convite foi revogado.",
    );
    expect(source).not.toContain(
      'delivery.transport === "resend" && delivery.kind !== "ACCEPTED"',
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

  it("listActive limita a população SQL a convites canonicamente ativos", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    const listActive = source.slice(
      source.indexOf("listActive: protectedProcedure"),
      source.indexOf("listCandidates: protectedProcedure"),
    );
    expect(listActive).toContain("const now = new Date()");
    expect(listActive).toContain(
      "eq(scheduleInvites.institutionId, actor.institutionId)",
    );
    expect(listActive).toContain("isNull(scheduleInvites.revokedAt)");
    expect(listActive).toContain("isNull(scheduleInvites.declinedAt)");
    expect(listActive).toContain("gt(scheduleInvites.expiresAt, now)");
    expect(listActive).toContain(
      "sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`",
    );
    expect(listActive).toContain(".filter((context) => context.canManage)");
    expect(listActive).toContain(
      "manageable.has(`${row.hospitalId}:${row.sectorId}`)",
    );
    expect(listActive.match(/new Date\(\)/g)).toHaveLength(1);
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

  it("revoga convite com autoridade corrente, lock canônico e CAS tenant-scoped", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    const revoke = source.slice(source.indexOf("  revoke: protectedProcedure"));
    const authorityIndex = revoke.indexOf(
      "await assertManagerScopeAccessForUpdate(",
    );
    const lockIndex = revoke.indexOf('.for("update")');
    const updateIndex = revoke.indexOf(".update(scheduleInvites)");

    expect(revoke).toContain("return db.transaction(async (tx) => {");
    expect(revoke).not.toContain("assertCanManageSector(");
    expect(revoke).toContain("ctx.user.sessionVersion");
    expect(authorityIndex).toBeGreaterThan(0);
    expect(lockIndex).toBeGreaterThan(authorityIndex);
    expect(updateIndex).toBeGreaterThan(lockIndex);
    expect(revoke).toContain("eq(scheduleInvites.id, input.inviteId)");
    expect(revoke).toContain(
      "eq(scheduleInvites.institutionId, actor.institutionId)",
    );
    expect(revoke).toContain("isNull(scheduleInvites.revokedAt)");
    expect(revoke).toContain("updateAffectedRows(result) !== 1");
    expect(revoke).toContain("if (lockedInvite.revokedAt)");
  });
});
