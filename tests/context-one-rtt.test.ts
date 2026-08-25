import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { eq, inArray } from "drizzle-orm";
import {
  institutions,
  professionalInstitutions,
  professionals,
  users,
} from "../drizzle/schema";
import { createContext } from "../server/_core/context";
import {
  protectedProcedure,
  publicProcedure,
  router,
  sessionInstanceConstraintHttpStatus,
} from "../server/_core/trpc";
import { sdk } from "../server/_core/sdk";
import { sessionInstanceProof } from "../server/_core/session-instance";
import { getDb } from "../server/db";

const STAMP = Date.now();
const probeRouter = router({
  publicPing: publicProcedure.query(() => "pong"),
  protectedPing: protectedProcedure.query(({ ctx }) => ctx.institutionId),
});

type FixtureUser = {
  id: number;
  professionalId?: number;
  sessionVersion: number;
};

describe("contexto autenticado em uma ida ao banco", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionA: number;
  let institutionB: number;
  let inactiveInstitution: number;
  const createdUserIds: number[] = [];
  const createdProfessionalIds: number[] = [];
  const createdInstitutionIds: number[] = [];
  const fixture = new Map<string, FixtureUser>();

  async function createUser(
    kind: string,
    options: {
      approvalStatus?: "PENDING" | "APPROVED";
      mustChangePassword?: boolean;
      deletedAt?: Date;
      institutionIds?: number[];
      activeMembership?: boolean;
    } = {},
  ): Promise<FixtureUser> {
    const [insertedUser] = await db
      .insert(users)
      .values({
        name: `Context ${kind}`,
        email: `context-${kind}-${STAMP}@test.local`,
        role: "doctor",
        approvalStatus: options.approvalStatus ?? "APPROVED",
        mustChangePassword: options.mustChangePassword ?? false,
        sessionVersion: 7,
        deletedAt: options.deletedAt,
      })
      .$returningId();
    createdUserIds.push(insertedUser.id);

    let professionalId: number | undefined;
    if (options.institutionIds) {
      const [insertedProfessional] = await db
        .insert(professionals)
        .values({
          userId: insertedUser.id,
          name: `Context ${kind}`,
          role: "Médico",
          userRole: "USER",
        })
        .$returningId();
      professionalId = insertedProfessional.id;
      createdProfessionalIds.push(professionalId);
      await db.insert(professionalInstitutions).values(
        options.institutionIds.map((institutionId, index) => ({
          userId: insertedUser.id,
          professionalId: professionalId!,
          institutionId,
          roleInInstitution: "USER" as const,
          isPrimary: index === 0,
          active: options.activeMembership ?? true,
        })),
      );
    }

    const result = { id: insertedUser.id, professionalId, sessionVersion: 7 };
    fixture.set(kind, result);
    return result;
  }

  async function sessionToken(
    kind: string,
    sessionVersion?: number,
    sessionBindingVersion?: 1,
  ): Promise<string> {
    const current = fixture.get(kind)!;
    return sdk.signSession({
      userId: String(current.id),
      name: `Context ${kind}`,
      sessionVersion: sessionVersion ?? current.sessionVersion,
      sessionBindingVersion,
    });
  }

  function requestWith(headers: Record<string, string | string[] | undefined>) {
    return { headers } as any;
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const institutionRows = await db
      .insert(institutions)
      .values([
        {
          name: `Context A ${STAMP}`,
          cnpj: `${STAMP}51`.slice(-14).padStart(14, "0"),
          isActive: true,
        },
        {
          name: `Context B ${STAMP}`,
          cnpj: `${STAMP}52`.slice(-14).padStart(14, "0"),
          isActive: true,
        },
        {
          name: `Context inactive ${STAMP}`,
          cnpj: `${STAMP}53`.slice(-14).padStart(14, "0"),
          isActive: false,
        },
      ])
      .$returningId();
    [institutionA, institutionB, inactiveInstitution] = institutionRows.map(
      (row) => row.id,
    );
    createdInstitutionIds.push(institutionA, institutionB, inactiveInstitution);

    await createUser("active", {
      institutionIds: [institutionA, institutionB],
    });
    await createUser("orphan");
    await createUser("pending", {
      approvalStatus: "PENDING",
      institutionIds: [institutionA],
    });
    await createUser("inactive-pi", {
      institutionIds: [institutionA],
      activeMembership: false,
    });
    await createUser("inactive-institution", {
      institutionIds: [inactiveInstitution],
    });
    await createUser("must-change", {
      institutionIds: [institutionA],
      mustChangePassword: true,
    });
    await createUser("deleted", {
      institutionIds: [institutionA],
      deletedAt: new Date(),
    });

    const corrupt = await createUser("corrupt-pi", {
      institutionIds: [institutionA],
    });
    const foreign = await createUser("foreign-professional", {
      institutionIds: [institutionB],
    });
    await db
      .update(professionalInstitutions)
      .set({ professionalId: foreign.professionalId! })
      .where(eq(professionalInstitutions.userId, corrupt.id));
  });

  afterAll(async () => {
    if (createdUserIds.length === 0) return;
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.userId, createdUserIds));
    if (createdProfessionalIds.length > 0) {
      await db
        .delete(professionals)
        .where(inArray(professionals.id, createdProfessionalIds));
    }
    await db.delete(users).where(inArray(users.id, createdUserIds));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, createdInstitutionIds));
  });

  it.each(["cookie", "bearer"] as const)(
    "autentica por %s, seleciona tenant explícito e faz exatamente uma query",
    async (transport) => {
      const token = await sessionToken("active");
      const headers =
        transport === "cookie"
          ? { cookie: `session=${token}`, "x-tenant-id": String(institutionB) }
          : {
              authorization: `Bearer ${token}`,
              "x-tenant-id": String(institutionB),
            };
      const selectSpy = vi.spyOn(db, "select");
      try {
        const context = await createContext({
          req: requestWith(headers),
          res: {} as any,
        });
        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(context.user?.id).toBe(fixture.get("active")!.id);
        expect(context.institutionId).toBe(institutionB);
        expect(context.allowedInstitutionIds.sort()).toEqual(
          [institutionA, institutionB].sort(),
        );
        expect(context.tenantProfessionalId).toBe(
          fixture.get("active")!.professionalId,
        );
        expect(context.tenantResolutionError).toBeNull();
      } finally {
        selectSpy.mockRestore();
      }
    },
  );

  it("vincula a credencial ao expected-user canônico sem query adicional", async () => {
    const active = fixture.get("active")!;
    const foreign = fixture.get("foreign-professional")!;
    const token = await sessionToken("active");
    const selectSpy = vi.spyOn(db, "select");
    try {
      const matched = await createContext({
        req: requestWith({
          authorization: `Bearer ${token}`,
          "x-tenant-id": String(institutionA),
          "x-client-expected-user-id": String(active.id),
        }),
        res: {} as any,
      });
      expect(matched.user?.id).toBe(active.id);
      expect(matched.institutionId).toBe(institutionA);
      expect(selectSpy).toHaveBeenCalledTimes(1);

      selectSpy.mockClear();
      const divergent = await createContext({
        req: requestWith({
          authorization: `Bearer ${token}`,
          "x-tenant-id": String(institutionA),
          "x-client-expected-user-id": String(foreign.id),
        }),
        res: {} as any,
      });
      expect(divergent.user).toBeNull();
      expect(divergent.institutionId).toBeNull();
      expect(divergent.allowedInstitutionIds).toEqual([]);
      expect(selectSpy).toHaveBeenCalledTimes(1);
      await expect(
        probeRouter.createCaller(divergent).protectedPing(),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });

      for (const malformed of [
        "0",
        `0${active.id}`,
        ` ${active.id}`,
        `${active.id} `,
        [String(active.id)],
        "9007199254740992",
      ]) {
        selectSpy.mockClear();
        const malformedContext = await createContext({
          req: requestWith({
            authorization: `Bearer ${token}`,
            "x-tenant-id": String(institutionA),
            "x-client-expected-user-id": malformed,
          }),
          res: {} as any,
        });
        expect(malformedContext.user).toBeNull();
        expect(malformedContext.institutionId).toBeNull();
        expect(selectSpy).toHaveBeenCalledTimes(1);
      }
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("não cria contexto tRPC quando cookie S2 recebe proof S1 same-user", async () => {
    const firstToken = await sessionToken("active");
    const secondToken = await sessionToken("active");
    const active = fixture.get("active")!;
    expect(firstToken).not.toBe(secondToken);

    const matched = await createContext({
      req: requestWith({
        cookie: `session=${secondToken}`,
        "x-tenant-id": String(institutionA),
        "x-client-expected-user-id": String(active.id),
        "x-client-session-instance": sessionInstanceProof(secondToken),
      }),
      res: {} as any,
    });
    expect(matched.user?.id).toBe(active.id);

    await expect(
      sdk.authenticateRequest(
        requestWith({
          cookie: `session=${secondToken}`,
          "x-client-expected-user-id": String(active.id),
          "x-client-session-instance": sessionInstanceProof(firstToken),
        }),
      ),
    ).rejects.toMatchObject({ code: "SESSION_INSTANCE_MISMATCH" });

    for (const [invalidProof, expectedCode] of [
      [sessionInstanceProof(firstToken), "CONFLICT"],
      ["v1.invalid", "BAD_REQUEST"],
      [[sessionInstanceProof(secondToken)], "BAD_REQUEST"],
    ] as const) {
      const context = await createContext({
        req: requestWith({
          cookie: `session=${secondToken}`,
          "x-tenant-id": String(institutionA),
          "x-client-expected-user-id": String(active.id),
          "x-client-session-instance": invalidProof,
        }),
        res: {} as any,
      });
      expect(context.user).toBeNull();
      expect(context.institutionId).toBeNull();
      await expect(
        probeRouter.createCaller(context).protectedPing(),
      ).rejects.toMatchObject({ code: expectedCode });
    }
  });

  it("v1 cookie sem proof produz 428 no tRPC; proof exata e Bearer continuam válidos", async () => {
    const token = await sessionToken("active", undefined, 1);
    const active = fixture.get("active")!;
    const missing = await createContext({
      req: requestWith({
        cookie: `session=${token}`,
        "x-tenant-id": String(institutionA),
      }),
      res: {} as any,
    });
    expect(missing.user).toBeNull();
    expect(missing.sessionInstanceConstraintError).toMatchObject({
      code: "SESSION_INSTANCE_REQUIRED",
      status: 428,
    });
    await expect(
      sdk.authenticateRequest(requestWith({ cookie: `session=${token}` }), {
        allowSessionInstanceBootstrap: true,
      }),
    ).rejects.toMatchObject({ code: "SESSION_INSTANCE_REQUIRED" });
    await expect(
      probeRouter.createCaller(missing).protectedPing(),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const httpApp = express();
    httpApp.use(
      "/trpc",
      createExpressMiddleware({
        router: probeRouter,
        createContext,
        responseMeta({ errors }) {
          const status = sessionInstanceConstraintHttpStatus(errors);
          return status ? { status } : {};
        },
      }),
    );
    const blockedHttp = await request(httpApp)
      .get("/trpc/protectedPing")
      .set("Cookie", `session=${token}`)
      .set("x-tenant-id", String(institutionA));
    expect(blockedHttp.status).toBe(428);

    const [cookieContext, bearerContext] = await Promise.all([
      createContext({
        req: requestWith({
          cookie: `session=${token}`,
          "x-tenant-id": String(institutionA),
          "x-client-session-instance": sessionInstanceProof(token),
        }),
        res: {} as any,
      }),
      createContext({
        req: requestWith({
          authorization: `Bearer ${token}`,
          "x-tenant-id": String(institutionA),
        }),
        res: {} as any,
      }),
    ]);
    expect(cookieContext.user?.id).toBe(active.id);
    expect(bearerContext.user?.id).toBe(active.id);
  });

  it("falha de query na autenticação protegida permanece 503 no tRPC", async () => {
    const token = await sessionToken("active");
    const selectFailure = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("forced authentication query outage");
    });
    let context: Awaited<ReturnType<typeof createContext>>;
    try {
      context = await createContext({
        req: requestWith({
          authorization: `Bearer ${token}`,
          "x-tenant-id": String(institutionA),
        }),
        res: {} as any,
      });
    } finally {
      selectFailure.mockRestore();
    }

    expect(context.user).toBeNull();
    expect(context.authenticationInfrastructureError).toMatchObject({
      code: "AUTHENTICATION_INFRASTRUCTURE_UNAVAILABLE",
      status: 503,
    });
    const error = await probeRouter
      .createCaller(context)
      .protectedPing()
      .then(
        () => null,
        (caught) => caught,
      );
    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(sessionInstanceConstraintHttpStatus([error])).toBe(503);
  });

  it("proof/header em JWT legacy é só constraint e nunca promove a credencial", async () => {
    const token = await sessionToken("active");
    const req = requestWith({
      cookie: `session=${token}`,
      "x-client-session-instance": sessionInstanceProof(token),
      "x-client-session-protocol": "exact-v1",
    });
    await expect(sdk.authenticateRequest(req)).resolves.toMatchObject({
      id: fixture.get("active")!.id,
    });
    expect(sdk.sessionBindingVersionForAuthenticatedRequest(req)).toBeNull();
  });

  it("troca o tenant sem trocar a identidade profissional canônica", async () => {
    const token = await sessionToken("active");
    const [contextA, contextB] = await Promise.all(
      [institutionA, institutionB].map((institutionId) =>
        createContext({
          req: requestWith({
            authorization: `Bearer ${token}`,
            "x-tenant-id": String(institutionId),
          }),
          res: {} as any,
        }),
      ),
    );
    expect(contextA.institutionId).toBe(institutionA);
    expect(contextB.institutionId).toBe(institutionB);
    expect(contextA.tenantProfessionalId).toBe(
      fixture.get("active")!.professionalId,
    );
    expect(contextB.tenantProfessionalId).toBe(
      fixture.get("active")!.professionalId,
    );
  });

  it.each([
    ["orphan", "NO_ACTIVE_MEMBERSHIP"],
    ["pending", "NO_ACTIVE_MEMBERSHIP"],
    ["inactive-pi", "NO_ACTIVE_MEMBERSHIP"],
    ["inactive-institution", "NO_ACTIVE_MEMBERSHIP"],
    ["corrupt-pi", "NO_ACTIVE_MEMBERSHIP"],
  ] as const)(
    "mantém %s autenticado, mas sem autoridade de tenant",
    async (kind, errorCode) => {
      const token = await sessionToken(kind);
      const context = await createContext({
        req: requestWith({ authorization: `Bearer ${token}` }),
        res: {} as any,
      });
      expect(context.user?.id).toBe(fixture.get(kind)!.id);
      expect(context.institutionId).toBeNull();
      expect(context.allowedInstitutionIds).toEqual([]);
      expect(context.tenantResolutionError).toBe(errorCode);
    },
  );

  it.each([
    ["texto", "MALFORMED_TENANT_HEADER"],
    ["0", "MALFORMED_TENANT_HEADER"],
    [[String(institutionA)], "MALFORMED_TENANT_HEADER"],
    ["999999999", "TENANT_NOT_ALLOWED"],
  ] as const)(
    "header de tenant %j falha sem fallback",
    async (header, errorCode) => {
      const token = await sessionToken("active");
      const context = await createContext({
        req: requestWith({
          authorization: `Bearer ${token}`,
          "x-tenant-id": header,
        }),
        res: {} as any,
      });
      expect(context.user?.id).toBe(fixture.get("active")!.id);
      expect(context.institutionId).toBeNull();
      expect(context.allowedInstitutionIds).toEqual([]);
      expect(context.tenantResolutionError).toBe(errorCode);
    },
  );

  it("publicProcedure segue acessível e protected falha sem repetir query", async () => {
    const token = await sessionToken("active");
    const selectSpy = vi.spyOn(db, "select");
    try {
      const context = await createContext({
        req: requestWith({
          authorization: `Bearer ${token}`,
          "x-tenant-id": "inválido",
        }),
        res: {} as any,
      });
      expect(selectSpy).toHaveBeenCalledTimes(1);
      const caller = probeRouter.createCaller(context);
      await expect(caller.publicPing()).resolves.toBe("pong");
      await expect(caller.protectedPing()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Tenant informado é inválido",
      });
      expect(selectSpy).toHaveBeenCalledTimes(1);
    } finally {
      selectSpy.mockRestore();
    }
  });

  it.each([
    ["active", 6],
    ["must-change", 7],
    ["deleted", 7],
  ] as const)(
    "rejeita sessão revogada ou identidade bloqueada: %s",
    async (kind, version) => {
      const token = await sessionToken(kind, version);
      const context = await createContext({
        req: requestWith({ authorization: `Bearer ${token}` }),
        res: {} as any,
      });
      expect(context.user).toBeNull();
      expect(context.institutionId).toBeNull();
    },
  );

  it("preserva o bypass de desenvolvimento com uma única query", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const selectSpy = vi.spyOn(db, "select");
    try {
      const context = await createContext({
        req: requestWith({
          "x-test-user-id": String(fixture.get("active")!.id),
          "x-tenant-id": String(institutionA),
        }),
        res: {} as any,
      });
      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(context.user?.id).toBe(fixture.get("active")!.id);
      expect(context.institutionId).toBe(institutionA);
    } finally {
      selectSpy.mockRestore();
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it.each(["NaN", "1.5", "-1", "9007199254740992"])(
    "ignora bypass de desenvolvimento inválido %s sem query extra",
    async (invalidTestUserId) => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const token = await sessionToken("active");
      const request = requestWith({
        authorization: `Bearer ${token}`,
        "x-test-user-id": invalidTestUserId,
        "x-tenant-id": String(institutionA),
      });
      const selectSpy = vi.spyOn(db, "select");
      try {
        const authenticatedUser = await sdk.authenticateRequest(request);
        expect(authenticatedUser.id).toBe(fixture.get("active")!.id);
        expect(selectSpy).toHaveBeenCalledTimes(1);

        selectSpy.mockClear();
        const context = await createContext({ req: request, res: {} as any });
        expect(context.user?.id).toBe(fixture.get("active")!.id);
        expect(context.institutionId).toBe(institutionA);
        expect(selectSpy).toHaveBeenCalledTimes(1);
      } finally {
        selectSpy.mockRestore();
        process.env.NODE_ENV = previousNodeEnv;
      }
    },
  );
});
