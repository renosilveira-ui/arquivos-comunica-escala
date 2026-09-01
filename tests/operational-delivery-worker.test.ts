import { describe, expect, it, vi } from "vitest";
import {
  InMemoryOperationalDeliveryStore,
  canClaimOperationalDeliveryForEmissionMode,
  operationalDeliveryRetryDelayForClaim,
  operationalDeliveryTransportIdempotencyKey,
  processOperationalDeliveryBatch,
  runOperationalDeliveryWorker,
  type OperationalDeliveryClaim,
  type OperationalDeliveryRecord,
  type OperationalDeliveryStore,
  type OperationalDeliveryTransport,
} from "../server/operational-delivery-worker";

const NOW = new Date("2026-08-31T12:00:00.000Z");

function delivery(
  overrides: Partial<OperationalDeliveryRecord> = {},
): OperationalDeliveryRecord {
  const id = overrides.id ?? 1;
  return {
    id,
    operationalEventId: 100 + id,
    institutionId: 9,
    recipientKind: "USER",
    recipientReferenceId: 20 + id,
    channel: "PUSH",
    status: "QUEUED",
    attemptCount: 0,
    availableAt: new Date(NOW),
    leaseUntil: null,
    providerAcceptedAt: null,
    deliveredAt: null,
    lastErrorCode: null,
    dedupKey: id.toString(16).padStart(64, "0"),
    emissionMode: "ACTIVE",
    ...overrides,
  };
}

function deliveredTransport(
  calls: unknown[] = [],
): OperationalDeliveryTransport {
  return {
    deliver: vi.fn(async (request) => {
      calls.push(request);
      return { state: "DELIVERED" };
    }),
  };
}

describe("motor de entregas operacionais", () => {
  it("mantém worker desabilitado e inerte até receber store e transporte explícitos", async () => {
    await expect(runOperationalDeliveryWorker({})).resolves.toEqual({
      mode: "DISABLED",
      claimed: 0,
      providerAccepted: 0,
      delivered: 0,
      failed: 0,
    });
    await expect(
      runOperationalDeliveryWorker({
        OPERATIONAL_DELIVERY_WORKER_ENABLED: "true",
      }),
    ).resolves.toEqual({
      mode: "INERT_NO_TRANSPORT",
      claimed: 0,
      providerAccepted: 0,
      delivered: 0,
      failed: 0,
    });
  });

  it("falha fechado para SHADOW e para emission_mode ausente", async () => {
    expect(canClaimOperationalDeliveryForEmissionMode("ACTIVE")).toBe(true);
    expect(canClaimOperationalDeliveryForEmissionMode("SHADOW")).toBe(false);
    expect(canClaimOperationalDeliveryForEmissionMode(undefined)).toBe(false);

    const shadowStore = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery({ emissionMode: "SHADOW" })],
    });
    const shadowTransport = deliveredTransport();
    await expect(
      processOperationalDeliveryBatch({
        store: shadowStore,
        transport: shadowTransport,
        now: NOW,
      }),
    ).resolves.toMatchObject({ claimed: 0, delivered: 0 });
    expect(shadowTransport.deliver).not.toHaveBeenCalled();
    expect(shadowStore.snapshot(1)?.status).toBe("QUEUED");

    const missingModeStore = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery({ emissionMode: null })],
    });
    await processOperationalDeliveryBatch({
      store: missingModeStore,
      transport: deliveredTransport(),
      now: NOW,
    });
    expect(missingModeStore.snapshot(1)?.status).toBe("QUEUED");
  });

  it("bloqueia claim SHADOW ou sem modo devolvido por store malcomportado", async () => {
    const events: unknown[] = [];
    const malformedClaims: OperationalDeliveryClaim[] = [
      {
        delivery: delivery({ id: 1, emissionMode: "SHADOW" }),
        claimToken: "malformed-shadow",
      },
      {
        delivery: delivery({ id: 2, emissionMode: undefined }),
        claimToken: "malformed-missing-mode",
      },
    ];
    const claimNext = vi.fn(async () => malformedClaims.shift() ?? null);
    const renewClaimLease = vi.fn(async () => null);
    const revalidateRecipientAccess = vi.fn(async () => {
      throw new Error("não deve revalidar claim não-claimable");
    });
    const applyTransition = vi.fn(async () => {
      throw new Error("não deve transicionar claim não-claimable");
    });
    const store: OperationalDeliveryStore = {
      claimNext,
      renewClaimLease,
      revalidateRecipientAccess,
      applyTransition,
    };
    const transport = deliveredTransport();

    await expect(
      processOperationalDeliveryBatch({
        store,
        transport,
        now: NOW,
        limit: 2,
        observability: { record: (event) => events.push(event) },
      }),
    ).resolves.toMatchObject({ claimed: 0, claimLost: 2, delivered: 0 });
    expect(transport.deliver).not.toHaveBeenCalled();
    expect(revalidateRecipientAccess).not.toHaveBeenCalled();
    expect(renewClaimLease).not.toHaveBeenCalled();
    expect(applyTransition).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ kind: "CLAIM_LOST", deliveryId: 1 }),
      expect.objectContaining({ kind: "CLAIM_LOST", deliveryId: 2 }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /idempotency|dedup|recipientReferenceId|email|token|body|phi/i,
    );
  });

  it("faz claim concorrente único e bloqueia finalização de lease vencido", async () => {
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery()],
    });
    const [first, simultaneous] = await Promise.all([
      store.claimNext({ now: NOW, leaseMs: 1_000 }),
      store.claimNext({ now: NOW, leaseMs: 1_000 }),
    ]);
    const firstClaim = first ?? simultaneous;
    expect(firstClaim).not.toBeNull();
    expect([first, simultaneous].filter(Boolean)).toHaveLength(1);

    const replacement = await store.claimNext({
      now: new Date(NOW.getTime() + 1_001),
      leaseMs: 1_000,
    });
    expect(replacement).not.toBeNull();
    expect(replacement?.claimToken).not.toBe(firstClaim?.claimToken);

    await expect(
      store.applyTransition(firstClaim!, {
        status: "DELIVERED",
        at: new Date(NOW.getTime() + 1_001),
      }),
    ).resolves.toEqual({ applied: false, delivery: null });
    await expect(
      store.applyTransition(replacement!, {
        status: "DELIVERED",
        at: new Date(NOW.getTime() + 1_001),
      }),
    ).resolves.toMatchObject({ applied: true });
    expect(store.snapshot(1)).toMatchObject({
      status: "DELIVERED",
      attemptCount: 2,
    });
  });

  it("mantém PUSH e EMAIL independentes quando push falha e email entrega", async () => {
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [
        delivery({ id: 1, channel: "PUSH" }),
        delivery({ id: 2, channel: "EMAIL" }),
      ],
    });
    const transport: OperationalDeliveryTransport = {
      deliver: vi.fn(async ({ channel }) =>
        channel === "PUSH"
          ? {
              state: "FAILED",
              retryable: true,
              code: "TRANSPORT_REJECTED",
            }
          : { state: "DELIVERED" },
      ),
    };

    await expect(
      processOperationalDeliveryBatch({
        store,
        transport,
        now: NOW,
        jitter: () => 0,
      }),
    ).resolves.toMatchObject({
      claimed: 2,
      delivered: 1,
      failed: 1,
      dead: 0,
    });
    expect(store.snapshot(1)).toMatchObject({
      channel: "PUSH",
      status: "FAILED",
      attemptCount: 1,
    });
    expect(store.snapshot(2)).toMatchObject({
      channel: "EMAIL",
      status: "DELIVERED",
      attemptCount: 1,
    });
  });

  it("mantém PUSH e EMAIL independentes quando email falha e push entrega", async () => {
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [
        delivery({ id: 1, channel: "PUSH" }),
        delivery({ id: 2, channel: "EMAIL" }),
      ],
    });
    const transport: OperationalDeliveryTransport = {
      deliver: vi.fn(async ({ channel }) =>
        channel === "EMAIL"
          ? {
              state: "FAILED",
              retryable: true,
              code: "TRANSPORT_REJECTED",
            }
          : { state: "DELIVERED" },
      ),
    };

    await processOperationalDeliveryBatch({
      store,
      transport,
      now: NOW,
      jitter: () => 0,
    });
    expect(store.snapshot(1)).toMatchObject({
      channel: "PUSH",
      status: "DELIVERED",
    });
    expect(store.snapshot(2)).toMatchObject({
      channel: "EMAIL",
      status: "FAILED",
    });
  });

  it("limita a seis tentativas e usa backoff com jitter injetável", async () => {
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery()],
    });
    const transport: OperationalDeliveryTransport = {
      deliver: vi.fn(async () => ({
        state: "FAILED",
        retryable: true,
        code: "TRANSPORT_REJECTED",
      })),
    };
    let dueAt = new Date(NOW);

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await processOperationalDeliveryBatch({
        store,
        transport,
        now: dueAt,
        jitter: () => 0.5,
      });
      const current = store.snapshot(1)!;
      expect(current.attemptCount).toBe(attempt);
      if (attempt < 6) {
        expect(current.status).toBe("FAILED");
        const baseDelay = Math.min(
          60_000 * 2 ** (attempt - 1),
          60 * 60 * 1_000,
        );
        expect(current.availableAt.getTime() - dueAt.getTime()).toBe(
          baseDelay + Math.floor(baseDelay * 0.1),
        );
        dueAt = current.availableAt;
      } else {
        expect(current).toMatchObject({
          status: "DEAD",
          lastErrorCode: "TRANSPORT_REJECTED",
        });
      }
    }
    expect(transport.deliver).toHaveBeenCalledTimes(6);
  });

  it("reagenda indisponibilidade de revalidação sem enviar e encerra em DEAD", async () => {
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery()],
      accessResolver: () => {
        throw new Error("falha transitória de leitura");
      },
    });
    const transport = deliveredTransport();
    let dueAt = new Date(NOW);

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await processOperationalDeliveryBatch({
        store,
        transport,
        now: dueAt,
        jitter: () => 0,
      });
      const current = store.snapshot(1)!;
      expect(current.attemptCount).toBe(attempt);
      expect(current.lastErrorCode).toBe("ACCESS_REVALIDATION_UNAVAILABLE");
      if (attempt < 6) {
        expect(current.status).toBe("FAILED");
        dueAt = current.availableAt;
      } else {
        expect(current.status).toBe("DEAD");
      }
    }
    expect(transport.deliver).not.toHaveBeenCalled();
  });

  it("encerra em DEAD a sexta tentativa cujo lease expira", async () => {
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [
        delivery({
          status: "PROCESSING",
          attemptCount: 6,
          leaseUntil: new Date(NOW.getTime() - 1),
          lastErrorCode: null,
        }),
      ],
    });

    await expect(
      store.claimNext({ now: NOW, leaseMs: 1_000 }),
    ).resolves.toBeNull();
    expect(store.snapshot(1)).toMatchObject({
      status: "DEAD",
      attemptCount: 6,
      lastErrorCode: "LEASE_EXPIRED",
    });
  });

  it("calcula o jitter padrão de forma determinística e reprodutível", async () => {
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery()],
    });
    const claim = (await store.claimNext({ now: NOW, leaseMs: 1_000 }))!;
    expect(operationalDeliveryRetryDelayForClaim(claim)).toBe(
      operationalDeliveryRetryDelayForClaim(claim),
    );
  });

  it("mantém a chave idempotente opaca entre retries", async () => {
    const calls: { idempotencyKey: string }[] = [];
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery()],
    });
    const transport: OperationalDeliveryTransport = {
      deliver: vi.fn(async (request) => {
        calls.push({ idempotencyKey: request.idempotencyKey });
        return {
          state: "FAILED",
          retryable: true,
          code: "TRANSPORT_REJECTED",
        };
      }),
    };

    await processOperationalDeliveryBatch({
      store,
      transport,
      now: NOW,
      jitter: () => 0,
    });
    await processOperationalDeliveryBatch({
      store,
      transport,
      now: store.snapshot(1)!.availableAt,
      jitter: () => 0,
    });

    expect(calls).toEqual([
      {
        idempotencyKey: operationalDeliveryTransportIdempotencyKey(delivery()),
      },
      {
        idempotencyKey: operationalDeliveryTransportIdempotencyKey(delivery()),
      },
    ]);
  });

  it("revalida revogação antes de chamar transporte e marca SKIPPED", async () => {
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery()],
      accessResolver: () => ({
        state: "REVOKED",
        code: "RECIPIENT_ACCESS_REVOKED",
      }),
    });
    const transport = deliveredTransport();

    await expect(
      processOperationalDeliveryBatch({
        store,
        transport,
        now: NOW,
      }),
    ).resolves.toMatchObject({ claimed: 1, skipped: 1, delivered: 0 });
    expect(transport.deliver).not.toHaveBeenCalled();
    expect(store.snapshot(1)).toMatchObject({
      status: "SKIPPED",
      lastErrorCode: "RECIPIENT_ACCESS_REVOKED",
    });
  });

  it("não inicia transporte quando a renovação CAS do lease falha", async () => {
    const memory = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery()],
    });
    const store: OperationalDeliveryStore = {
      claimNext: memory.claimNext.bind(memory),
      renewClaimLease: async () => null,
      revalidateRecipientAccess: memory.revalidateRecipientAccess.bind(memory),
      applyTransition: memory.applyTransition.bind(memory),
    };
    const transport = deliveredTransport();

    await expect(
      processOperationalDeliveryBatch({
        store,
        transport,
        now: NOW,
      }),
    ).resolves.toMatchObject({ claimed: 1, claimLost: 1, delivered: 0 });
    expect(transport.deliver).not.toHaveBeenCalled();
    expect(memory.snapshot(1)).toMatchObject({ status: "PROCESSING" });
  });

  it("mantém observabilidade e contrato de transporte sem alvo ou conteúdo", async () => {
    const events: unknown[] = [];
    const transportCalls: unknown[] = [];
    const store = new InMemoryOperationalDeliveryStore({
      deliveries: [delivery()],
    });
    await processOperationalDeliveryBatch({
      store,
      transport: deliveredTransport(transportCalls),
      now: NOW,
      observability: {
        record: (event) => events.push(event),
      },
    });

    expect(transportCalls).toEqual([
      expect.objectContaining({
        deliveryId: 1,
        idempotencyKey: operationalDeliveryTransportIdempotencyKey(delivery()),
        operationalEventId: 101,
        institutionId: 9,
        channel: "PUSH",
        attempt: 1,
      }),
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("recipientReferenceId");
    expect(serialized).not.toMatch(/email|token|body|phi|idempotency|dedup/i);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "CLAIMED" }),
        expect.objectContaining({ kind: "DELIVERED" }),
      ]),
    );
  });
});
