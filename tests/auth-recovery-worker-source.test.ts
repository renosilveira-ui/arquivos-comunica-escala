import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync("server/auth-recovery.ts", "utf8");
const clinical = readFileSync(
  "server/cron/shift-confirmation-dispatcher.ts",
  "utf8",
);
const dedicated = readFileSync(
  "server/cron/auth-recovery-dispatcher.ts",
  "utf8",
);
const admin = readFileSync("server/routes/admin.ts", "utf8");
const auth = readFileSync("server/routes/auth.ts", "utf8");
const bootstrap = readFileSync("server/_core/index.ts", "utf8");

describe("auth recovery worker: wiring estático", () => {
  it("isola correio do tick clínico e limita lote/orçamento", () => {
    expect(clinical).not.toContain("processPendingAuthRecoveryEmails");
    expect(dedicated).toContain("processPendingAuthRecoveryEmails");
    expect(worker).toContain("AUTH_RECOVERY_DELIVERY_BATCH_SIZE = 3");
    expect(worker).toContain("AUTH_RECOVERY_TICK_BUDGET_MS = 45_000");
    expect(worker).toContain("if (Date.now() >= deadline) break");
  });

  it("interrompe novos ticks e drena o tick auth no shutdown", () => {
    expect(dedicated).toContain("let activeTick: Promise<void> | null = null");
    expect(dedicated).toContain("if (!acceptingTicks) return");
    expect(dedicated).toContain("return activeTick ?? Promise.resolve()");
    expect(bootstrap).toContain("authRecoveryDrain = stopAuthRecoveryCron()");
    expect(bootstrap).toContain("await authRecoveryDrain");
  });

  it("admin apenas enfileira e o worker trata ambos os tipos", () => {
    expect(admin).toContain("enqueueAdminPasswordRecovery");
    expect(admin).not.toContain("mailer.sendMail");
    expect(admin).toContain("res.status(202).json");
    expect(worker).toContain('claimed.kind === "SELF_SERVICE"');
    expect(worker).toContain('kind === "ADMIN_INITIATED"');
  });

  it("retries usam token/idempotência estável e exceção libera o lease", () => {
    expect(worker).toContain("idempotencyKey: reserved.row.tokenHash!");
    expect(worker).toContain('delivery.kind === "UNKNOWN"');
    expect(worker).toContain('delivery.kind === "REJECTED"');
    expect(worker).toContain('"UNEXPECTED_ATTEMPT_FAILURE"');
    expect(worker).toContain("await requeueOrDead(");
    expect(worker).toContain("closeExpiredAuthRecoveryRows");
    expect(worker).toContain("AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS");
    expect(worker).toContain("deliveryDeadlineAt");
    expect(worker).toContain('"CLAIM_READ_MISSING"');
  });

  it("libera o mutex no egress e o readquire antes da ativação", () => {
    const reservationMutex = worker.indexOf(
      "const reserved = await withPushAccountMutex(",
    );
    const selfProof = worker.indexOf(
      "await bindSelfServiceRequest(",
      reservationMutex,
    );
    const adminProof = worker.indexOf(
      "await lockAndValidateAdminRequest(",
      reservationMutex,
    );
    const egress = worker.indexOf(
      "await mailTransport.sendMail(",
      reservationMutex,
    );
    const activationMutex = worker.indexOf("await withPushAccountMutex(", egress);
    const activation = worker.indexOf(
      "await activateAcceptedRequest(",
      activationMutex,
    );
    expect(reservationMutex).toBeGreaterThan(-1);
    expect(egress).toBeGreaterThan(-1);
    expect(selfProof).toBeGreaterThan(reservationMutex);
    expect(adminProof).toBeGreaterThan(reservationMutex);
    expect(egress).toBeGreaterThan(selfProof);
    expect(egress).toBeGreaterThan(adminProof);
    expect(
      worker.slice(reservationMutex, egress),
    ).not.toContain("mailTransport.sendMail");
    expect(activationMutex).toBeGreaterThan(egress);
    expect(activation).toBeGreaterThan(activationMutex);
  });

  it("não revoga link anterior no enqueue e troca ACTIVE atomicamente após aceite", () => {
    const enqueue = worker.slice(
      worker.indexOf("export async function enqueueAdminPasswordRecovery"),
      worker.indexOf(
        "export async function revokeOutstandingAuthRecoveryRequests",
      ),
    );
    expect(enqueue).not.toContain("revokeOutstandingAuthRecoveryRequests");
    const activate = worker.slice(
      worker.indexOf("async function activateAcceptedRequest"),
      worker.indexOf("function recoveryMail"),
    );
    expect(
      activate.indexOf("revokeOutstandingAuthRecoveryRequests"),
    ).toBeLessThan(activate.indexOf('state: "ACTIVE"'));
    expect(activate).toContain("affectedRows(activation) !== 1");
    expect(activate).toContain("throw new AuthRecoveryActivationCasError()");
  });

  it("aplica limite bcrypt e nunca trata hash não nulo inválido como casca", () => {
    expect(auth).not.toContain("hasUsablePasswordHash");
    expect(auth).toContain(
      "hasPasswordCredentialMaterial(existing.passwordHash)",
    );
    expect(auth).toContain("isClaimablePasswordShell(existing.passwordHash)");
    expect(
      auth.match(/isBcryptInputWithinLimit/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(5);
    expect(auth).toContain("safeBcryptCompare");
  });

  it("não atribui pedido anônimo de recuperação ao usuário alvo", () => {
    expect(worker).not.toContain("Pedido de redefinição de senha enfileirado");
    expect(worker).not.toContain("actorUserId: lockedUser.id");
    expect(worker).toContain('requestActorKind: "UNAUTHENTICATED"');
    expect(worker).toContain('requestActorKind: "AUTHENTICATED_ADMIN"');
  });

  it("recupera SELF_SERVICE pela conta sem escolher tenant e fecha PI corrompida", () => {
    expect(worker).toContain("hasValidAuthRecoveryMembershipBinding");
    expect(worker).toContain("hasSelfServiceAccountTopology");
    expect(worker).toContain("targetMembershipId: null");
    expect(worker).not.toContain("lockCanonicalAuditMembership");
    expect(worker).toContain("memberships.every(");
    expect(worker).toContain("professional?.userId === userId");
    expect(worker).not.toContain("insert(professionalInstitutions)");
    expect(auth).toContain("hasValidAuthRecoveryMembershipBinding(");
  });

  it("recusa hash não-policy no egress e no resgate", () => {
    expect(
      worker.match(/isSafeBcryptHash/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    expect(auth.match(/isSafeBcryptHash/g)?.length ?? 0).toBeGreaterThanOrEqual(
      10,
    );
    expect(auth).toContain("eq(users.passwordHash, lockedUser.passwordHash)");
  });
});
