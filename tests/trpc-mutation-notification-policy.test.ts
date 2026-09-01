import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPRESS_MUTATION_NOTIFICATION_POLICIES,
  MUTATION_NOTIFICATION_POLICIES,
  SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION,
  TRPC_MUTATION_NOTIFICATION_POLICIES,
} from "../server/mutation-notification-policy";
import {
  discoverExpressMutationEndpoints,
  discoverExpressRouterMounts,
  discoverTrpcMutations,
  inspectSsoOneTimeLaunchGet,
  readServerTypeScriptSources,
  verifyExpressMutationPolicyInventory,
  verifyTrpcMutationPolicyInventory,
  type SourceInput,
} from "./helpers/trpc-mutation-notification-contract";

const serverSources = readServerTypeScriptSources();
const expectedMutationPaths = [
  "confirmations.acceptNomination",
  "confirmations.confirm",
  "confirmations.decline",
  "confirmations.declineNomination",
  "confirmations.nominateReplacement",
  "confirmations.registerPushToken",
  "confirmations.unregisterPushToken",
  "editor.assignDirect",
  "editor.markVacant",
  "editor.unassignDirect",
  "hospitals.create",
  "profile.deactivateWhatsAppContact",
  "profile.setWhatsAppContact",
  "scheduleContexts.ensureDefaultSectorScale",
  "scheduleInvites.create",
  "scheduleInvites.revoke",
  "shiftAssignments.assumeVacancy",
  "shiftInstances.approveAssignment",
  "shiftInstances.rejectAssignment",
  "shifts.create",
  "shifts.lock",
  "shifts.notifyVacancy",
  "shifts.openMonthShifts",
  "shifts.publish",
  "shifts.replicateMonthCalendar",
  "shifts.replicateRange",
  "shifts.replicateWeek",
  "shifts.update",
  "swaps.accept",
  "swaps.approve",
  "swaps.approveByOwner",
  "swaps.cancel",
  "swaps.offer",
  "swaps.reject",
  "swaps.rejectByManager",
  "voice.interpret",
];

const expectedExpressMutationEndpoints = [
  "DELETE /api/admin/users/:id",
  "DELETE /api/auth/me",
  "POST /.well-known/generate",
  "POST /.well-known/launch-code",
  "POST /api/admin/pending-signups/:id/approve",
  "POST /api/admin/pending-signups/:id/reject",
  "POST /api/admin/users/:id/reset-password",
  "POST /api/auth/change-password",
  "POST /api/auth/decline-invite",
  "POST /api/auth/forgot-password",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/redeem-invite",
  "POST /api/auth/register",
  "POST /api/auth/reset-password",
  "POST /api/auth/signup",
  "POST /api/auth/sso-exchange",
  "POST /api/auth/ssoExchange",
  "POST /api/integrations/hospital-alert/shifts/end",
  "POST /api/integrations/hospital-alert/shifts/start",
  "POST /api/integrations/hospital-alert/sync-user",
  "POST /api/sso/generate",
  "POST /api/sso/launch-code",
  "PUT /api/admin/users/:id",
];

function sourceFixture(text: string): SourceInput[] {
  return [
    {
      path: "server/fixture.ts",
      text,
    },
  ];
}

describe("contrato corporativo — políticas de notificação das mutations tRPC", () => {
  it("inventaria e classifica toda mutation montada no appRouter", () => {
    const discovered = discoverTrpcMutations(serverSources);
    expect(discovered.violations).toEqual([]);
    expect(discovered.declarations.map((entry) => entry.path).sort()).toEqual(
      expectedMutationPaths,
    );
    expect(Object.keys(TRPC_MUTATION_NOTIFICATION_POLICIES).sort()).toEqual(
      expectedMutationPaths,
    );
    expect(
      verifyTrpcMutationPolicyInventory(
        serverSources,
        TRPC_MUTATION_NOTIFICATION_POLICIES,
        MUTATION_NOTIFICATION_POLICIES,
      ),
    ).toEqual([]);
  });

  it("inventaria e classifica toda rota Express mutável montada externamente", () => {
    const discovered = discoverExpressMutationEndpoints(serverSources);
    expect(discovered.violations).toEqual([]);
    expect(
      discovered.declarations.map((entry) => entry.endpoint).sort(),
    ).toEqual(expectedExpressMutationEndpoints);
    expect(Object.keys(EXPRESS_MUTATION_NOTIFICATION_POLICIES).sort()).toEqual(
      expectedExpressMutationEndpoints,
    );
    expect(
      verifyExpressMutationPolicyInventory(
        serverSources,
        EXPRESS_MUTATION_NOTIFICATION_POLICIES,
        MUTATION_NOTIFICATION_POLICIES,
      ),
    ).toEqual([]);
  });

  it("falha se uma nova mutation tRPC não entrar no inventário", () => {
    const sources = sourceFixture(`
      const fixtureRouter = router({
        write: protectedProcedure.mutation(async () => ({ ok: true })),
      });
      export const appRouter = router({ fixture: fixtureRouter });
    `);

    expect(
      verifyTrpcMutationPolicyInventory(
        sources,
        {},
        MUTATION_NOTIFICATION_POLICIES,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "MISSING_POLICY",
        message: expect.stringContaining("fixture.write"),
      }),
    ]);
  });

  it("falha para política inválida e para entrada de inventário sem mutation", () => {
    const sources = sourceFixture(`
      const fixtureRouter = router({
        write: protectedProcedure.mutation(async () => ({ ok: true })),
      });
      export const appRouter = router({ fixture: fixtureRouter });
    `);

    const violations = verifyTrpcMutationPolicyInventory(
      sources,
      {
        "fixture.obsolete": "SILENT_AUDITED",
        "fixture.write": "UNCLASSIFIED",
      },
      MUTATION_NOTIFICATION_POLICIES,
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_POLICY" }),
        expect.objectContaining({ code: "UNUSED_POLICY" }),
      ]),
    );
  });

  it("falha se uma nova rota Express mutável não entrar no inventário", () => {
    const sources = sourceFixture(`
      const fixtureRouter = Router();
      fixtureRouter.post("/write", () => undefined);
      const app = express();
      app.use("/api/fixture", fixtureRouter);
    `);

    expect(
      verifyExpressMutationPolicyInventory(
        sources,
        {},
        MUTATION_NOTIFICATION_POLICIES,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "MISSING_EXPRESS_POLICY",
        message: expect.stringContaining("POST /api/fixture/write"),
      }),
    ]);
  });

  it("falha para política REST inválida ou obsoleta", () => {
    const sources = sourceFixture(`
      const fixtureRouter = Router();
      fixtureRouter.put("/write", () => undefined);
      const app = express();
      app.use("/api/fixture", fixtureRouter);
    `);

    const violations = verifyExpressMutationPolicyInventory(
      sources,
      {
        "PUT /api/fixture/obsolete": "SILENT_AUDITED",
        "PUT /api/fixture/write": "UNCLASSIFIED",
      },
      MUTATION_NOTIFICATION_POLICIES,
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_POLICY" }),
        expect.objectContaining({ code: "UNUSED_EXPRESS_POLICY" }),
      ]),
    );
  });

  it("rejeita aliases e acessos computados que esconderiam uma mutation da AST", () => {
    const aliased = sourceFixture(`
      const fixtureRouter = router({
        write: protectedProcedure.mutation(async () => ({ ok: true })),
      });
      const alias = protectedProcedure.mutation;
      export const appRouter = router({ fixture: fixtureRouter });
    `);
    const computed = sourceFixture(`
      const fixtureRouter = router({
        write: protectedProcedure["mutation"](async () => ({ ok: true })),
      });
      export const appRouter = router({ fixture: fixtureRouter });
    `);

    expect(discoverTrpcMutations(aliased).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ESCAPED_MUTATION_MEMBER" }),
      ]),
    );
    expect(discoverTrpcMutations(computed).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "COMPUTED_MUTATION_MEMBER" }),
      ]),
    );
  });

  it("rejeita aliases, acesso computado e router REST sem mount", () => {
    const aliased = sourceFixture(`
      const fixtureRouter = Router();
      const write = fixtureRouter.post;
      const app = express();
      app.use("/api/fixture", fixtureRouter);
    `);
    const computed = sourceFixture(`
      const fixtureRouter = Router();
      fixtureRouter["post"]("/write", () => undefined);
      const app = express();
      app.use("/api/fixture", fixtureRouter);
    `);
    const unmounted = sourceFixture(`
      const fixtureRouter = Router();
      fixtureRouter.delete("/write", () => undefined);
    `);
    const routeBuilder = sourceFixture(`
      const fixtureRouter = Router();
      fixtureRouter.route("/write").patch(() => undefined);
      const app = express();
      app.use("/api/fixture", fixtureRouter);
    `);
    const dynamicMount = sourceFixture(`
      const fixtureRouter = Router();
      fixtureRouter.post("/write", () => undefined);
      const app = express();
      app.use(process.env.PREFIX, fixtureRouter);
    `);

    expect(discoverExpressMutationEndpoints(aliased).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ESCAPED_EXPRESS_METHOD" }),
      ]),
    );
    expect(discoverExpressMutationEndpoints(computed).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "COMPUTED_EXPRESS_METHOD" }),
      ]),
    );
    expect(discoverExpressMutationEndpoints(unmounted).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNMOUNTED_EXPRESS_ROUTER" }),
      ]),
    );
    expect(discoverExpressMutationEndpoints(routeBuilder).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNSUPPORTED_EXPRESS_ROUTE_STYLE" }),
      ]),
    );
    expect(discoverExpressMutationEndpoints(dynamicMount).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNPARSEABLE_EXPRESS_MOUNT" }),
      ]),
    );
  });

  it("mantém queries fora do contrato de mutation e não as transforma em escrita", () => {
    const sources = sourceFixture(`
      const fixtureRouter = router({
        read: protectedProcedure.query(async () => ({ ok: true })),
      });
      export const appRouter = router({ fixture: fixtureRouter });
    `);

    expect(discoverTrpcMutations(sources)).toEqual({
      declarations: [],
      violations: [],
    });
    expect(
      verifyTrpcMutationPolicyInventory(
        sources,
        {},
        MUTATION_NOTIFICATION_POLICIES,
      ),
    ).toEqual([]);
  });

  it("mantém GETs Express fora do inventário de mutações", () => {
    const sources = sourceFixture(`
      const fixtureRouter = Router();
      fixtureRouter.get("/read", () => undefined);
      fixtureRouter["get"]("/computed-read", () => undefined);
      fixtureRouter.route("/builder-read").get(() => undefined);
      const app = express();
      app.use("/api/fixture", fixtureRouter);
    `);

    expect(discoverExpressMutationEndpoints(sources)).toEqual({
      declarations: [],
      violations: [],
    });
    expect(
      verifyExpressMutationPolicyInventory(
        sources,
        {},
        MUTATION_NOTIFICATION_POLICIES,
      ),
    ).toEqual([]);
  });

  it("segue uma app Express entregue a um registrador de rotas estático", () => {
    const sources: SourceInput[] = [
      {
        path: "server/_core/oauth.ts",
        text: `
          export function registerOAuthRoutes(_app: Express): void {
            _app.post("/api/oauth/callback", () => undefined);
          }
        `,
      },
      {
        path: "server/_core/index.ts",
        text: `
          const app = express();
          registerOAuthRoutes(app);
        `,
      },
    ];

    expect(discoverExpressMutationEndpoints(sources)).toMatchObject({
      declarations: [
        expect.objectContaining({ endpoint: "POST /api/oauth/callback" }),
      ],
      violations: [],
    });
  });

  it("documenta e limita a exceção GET que consome o código SSO de uso único", () => {
    expect(SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION).toMatchObject({
      id: "SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION",
      routes: ["GET /.well-known/launch", "GET /api/sso/launch"],
    });

    expect(
      discoverExpressRouterMounts(serverSources)
        .mounts.filter((mount) => mount.routerName === "ssoRouter")
        .map((mount) => mount.mountPath)
        .sort(),
    ).toEqual(["/.well-known", "/api/sso"]);

    const source = readFileSync("server/sso/router.ts", "utf8");
    expect(inspectSsoOneTimeLaunchGet(source)).toEqual({
      launchHandlers: 1,
      redeemCalls: 1,
    });

    expect(
      inspectSsoOneTimeLaunchGet(
        'ssoRouter.get("/launch", async (_req, res) => res.send("ok"));',
      ),
    ).toEqual({ launchHandlers: 1, redeemCalls: 0 });
  });
});
