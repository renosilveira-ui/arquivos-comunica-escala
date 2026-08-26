import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { TRPCError } from "@trpc/server";
import {
  getExpoPushReceipts,
  registerPushToken,
  sendPushNotification,
  unregisterPushToken,
} from "../server/notifications-service";
import {
  PushOwnershipLockTimeoutError,
  withPushAccountAndTokenMutex,
  withPushAccountAndTokenMutexes,
} from "../server/push-registration-revocation";

const dbModule = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("../server/db", () => ({
  getDb: dbModule.getDb,
}));

vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: (connection: { database: unknown }) => connection.database,
}));

type TokenFixture = {
  id: number;
  token: string;
  userId?: number;
  institutionId?: number;
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function receiptTarget(ticketId: string, pushTokenId: number, token = `token-${pushTokenId}`) {
  return {
    ticketId,
    pushTokenId,
    expectedUserId: 7,
    tokenFingerprint: createHash("sha256").update(token).digest("hex"),
  };
}

function serializedErrorLogs(): string {
  return vi.mocked(console.error).mock.calls
    .flat()
    .flatMap((value) => {
      const representations = [String(value)];
      if (value instanceof Error) {
        representations.push(value.message, value.stack ?? "");
      }
      try {
        representations.push(JSON.stringify(value));
      } catch {
        representations.push("[unserializable]");
      }
      return representations;
    })
    .join("\n");
}

function sqlBoundValues(statement: unknown): unknown[] {
  const chunks = (statement as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks.filter(
    (chunk) => typeof chunk === "string" || typeof chunk === "number",
  );
}

function database(
  tokens: TokenFixture[] = [],
  options: { ownershipRows?: TokenFixture[] } = {},
) {
  const normalized = tokens.map((token) => ({
    userId: 7,
    institutionId: 99,
    ...token,
  }));
  const normalizedOwnership = (options.ownershipRows ?? tokens).map((token) => ({
    userId: 7,
    institutionId: 99,
    ...token,
  }));
  const selection = (fields?: Record<string, unknown>) => {
    const rows = fields && "id" in fields && "userId" in fields && !("token" in fields)
      ? normalizedOwnership
      : normalized;
    const builder: any = {};
    builder.from = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.for = vi.fn(async () => rows);
    builder.then = (
      resolve: (value: typeof rows) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return builder;
  };
  const deleteWhere = vi.fn(async () => ({ affectedRows: 1 }));
  const db: any = {
    select: vi.fn(selection),
    delete: vi.fn(() => ({ where: deleteWhere })),
    execute: vi.fn(async () => [[{ acquired: 1, released: 1 }], []]),
  };
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  db.$client = {
    promise: () => ({
      getConnection: async () => ({ database: db, release: vi.fn(), destroy: vi.fn() }),
    }),
  };
  return { db, deleteWhere };
}

const payload = {
  title: "Confirmação de plantão",
  body: "Você confirma seu plantão?",
  data: { type: "duty_confirmation" },
};

describe("transporte tipado de push Expo", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("migração remove todo grupo ambíguo antes de fixar igualdade binária e UNIQUE", () => {
    const migration = readFileSync(
      new URL("../drizzle/migrations/manual/2026-08-24-push-token-provenance.sql", import.meta.url),
      "utf8",
    );
    const partition = migration.indexOf("COUNT(*) OVER (PARTITION BY token)");
    const deleteById = migration.indexOf(
      "duplicate_push_token_ids.id = push_tokens.id",
    );
    const deleteAmbiguous = migration.indexOf("DELETE push_tokens");
    const binary = migration.indexOf("COLLATE utf8mb4_bin");
    const unique = migration.indexOf("ADD UNIQUE INDEX uniq_push_token");
    expect(partition).toBeGreaterThanOrEqual(0);
    expect(deleteAmbiguous).toBeGreaterThan(partition);
    expect(deleteById).toBeGreaterThan(deleteAmbiguous);
    expect(migration).not.toContain("duplicate_push_token_values");
    expect(binary).toBeGreaterThan(deleteAmbiguous);
    expect(unique).toBeGreaterThan(binary);
  });

  it("mutex usa uma conexão e ordem global user → token → release reverso", async () => {
    const token = "ExponentPushToken[lock-order]";
    const expectedTokenLock = `escala-push-token:${createHash("sha256")
      .update(token)
      .digest("hex")
      .slice(0, 40)}`;
    const release = vi.fn();
    const destroy = vi.fn();
    const execute = vi.fn(async (statement: unknown) => {
      const isRelease = JSON.stringify(statement).includes("RELEASE_LOCK");
      return [[isRelease ? { released: 1 } : { acquired: 1 }], []];
    });
    const connectionDb: any = { execute };
    const getConnection = vi.fn(async () => ({ database: connectionDb, release, destroy }));
    const db: any = { $client: { promise: () => ({ getConnection }) } };
    let callbackDb: unknown;

    await expect(
      withPushAccountAndTokenMutex(db, 7, token, 3, async (lockedDb) => {
        callbackDb = lockedDb;
        return "ok";
      }),
    ).resolves.toBe("ok");

    expect(getConnection).toHaveBeenCalledTimes(1);
    expect(callbackDb).toBe(connectionDb);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls.map(([statement]) => sqlBoundValues(statement)[0])).toEqual([
      "escala-push-user:7",
      expectedTokenLock,
      expectedTokenLock,
      "escala-push-user:7",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("falha no segundo lock libera somente o lock de user já adquirido", async () => {
    const token = "ExponentPushToken[partial-lock]";
    const expectedTokenLock = `escala-push-token:${createHash("sha256")
      .update(token)
      .digest("hex")
      .slice(0, 40)}`;
    const release = vi.fn();
    const destroy = vi.fn();
    const callback = vi.fn();
    let call = 0;
    const execute = vi.fn(async () => {
      call += 1;
      if (call === 1) return [[{ acquired: 1 }], []];
      if (call === 2) return [[{ acquired: 0 }], []];
      return [[{ released: 1 }], []];
    });
    const connectionDb: any = { execute };
    const db: any = {
      $client: {
        promise: () => ({
          getConnection: async () => ({ database: connectionDb, release, destroy }),
        }),
      },
    };

    await expect(
      withPushAccountAndTokenMutex(db, 7, token, 3, callback),
    ).rejects.toBeInstanceOf(PushOwnershipLockTimeoutError);

    expect(callback).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([statement]) => sqlBoundValues(statement)[0])).toEqual([
      "escala-push-user:7",
      expectedTokenLock,
      "escala-push-user:7",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("replacement ordena e deduplica os dois token-locks na mesma conexão", async () => {
    const tokens = [
      "ExponentPushToken[z-previous]",
      "ExponentPushToken[a-current]",
      "ExponentPushToken[z-previous]",
    ];
    const expectedTokenLocks = [...new Set(tokens.map((token) => (
      `escala-push-token:${createHash("sha256")
        .update(token)
        .digest("hex")
        .slice(0, 40)}`
    )))].sort();
    const release = vi.fn();
    const execute = vi.fn(async (statement: unknown) => {
      const isRelease = JSON.stringify(statement).includes("RELEASE_LOCK");
      return [[isRelease ? { released: 1 } : { acquired: 1 }], []];
    });
    const connectionDb: any = { execute };
    const db: any = {
      $client: {
        promise: () => ({
          getConnection: async () => ({
            database: connectionDb,
            release,
            destroy: vi.fn(),
          }),
        }),
      },
    };

    await expect(
      withPushAccountAndTokenMutexes(db, 7, tokens, 3, async () => "ok"),
    ).resolves.toBe("ok");

    expect(execute.mock.calls.map(([statement]) => sqlBoundValues(statement)[0])).toEqual([
      "escala-push-user:7",
      ...expectedTokenLocks,
      ...[...expectedTokenLocks].reverse(),
      "escala-push-user:7",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("trata ticket ok com receipt id apenas como TICKET_ACCEPTED", async () => {
    const { db } = database([{ id: 11, token: "ExponentPushToken[ok]" }]);
    dbModule.getDb.mockResolvedValue(db);
    fetchMock.mockResolvedValue(response(200, { data: { status: "ok", id: "ticket-11" } }));

    const result = await sendPushNotification(7, payload, 99);

    expect(result).toMatchObject({
      status: "TICKETS_ACCEPTED",
      acceptedCount: 1,
      rejectedCount: 0,
      tickets: [{ state: "TICKET_ACCEPTED", pushTokenId: 11, ticketId: "ticket-11" }],
    });
    expect(result).not.toHaveProperty("success");
    expect(result.message).toContain("receipts pendentes");
  });

  it("HTTP 200 com ticket error é falha terminal e remove DeviceNotRegistered", async () => {
    const { db, deleteWhere } = database([{ id: 12, token: "ExponentPushToken[stale]" }]);
    dbModule.getDb.mockResolvedValue(db);
    fetchMock.mockResolvedValue(
      response(200, {
        data: {
          status: "error",
          message: "not registered",
          details: { error: "DeviceNotRegistered" },
        },
      }),
    );

    const result = await sendPushNotification(7, payload, 99);

    expect(result).toMatchObject({
      status: "ALL_TICKETS_REJECTED",
      tickets: [
        {
          state: "TICKET_REJECTED",
          pushTokenId: 12,
          retryability: "TERMINAL",
          failureKind: "PROVIDER_TICKET_ERROR",
          providerCode: "DeviceNotRegistered",
          tokenDisposition: "REMOVED",
        },
      ],
    });
    expect(result).not.toHaveProperty("success");
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("mantém ausência de token como estado explícito sem booleano de autoridade", async () => {
    const { db } = database();
    dbModule.getDb.mockResolvedValue(db);

    const result = await sendPushNotification(7, payload, 99);

    expect(result).toMatchObject({
      status: "NO_REGISTERED_TOKENS",
      tickets: [],
      acceptedCount: 0,
      rejectedCount: 0,
    });
    expect(result).not.toHaveProperty("success");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ticket ok sem receipt id é resposta malformada terminal", async () => {
    const { db } = database([{ id: 13, token: "ExponentPushToken[missing-id]" }]);
    dbModule.getDb.mockResolvedValue(db);
    fetchMock.mockResolvedValue(response(200, { data: { status: "ok" } }));

    const result = await sendPushNotification(7, payload, 99);

    expect(result).toMatchObject({
      status: "ALL_TICKETS_REJECTED",
      tickets: [
        {
          state: "TICKET_REJECTED",
          retryability: "TERMINAL",
          failureKind: "MALFORMED_RESPONSE",
        },
      ],
    });
  });

  it.each([
    [408, "RETRYABLE"],
    [425, "RETRYABLE"],
    [429, "RETRYABLE"],
    [503, "RETRYABLE"],
    [400, "TERMINAL"],
  ] as const)("classifica HTTP %s como %s", async (status, retryability) => {
    const { db } = database([{ id: 14, token: "ExponentPushToken[http]" }]);
    dbModule.getDb.mockResolvedValue(db);
    fetchMock.mockResolvedValue(
      response(status, { errors: [{ code: "PROVIDER_ERROR", message: "provider failed" }] }),
    );

    const result = await sendPushNotification(7, payload, 99);

    expect(result.tickets[0]).toMatchObject({
      state: "TICKET_REJECTED",
      failureKind: "HTTP_ERROR",
      httpStatus: status,
      retryability,
    });
    expect(JSON.stringify(result)).not.toContain("provider failed");
  });

  it("classifica falha de rede como retryable", async () => {
    const { db } = database([{ id: 15, token: "ExponentPushToken[network]" }]);
    dbModule.getDb.mockResolvedValue(db);
    fetchMock.mockRejectedValue(new Error("network down"));

    const result = await sendPushNotification(7, payload, 99);

    expect(result.tickets[0]).toMatchObject({
      state: "TICKET_REJECTED",
      retryability: "RETRYABLE",
      failureKind: "NETWORK_ERROR",
      message: "Falha temporária ao contatar Expo Push",
    });
    expect(JSON.stringify(result)).not.toContain("network down");
  });

  it.each([
    {
      label: "rejeição canônica",
      failure: new TRPCError({ code: "FORBIDDEN", message: "revoked sentinel" }),
      retryability: "TERMINAL",
      failureKind: "RECIPIENT_AUTHORITY_REVOKED",
    },
    {
      label: "falha genérica de infraestrutura",
      failure: new DrizzleQueryError(
        "select authority where confirmation_token = ?",
        ["DRIZZLE_GUARD_CONFIRMATION_TOKEN_SENTINEL"],
        new Error("DRIZZLE_GUARD_CONFIRMATION_TOKEN_SENTINEL"),
      ),
      retryability: "RETRYABLE",
      failureKind: "NETWORK_ERROR",
    },
  ])("submissionGuard: $label não toca no Expo e preserva a classe", async ({
    failure,
    retryability,
    failureKind,
  }) => {
    const { db } = database([{ id: 151, token: "ExponentPushToken[guard]" }]);
    dbModule.getDb.mockResolvedValue(db);

    const result = await sendPushNotification(
      7,
      payload,
      99,
      async () => { throw failure; },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.tickets[0]).toMatchObject({
      state: "TICKET_REJECTED",
      retryability,
      failureKind,
    });
    const serialized = `${JSON.stringify(result)}\n${serializedErrorLogs()}`;
    expect(serialized).not.toContain("DRIZZLE_GUARD_CONFIRMATION_TOKEN_SENTINEL");
    expect(serialized).not.toContain("revoked sentinel");
  });

  it("expõe aceitação parcial por token sem projetar entrega", async () => {
    const { db } = database([
      { id: 16, token: "ExponentPushToken[first]" },
      { id: 17, token: "ExponentPushToken[second]" },
    ]);
    dbModule.getDb.mockResolvedValue(db);
    fetchMock
      .mockResolvedValueOnce(response(200, { data: { status: "ok", id: "ticket-16" } }))
      .mockResolvedValueOnce(
        response(200, {
          data: { status: "error", message: "bad payload", details: { error: "MessageTooBig" } },
        }),
      );

    const result = await sendPushNotification(7, payload, 99);

    expect(result).toMatchObject({
      status: "PARTIAL_TICKET_ACCEPTANCE",
      acceptedCount: 1,
      rejectedCount: 1,
    });
    expect(result.tickets.map((ticket) => ticket.state)).toEqual([
      "TICKET_ACCEPTED",
      "TICKET_REJECTED",
    ]);
  });

  it("falha fechado quando o mesmo token possui ownership concorrente", async () => {
    const token = { id: 18, token: "ExponentPushToken[ambiguous]" };
    const { db } = database([token], {
      // A seleção inicial pertence a U=7; no claim sob mutex o mesmo row já
      // foi reassociado a V=8. O fetch não pode usar o snapshot stale.
      ownershipRows: [{ ...token, userId: 8, institutionId: 100 }],
    });
    dbModule.getDb.mockResolvedValue(db);

    const result = await sendPushNotification(7, payload, 99);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "ALL_TICKETS_REJECTED",
      tickets: [{
        state: "TICKET_REJECTED",
        failureKind: "TOKEN_OWNERSHIP_CHANGED",
        retryability: "TERMINAL",
      }],
    });
  });

  it("trata institutionId do token somente como proveniência", async () => {
    const { db } = database([{
      id: 20,
      token: "ExponentPushToken[cross-tenant-provenance]",
      institutionId: 41,
    }]);
    dbModule.getDb.mockResolvedValue(db);
    fetchMock.mockResolvedValue(
      response(200, { data: { status: "ok", id: "ticket-cross-tenant" } }),
    );

    const result = await sendPushNotification(7, payload, 99);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "TICKETS_ACCEPTED",
      tickets: [{ pushTokenId: 20, state: "TICKET_ACCEPTED" }],
    });
  });

  it("sanitiza DrizzleQueryError no registro sem logar nem devolver o token", async () => {
    const token = "ExponentPushToken[REGISTER_SECRET_SENTINEL]";
    const previousToken = "ExponentPushToken[PREVIOUS_SECRET_SENTINEL]";
    const { db } = database();
    db.transaction.mockRejectedValueOnce(
      new DrizzleQueryError(
        "insert into push_tokens (token) values (?)",
        [token],
        new Error(`driver rejected ${token}`),
      ),
    );
    dbModule.getDb.mockResolvedValue(db);

    await expect(registerPushToken(7, token, "ios", 99, 1, previousToken)).resolves.toEqual({
      success: false,
      message: "Não foi possível registrar o token",
    });

    expect(console.error).toHaveBeenCalledWith("[Notifications] PUSH_TOKEN_REGISTER_FAILED");
    expect(serializedErrorLogs()).not.toContain(token);
    expect(serializedErrorLogs()).not.toContain(previousToken);
  });

  it("serviço rejeita whitespace antes de consultar DB ou adquirir mutex", async () => {
    const token = "ExponentPushToken[whitespace] ";
    const validToken = "ExponentPushToken[current]";

    await expect(registerPushToken(7, token, "ios", null, 1)).resolves.toEqual({
      success: false,
      message: "Push token inválido",
    });
    await expect(unregisterPushToken(7, token, 1)).resolves.toEqual({ success: false });
    await expect(
      registerPushToken(7, validToken, "ios", null, 1, token),
    ).resolves.toEqual({ success: false, message: "Push token inválido" });

    expect(dbModule.getDb).not.toHaveBeenCalled();
  });

  it("sanitiza DrizzleQueryError no desregistro sem logar o token", async () => {
    const token = "ExponentPushToken[UNREGISTER_SECRET_SENTINEL]";
    const { db } = database();
    db.transaction.mockRejectedValueOnce(
      new DrizzleQueryError(
        "delete from push_tokens where token = ?",
        [token],
        new Error(`driver rejected ${token}`),
      ),
    );
    dbModule.getDb.mockResolvedValue(db);

    await expect(unregisterPushToken(7, token, 1)).resolves.toEqual({ success: false });

    expect(console.error).toHaveBeenCalledWith("[Notifications] PUSH_TOKEN_UNREGISTER_FAILED");
    expect(serializedErrorLogs()).not.toContain(token);
  });

  it("consulta receipts tipados e remove token rejeitado pelo provider", async () => {
    const { db, deleteWhere } = database();
    dbModule.getDb.mockResolvedValue(db);
    fetchMock.mockResolvedValue(
      response(200, {
        data: {
          "ticket-ok": { status: "ok" },
          "ticket-stale": {
            status: "error",
            message: "device gone",
            details: { error: "DeviceNotRegistered" },
          },
        },
      }),
    );

    const receipts = await getExpoPushReceipts([
      receiptTarget("ticket-ok", 21),
      receiptTarget("ticket-stale", 22),
      receiptTarget("ticket-pending", 23),
    ]);

    expect(receipts).toEqual([
      { state: "PROVIDER_ACCEPTED", ticketId: "ticket-ok", pushTokenId: 21 },
      {
        state: "RECEIPT_REJECTED",
        ticketId: "ticket-stale",
        pushTokenId: 22,
        retryability: "TERMINAL",
        message: "Expo retornou receipt com erro",
        providerCode: "DeviceNotRegistered",
        tokenDisposition: "REMOVED",
      },
      { state: "RECEIPT_PENDING", ticketId: "ticket-pending", pushTokenId: 23 },
    ]);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    const deletePredicate = new MySqlDialect().sqlToQuery(deleteWhere.mock.calls[0]![0]);
    expect(deletePredicate).toEqual(expect.objectContaining({
      sql: "(`push_tokens`.`id` = ? and `push_tokens`.`user_id` = ? and SHA2(`push_tokens`.`token`, 256) = ?)",
      params: [
        22,
        7,
        createHash("sha256").update("token-22").digest("hex"),
      ],
    }));
    expect(JSON.stringify(receipts)).not.toContain("device gone");
  });

  it("classifica falha HTTP e de rede na consulta de receipts", async () => {
    const { db } = database();
    dbModule.getDb.mockResolvedValue(db);
    fetchMock.mockResolvedValueOnce(response(500, { errors: [{ message: "down" }] }));

    await expect(
      getExpoPushReceipts([receiptTarget("ticket-http", 31)]),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "RECEIPT_LOOKUP_FAILED",
        retryability: "RETRYABLE",
        failureKind: "HTTP_ERROR",
        httpStatus: 500,
      }),
    ]);

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      getExpoPushReceipts([receiptTarget("ticket-network", 32)]),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "RECEIPT_LOOKUP_FAILED",
        retryability: "RETRYABLE",
        failureKind: "NETWORK_ERROR",
      }),
    ]);
  });

  it("aplica deadline AbortSignal tanto no ticket quanto no receipt", async () => {
    const { db } = database([{ id: 41, token: "ExponentPushToken[timeout]" }]);
    dbModule.getDb.mockResolvedValue(db);
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    fetchMock
      .mockResolvedValueOnce(response(200, { data: { status: "ok", id: "ticket-timeout" } }))
      .mockResolvedValueOnce(response(200, { data: { "ticket-timeout": { status: "ok" } } }));

    try {
      await sendPushNotification(7, payload, 99);
      await getExpoPushReceipts([receiptTarget("ticket-timeout", 41)]);

      expect(timeoutSpy).toHaveBeenNthCalledWith(1, 15_000);
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, 15_000);
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
      expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBe(controller.signal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
