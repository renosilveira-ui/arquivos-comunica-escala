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

  // O envio inline com revogação preventiva foi aposentado: a intenção agora
  // é persistida antes do egress e só o par aceite + ativação confirma o
  // convite. REJECTED/UNKNOWN continuam cobertos, mas pelo estado durável
  // (PROVIDER_UNKNOWN, PROVIDER_ACCEPTED_ACTIVATION_FAILED) e não por revogar.
  it("persiste intenção antes do envio e só confirma após aceite + ativação", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    expect(source.indexOf('event: "CLAIMED"')).toBeLessThan(
      source.indexOf("providerResult = await mailer.sendMail(claim.mail"),
    );
    expect(source).toContain('providerResult.kind !== "ACCEPTED"');
    expect(source).toContain("outcome: providerResult.kind");
    expect(source).toContain("idempotencyKey:");
    expect(source).toContain("persistedMaterial.providerRequestFingerprint");
    expect(source).toContain("fingerprintProviderRequest(claim.mail)");
    expect(source).toContain("PROVIDER_REQUEST_CHANGED_BEFORE_EGRESS");
    expect(source).toContain("ATTEMPT_EXPIRED_BEFORE_EGRESS");
    expect(source).toContain('activationFailureCode = "ACTIVATION_EXPIRED"');
    expect(source).toContain('outcome: "UNKNOWN"');
    expect(source).toContain("PROVIDER_ACCEPTED_ACTIVATION_FAILED");
    expect(source).toContain("assertManagerScopeAccessForUpdate");
    expect(source).toContain("{ db: tx, strict: true }");
    expect(source).toContain("accepted,");
    expect(source).toContain("codeHash: outboxKey.hash(normalized)");
    expect(source).toContain("codeHashVersion: hashPolicy.write.version");
    expect(source).toContain("scheduleInviteIssuanceFences.leaseToken");
    expect(source).toContain("claim.material.leaseToken");
    expect(source).toContain("claim.material.generation");
    expect(source).toContain(
      'eq(scheduleInviteIssuanceFences.state, "PROVIDER_ACCEPTED")',
    );
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

  it("materializa outbox e journal append-only sem persistir código/e-mail", () => {
    const source = readFileSync("server/schedule-invites.ts", "utf8");
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    const migration = readFileSync(
      "drizzle/migrations/manual/2026-09-10-schedule-invite-issuance-fences.sql",
      "utf8",
    );
    expect(source).toContain("scheduleInviteIssuanceFences");
    expect(schema).toContain("schedule_invite_issuance_fences");
    expect(schema).toContain("schedule_invite_issuance_journal");
    expect(migration).toContain("schedule_invite_issuance_fences");
    expect(migration).toContain("schedule_invite_issuance_journal");
    expect(schema).toContain("uniq_schedule_invite_issuance_scope");
    expect(schema).toContain("PROVIDER_UNKNOWN");
    expect(schema).toContain("provider_idempotency_key");
    expect(schema).toContain("provider_request_fingerprint");
    expect(schema).toContain("recipient_binding_hash");
    expect(migration).toContain("PROVIDER_ACCEPTED_ACTIVATION_FAILED");
    expect(migration).toContain("Aplicar ANTES da migration hash V2");
    expect(source).toContain("appendInviteIssuanceJournal");
    expect(source).toContain("fingerprintProviderRequest");
    expect(migration).toContain(
      "trg_schedule_invite_issuance_journal_no_update",
    );
    expect(migration).toContain(
      "trg_schedule_invite_issuance_journal_no_delete",
    );
    expect(migration).toContain("INFORMATION_SCHEMA.CHECK_CONSTRAINTS");
    expect(migration).toContain("INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS");
    expect(migration).toContain("POSITION_IN_UNIQUE_CONSTRAINT");
    expect(migration).toContain("referential_constraints.UPDATE_RULE");
    expect(migration).toContain("referential_constraints.DELETE_RULE");
    expect(migration).toContain("check_manifest.NORMALIZED_CLAUSE =");
    expect(source).not.toContain(".update(scheduleInviteIssuanceJournal)");
    expect(migration).not.toMatch(
      /\b(code_hash|invited_email|plaintext_code|provider_payload)\b/i,
    );
    expect(source).not.toMatch(
      /console\.(?:log|warn|error)\([^)]*(?:formatted|normalized|codeHash|invitee\.email|providerIdempotencyKey)/s,
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
    expect(migration).toContain("DEFAULT ''HMAC_SHA256_V2'' AFTER code_hash");
    expect(migration).not.toContain("SCHEDULE_INVITE_CODE_PEPPER=");
  });

  it("mantém o remetente do fingerprint alinhado ao fallback real do mailer", () => {
    const mailerSource = readFileSync("server/mailer.ts", "utf8");
    const fingerprintSource = readFileSync(
      "server/schedule-invite-provider-request.ts",
      "utf8",
    );
    const fallback = "Escala+ <no-reply@escalas.app>";
    expect(mailerSource).toContain(`DEFAULT_FROM = "${fallback}"`);
    expect(fingerprintSource).toContain(`"${fallback}"`);
    expect(fingerprintSource).toContain('createHmac("sha256", pepper)');
    expect(fingerprintSource).not.toContain("createHash");
  });

  it("documenta o bloqueador de composição do reset administrativo", () => {
    const contract = readFileSync(
      "docs/operations/admin-reset-durable-delivery-contract.md",
      "utf8",
    );
    expect(contract).toContain("não pode trocar `password_hash`");
    expect(contract).toContain("Em `REJECTED`, não alterar a credencial");
    expect(contract).toContain("Em `UNKNOWN`");
    expect(contract).toContain("Sem e-mail, rejeitar antes");
    expect(contract).toContain("Nunca retornar\n   `{ ok: true }`");
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
