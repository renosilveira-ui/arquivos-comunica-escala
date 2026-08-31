import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessOperationalEmailEligibility,
  consumeOperationalEmailVerificationToken,
  hashOperationalEmailVerificationTokenForStorage,
  invalidateOperationalEmailTrustAfterEmailChange,
  issueOperationalEmailVerificationToken,
  markOperationalEmailTrustPendingForSelfSignup,
  resolveOperationalDeliveryChannels,
  trustOperationalEmailFromActivatedInvite,
  trustOperationalEmailFromAdministrativeOrigin,
  type OperationalEmailTrustStore,
} from "../server/operational-email-trust";
import { hashOperationalEmailAddress } from "../server/operational-events";

type MemoryUser = {
  id: number;
  email: string | null;
  deletedAt: Date | null;
};

type MemoryTrust = {
  id: number;
  userId: number;
  emailHash: string;
  state: "PENDING" | "TRUSTED" | "REVOKED";
  source: "ADMIN_CREATED" | "INVITE_ACTIVATED" | "USER_CONFIRMED" | "LEGACY";
  trustedAt: Date | null;
  invalidatedAt: Date | null;
};

type MemoryToken = {
  id: number;
  userId: number;
  emailHash: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};

class MemoryOperationalEmailTrustStore implements OperationalEmailTrustStore {
  readonly users = new Map<number, MemoryUser>();
  readonly trusts = new Map<number, MemoryTrust>();
  readonly tokens = new Map<number, MemoryToken>();
  readonly activeMemberships = new Set<string>();
  private nextTrustId = 1;
  private nextTokenId = 1;

  addUser(id: number, email: string | null) {
    this.users.set(id, { id, email, deletedAt: null });
  }

  allow(userId: number, institutionId: number) {
    this.activeMemberships.add(`${userId}:${institutionId}`);
  }

  async lockUser(userId: number) {
    return this.users.get(userId) ?? null;
  }

  async lockTrust(userId: number) {
    return this.trusts.get(userId) ?? null;
  }

  async saveTrust(input: {
    existing: MemoryTrust | null;
    userId: number;
    emailHash: string;
    state: MemoryTrust["state"];
    source: MemoryTrust["source"];
    trustedAt: Date | null;
    invalidatedAt: Date | null;
  }) {
    this.trusts.set(input.userId, {
      id: input.existing?.id ?? this.nextTrustId++,
      userId: input.userId,
      emailHash: input.emailHash,
      state: input.state,
      source: input.source,
      trustedAt: input.trustedAt,
      invalidatedAt: input.invalidatedAt,
    });
  }

  async invalidateUnusedTokens(userId: number, at: Date) {
    for (const token of this.tokens.values()) {
      if (token.userId === userId && token.usedAt === null) token.usedAt = at;
    }
  }

  async createVerificationToken(input: Omit<MemoryToken, "id" | "usedAt">) {
    this.tokens.set(this.nextTokenId, {
      id: this.nextTokenId++,
      ...input,
      usedAt: null,
    });
  }

  async findTokenByHash(tokenHash: string) {
    const token = [...this.tokens.values()].find(
      (candidate) => candidate.tokenHash === tokenHash,
    );
    return token ? { userId: token.userId } : null;
  }

  async lockTokenByHash(tokenHash: string) {
    return (
      [...this.tokens.values()].find(
        (candidate) => candidate.tokenHash === tokenHash,
      ) ?? null
    );
  }

  async markTokenUsedIfUsable(input: { tokenId: number; now: Date }) {
    const token = this.tokens.get(input.tokenId);
    if (
      !token ||
      token.usedAt ||
      token.expiresAt.getTime() <= input.now.getTime()
    ) {
      return false;
    }
    token.usedAt = input.now;
    return true;
  }

  async lockActiveInstitutionMembership(input: {
    userId: number;
    institutionId: number;
  }) {
    return this.activeMemberships.has(`${input.userId}:${input.institutionId}`);
  }
}

const NOW = new Date("2026-08-31T12:00:00.000Z");

function operationalEmailTrustSource() {
  return readFileSync(
    new URL("../server/operational-email-trust.ts", import.meta.url),
    "utf8",
  );
}

function createStore() {
  const store = new MemoryOperationalEmailTrustStore();
  store.addUser(10, "Medico@Test.Example");
  store.allow(10, 1);
  return store;
}

describe("confiança de e-mail operacional", () => {
  it("usa hash normalizado e não persiste token puro", async () => {
    const store = createStore();
    await markOperationalEmailTrustPendingForSelfSignup(store, {
      userId: 10,
      now: NOW,
    });

    const issued = await issueOperationalEmailVerificationToken(store, {
      userId: 10,
      now: NOW,
    });
    expect(issued.kind).toBe("ISSUED");
    if (issued.kind !== "ISSUED") return;

    const stored = [...store.tokens.values()][0]!;
    expect(stored.emailHash).toBe(
      hashOperationalEmailAddress(" medico@test.example "),
    );
    expect(stored.tokenHash).toBe(
      hashOperationalEmailVerificationTokenForStorage(issued.token),
    );
    expect(stored.tokenHash).not.toContain(issued.token);
    expect(JSON.stringify(stored)).not.toContain(issued.token);
  });

  it("aplica as origens sem permitir que uma origem fraca rebaixe prova atual", async () => {
    const store = createStore();
    const created = await trustOperationalEmailFromAdministrativeOrigin(store, {
      userId: 10,
      now: NOW,
    });
    expect(created).toMatchObject({
      state: "TRUSTED",
      source: "ADMIN_CREATED",
    });

    const legacy = await markOperationalEmailTrustPendingForSelfSignup(store, {
      userId: 10,
      now: new Date(NOW.getTime() + 1),
    });
    expect(legacy).toMatchObject({
      state: "TRUSTED",
      source: "ADMIN_CREATED",
      changed: false,
    });

    const invite = await trustOperationalEmailFromActivatedInvite(store, {
      userId: 10,
      now: new Date(NOW.getTime() + 2),
    });
    expect(invite).toMatchObject({
      state: "TRUSTED",
      source: "INVITE_ACTIVATED",
    });

    expect(operationalEmailTrustSource()).not.toContain(
      "export async function recordOperationalEmailTrustForOrigin",
    );
  });

  it("não duplica consumo concorrente e mantém retry posterior idempotente", async () => {
    const store = createStore();
    const issued = await issueOperationalEmailVerificationToken(store, {
      userId: 10,
      now: NOW,
    });
    expect(issued.kind).toBe("ISSUED");
    if (issued.kind !== "ISSUED") return;

    const [left, right] = await Promise.all([
      consumeOperationalEmailVerificationToken(store, {
        token: issued.token,
        now: new Date(NOW.getTime() + 1),
      }),
      consumeOperationalEmailVerificationToken(store, {
        token: issued.token,
        now: new Date(NOW.getTime() + 1),
      }),
    ]);
    expect(
      [left.kind, right.kind].filter((kind) => kind === "CONSUMED"),
    ).toHaveLength(1);
    expect([left.kind, right.kind]).toContain("INVALID_OR_EXPIRED");
    expect(store.trusts.get(10)).toMatchObject({
      state: "TRUSTED",
      source: "USER_CONFIRMED",
    });
    expect([...store.tokens.values()][0]?.usedAt).not.toBeNull();
    await expect(
      consumeOperationalEmailVerificationToken(store, {
        token: issued.token,
        now: new Date(NOW.getTime() + 2),
      }),
    ).resolves.toEqual({ kind: "ALREADY_CONSUMED" });
  });

  it("recusa token expirado e não converte expiração em confiança", async () => {
    const store = createStore();
    const issued = await issueOperationalEmailVerificationToken(store, {
      userId: 10,
      now: NOW,
      ttlMs: 1,
    });
    expect(issued.kind).toBe("ISSUED");
    if (issued.kind !== "ISSUED") return;

    await expect(
      consumeOperationalEmailVerificationToken(store, {
        token: issued.token,
        now: new Date(NOW.getTime() + 1),
      }),
    ).resolves.toEqual({ kind: "INVALID_OR_EXPIRED" });
    expect(store.trusts.get(10)).toMatchObject({ state: "PENDING" });
  });

  it("invalida confiança e token na alteração ou anonimização de e-mail", async () => {
    const store = createStore();
    const issued = await issueOperationalEmailVerificationToken(store, {
      userId: 10,
      now: NOW,
    });
    expect(issued.kind).toBe("ISSUED");
    if (issued.kind !== "ISSUED") return;

    store.users.get(10)!.email = "novo@example.test";
    await invalidateOperationalEmailTrustAfterEmailChange(store, {
      userId: 10,
      now: new Date(NOW.getTime() + 2),
    });
    expect(store.trusts.get(10)).toMatchObject({ state: "REVOKED" });
    await expect(
      consumeOperationalEmailVerificationToken(store, {
        token: issued.token,
        now: new Date(NOW.getTime() + 3),
      }),
    ).resolves.toEqual({ kind: "INVALID_OR_EXPIRED" });

    store.users.get(10)!.email = "removido+10@anon.local";
    store.users.get(10)!.deletedAt = new Date(NOW.getTime() + 4);
    const anonymized = await invalidateOperationalEmailTrustAfterEmailChange(
      store,
      { userId: 10, now: new Date(NOW.getTime() + 4) },
    );
    expect(anonymized).toEqual({ invalidated: false });
    expect(store.trusts.get(10)).toMatchObject({ state: "REVOKED" });
  });

  it("reconcilia divergência de e-mail de writer legado em modo fail-closed", async () => {
    const store = createStore();
    await trustOperationalEmailFromAdministrativeOrigin(store, {
      userId: 10,
      now: NOW,
    });

    // Defesa adicional: mesmo se um writer legado escapar da porta canônica,
    // a primeira avaliação para entrega torna a confiança antiga inelegível.
    store.users.get(10)!.email = "novo-writer-legado@example.test";
    await expect(
      assessOperationalEmailEligibility(store, {
        userId: 10,
        institutionId: 1,
        now: new Date(NOW.getTime() + 1),
      }),
    ).resolves.toEqual({ kind: "INELIGIBLE", reason: "EMAIL_CHANGED" });
    expect(store.trusts.get(10)).toMatchObject({ state: "REVOKED" });
  });

  it("isola elegibilidade por tenant e nunca retira PUSH por e-mail pendente", async () => {
    const store = createStore();
    await trustOperationalEmailFromAdministrativeOrigin(store, {
      userId: 10,
      now: NOW,
    });
    const ownTenant = await assessOperationalEmailEligibility(store, {
      userId: 10,
      institutionId: 1,
      now: NOW,
    });
    const foreignTenant = await assessOperationalEmailEligibility(store, {
      userId: 10,
      institutionId: 2,
      now: NOW,
    });
    expect(ownTenant.kind).toBe("ELIGIBLE");
    expect(foreignTenant).toEqual({
      kind: "INELIGIBLE",
      reason: "NO_ACTIVE_INSTITUTION_MEMBERSHIP",
    });
    expect(
      resolveOperationalDeliveryChannels({
        requestedChannels: ["PUSH", "EMAIL"],
        emailEligibility: foreignTenant,
      }),
    ).toMatchObject({ eligibleChannels: ["PUSH"] });
  });

  it("mantém os escritores runtime nas portas canônicas e sem API ou provider", () => {
    const authSource = readFileSync(
      new URL("../server/routes/auth.ts", import.meta.url),
      "utf8",
    );
    const adminSource = readFileSync(
      new URL("../server/routes/admin.ts", import.meta.url),
      "utf8",
    );
    const inviteSource = readFileSync(
      new URL("../server/schedule-invites.ts", import.meta.url),
      "utf8",
    );
    const serviceSource = operationalEmailTrustSource();

    expect(authSource).toContain(
      "trustOperationalEmailFromAdministrativeOriginInTransaction",
    );
    expect(authSource).toContain(
      "markOperationalEmailTrustPendingForSelfSignupInTransaction",
    );
    expect(authSource).toContain(
      "invalidateOperationalEmailTrustAfterEmailChangeInTransaction",
    );
    expect(adminSource).toContain(
      "invalidateOperationalEmailTrustAfterEmailChangeInTransaction",
    );
    const redemptionCas = inviteSource.indexOf("const increment =");
    const inviteTrust = inviteSource.indexOf(
      "await trustOperationalEmailFromActivatedInviteInTransaction",
      redemptionCas,
    );
    expect(redemptionCas).toBeGreaterThanOrEqual(0);
    expect(inviteTrust).toBeGreaterThan(
      inviteSource.indexOf("updateAffectedRows(increment)", redemptionCas),
    );
    expect(serviceSource).not.toContain("sendMail(");
    expect(serviceSource).not.toContain("mailer");
    expect(serviceSource).not.toContain("console.");
    expect(serviceSource).not.toContain("Router(");
  });
});
