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

  it("só confirma após aceite do provedor e ativação local", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    expect(source).toContain("providerResult = await mailer.sendMail(mail)");
    expect(source).toContain(
      "const providerAccepted = providerResult.delivered",
    );
    expect(source).toContain("if (!providerAccepted)");
    expect(source).toContain("PROVIDER_ACCEPTED_ACTIVATION_FAILED");
    expect(source).toContain("assertManagerScopeAccessForUpdate");
    expect(source).toContain("{ db: tx, strict: true }");
    expect(source).toContain("aceite/enfileiramento pelo provedor");
    expect(source).toContain("accepted,");
    expect(source).toContain("hashPolicy.write.hash(normalized)");
    expect(source).toContain("codeHashVersion: hashPolicy.write.version");
    expect(source).not.toContain("withScheduleInviteIssuanceMutex");
    expect(source).not.toContain("GET_LOCK");
    expect(source).not.toContain("getConnection()");
  });

  it("a lista padrão inclui a sala de espera e filtra por nome sem acento", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    expect(source).toContain("foldCandidateSearch");
    expect(source).toContain("row.active && row.institutionId");
    expect(source).toContain(
      "canonicalProfessionalByUser.get(row.userId) !== row.professionalId",
    );
    expect(source).toContain("name: z.string().trim().max(120).optional()");
    expect(source).toContain(
      'foldCandidateSearch(row.name ?? "").includes(nameNeedle)',
    );
  });

  it("documenta e materializa uma fence durável sem persistir segredo", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    const migration = readFileSync(
      "drizzle/migrations/manual/2026-09-10-schedule-invite-issuance-fences.sql",
      "utf8",
    );
    expect(source).toContain("scheduleInviteIssuanceFences");
    expect(schema).toContain("schedule_invite_issuance_fences");
    expect(migration).toContain("schedule_invite_issuance_fences");
    expect(schema).toContain("uniq_schedule_invite_issuance_scope");
    expect(migration).toContain("PROVIDER_ACCEPTED_ACTIVATION_FAILED");
    expect(migration).toContain("Aplicar ANTES do runtime");
    expect(migration).not.toMatch(
      /\b(code_hash|invited_email|plaintext_code|provider_payload)\b/i,
    );
  });

  it("versiona HMAC, exige pepper dedicado e mantém V1 só para compatibilidade", () => {
    const domain = readFileSync("lib/schedule-invite-code.ts", "utf8");
    const policy = readFileSync(
      "server/schedule-invite-code-policy.ts",
      "utf8",
    );
    const migration = readFileSync(
      "drizzle/migrations/manual/2026-09-10-schedule-invite-code-hash-v2.sql",
      "utf8",
    );
    expect(domain).toContain("createHmac");
    expect(domain).toContain("HMAC_SHA256_V2");
    expect(policy).toContain("SCHEDULE_INVITE_CODE_PEPPER");
    expect(policy).toContain("SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER");
    expect(policy).toContain("COOKIE_SECRET");
    expect(policy).toContain("TWILIO_AUTH_TOKEN");
    expect(policy).not.toMatch(/console\.(log|warn|error)/);
    expect(migration).toContain("code_hash_version");
    expect(migration).toContain("SHA256_V1");
    expect(migration).toContain("HMAC_SHA256_V2");
    expect(migration).not.toContain("SCHEDULE_INVITE_CODE_PEPPER=");
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
