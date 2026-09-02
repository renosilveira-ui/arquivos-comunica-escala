import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPRESS_MUTATION_NOTIFICATION_TARGETS,
  MUTATION_NOTIFICATION_POLICIES,
  SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION,
  TRPC_MUTATION_NOTIFICATION_TARGETS,
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
  "notifications.acknowledgeAccountBadge",
  "profile.deactivateWhatsAppContact",
  "profile.setWhatsAppContact",
  "scheduleContexts.ensureDefaultSectorScale",
  "scheduleContexts.replaceSectorServiceSpecialties",
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
    expect(Object.keys(TRPC_MUTATION_NOTIFICATION_TARGETS).sort()).toEqual(
      expectedMutationPaths,
    );
    expect(
      verifyTrpcMutationPolicyInventory(
        serverSources,
        TRPC_MUTATION_NOTIFICATION_TARGETS,
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
    expect(Object.keys(EXPRESS_MUTATION_NOTIFICATION_TARGETS).sort()).toEqual(
      expectedExpressMutationEndpoints,
    );
    expect(
      verifyExpressMutationPolicyInventory(
        serverSources,
        EXPRESS_MUTATION_NOTIFICATION_TARGETS,
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

  it("falha para target inválido e para entrada de inventário sem mutation", () => {
    const sources = sourceFixture(`
      const fixtureRouter = router({
        write: protectedProcedure.mutation(async () => ({ ok: true })),
      });
      export const appRouter = router({ fixture: fixtureRouter });
    `);

    const violations = verifyTrpcMutationPolicyInventory(
      sources,
      {
        "fixture.obsolete": {
          targets: [
            {
              policy: "SILENT_AUDITED",
              when: "quando o fixture não existe",
              audience: [],
            },
          ],
        },
        "fixture.write": {
          targets: [{ policy: "UNCLASSIFIED", when: "sempre", audience: [] }],
        },
      },
      MUTATION_NOTIFICATION_POLICIES,
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_POLICY_TARGET" }),
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

  it("falha para target REST inválido ou obsoleto", () => {
    const sources = sourceFixture(`
      const fixtureRouter = Router();
      fixtureRouter.put("/write", () => undefined);
      const app = express();
      app.use("/api/fixture", fixtureRouter);
    `);

    const violations = verifyExpressMutationPolicyInventory(
      sources,
      {
        "PUT /api/fixture/obsolete": {
          targets: [
            {
              policy: "SILENT_AUDITED",
              when: "quando o fixture não existe",
              audience: [],
            },
          ],
        },
        "PUT /api/fixture/write": {
          targets: [{ policy: "UNCLASSIFIED", when: "sempre", audience: [] }],
        },
      },
      MUTATION_NOTIFICATION_POLICIES,
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_POLICY_TARGET" }),
        expect.objectContaining({ code: "UNUSED_EXPRESS_POLICY" }),
      ]),
    );
  });

  it("rejeita target sem condição ou audiência compatível com a política", () => {
    const sources = sourceFixture(`
      const fixtureRouter = router({
        write: protectedProcedure.mutation(async () => ({ ok: true })),
      });
      export const appRouter = router({ fixture: fixtureRouter });
    `);

    const violations = verifyTrpcMutationPolicyInventory(
      sources,
      {
        "fixture.write": {
          targets: [
            {
              policy: "NOTIFY",
              when: "",
              audience: [],
            },
            {
              policy: "SILENT_AUDITED",
              when: "quando não há destinatário",
              audience: ["SHOULD_NOT_EXIST"],
            },
          ],
        },
      },
      MUTATION_NOTIFICATION_POLICIES,
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_TARGET_CONDITION" }),
        expect.objectContaining({ code: "INVALID_TARGET_AUDIENCE" }),
      ]),
    );
  });

  it("preserva os ramos corporativos de impacto pessoal", () => {
    expect(TRPC_MUTATION_NOTIFICATION_TARGETS["editor.markVacant"]).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando remove uma ou mais alocações ativas ao marcar o plantão como vago",
          audience: ["AFFECTED_ASSIGNED_PROFESSIONALS"],
        },
        {
          policy: "SILENT_AUDITED",
          when: "quando marca como vago um plantão sem alocação ativa removida",
          audience: [],
        },
      ],
    });
    expect(
      TRPC_MUTATION_NOTIFICATION_TARGETS["shiftAssignments.assumeVacancy"],
    ).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando um profissional solicita uma vaga e a alocação pendente é criada",
          audience: ["RESPONSIBLE_MANAGERS"],
        },
      ],
    });
    expect(
      TRPC_MUTATION_NOTIFICATION_TARGETS["shiftInstances.approveAssignment"],
    ).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando a solicitação de vaga é aprovada",
          audience: ["REQUESTING_PROFESSIONAL"],
        },
      ],
    });
    expect(
      TRPC_MUTATION_NOTIFICATION_TARGETS["shiftInstances.rejectAssignment"],
    ).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando a solicitação de vaga é rejeitada",
          audience: ["REQUESTING_PROFESSIONAL"],
        },
      ],
    });
    expect(TRPC_MUTATION_NOTIFICATION_TARGETS["shifts.update"]).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando horário, modalidade ou local de um plantão com alocação ativa é alterado",
          audience: ["AFFECTED_ASSIGNED_PROFESSIONALS"],
        },
        {
          policy: "SILENT_AUDITED",
          when: "quando não há alocação ativa afetada por horário, modalidade ou local",
          audience: [],
        },
      ],
    });
    expect(TRPC_MUTATION_NOTIFICATION_TARGETS["shifts.publish"]).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando a publicação inclui uma ou mais alocações ativas; consolidar uma mensagem por profissional e ação",
          audience: ["ASSIGNED_PROFESSIONALS"],
        },
        {
          policy: "SILENT_AUDITED",
          when: "quando a publicação contém apenas calendário sem alocações ativas",
          audience: [],
        },
      ],
    });
    expect(TRPC_MUTATION_NOTIFICATION_TARGETS["shifts.replicateRange"]).toEqual(
      {
        targets: [
          {
            policy: "NOTIFY",
            when: "quando includeAssignments é verdadeiro e ao menos uma alocação é copiada; consolidar uma mensagem por profissional e ação",
            audience: ["ASSIGNED_PROFESSIONALS"],
          },
          {
            policy: "SILENT_AUDITED",
            when: "quando é dry-run, não copia alocações ou replica somente calendário",
            audience: [],
          },
        ],
      },
    );
    expect(TRPC_MUTATION_NOTIFICATION_TARGETS["swaps.offer"]).toEqual({
      targets: [
        {
          policy: "BROADCAST",
          when: "quando a oferta é aberta e não informa toProfessionalId",
          audience: ["ELIGIBLE_PROFESSIONALS"],
        },
        {
          policy: "NOTIFY",
          when: "quando a oferta é direcionada e informa toProfessionalId",
          audience: ["DIRECTED_SWAP_RECIPIENT"],
        },
      ],
    });
    expect(TRPC_MUTATION_NOTIFICATION_TARGETS["swaps.reject"]).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando a contraparte rejeita uma oferta direcionada",
          audience: ["SWAP_COUNTERPART"],
        },
        {
          policy: "SILENT_AUDITED",
          when: "quando um profissional apenas dispensa para si uma oferta aberta que continua disponível",
          audience: [],
        },
      ],
    });
    expect(TRPC_MUTATION_NOTIFICATION_TARGETS["swaps.cancel"]).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando o cancelamento atinge uma contraparte direcionada ou já aceita",
          audience: ["SWAP_COUNTERPART"],
        },
        {
          policy: "SILENT_AUDITED",
          when: "quando uma oferta aberta sem contraparte é cancelada",
          audience: [],
        },
      ],
    });
  });

  it("preserva os ramos de convite, criação e alteração de acesso", () => {
    expect(
      EXPRESS_MUTATION_NOTIFICATION_TARGETS[
        "POST /api/admin/pending-signups/:id/approve"
      ],
    ).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando a aprovação ativa a conta e o vínculo institucional pendentes",
          audience: ["PENDING_SIGNUP_USER"],
        },
      ],
    });
    expect(
      EXPRESS_MUTATION_NOTIFICATION_TARGETS[
        "POST /api/admin/pending-signups/:id/reject"
      ],
    ).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando a recusa remove o cadastro pendente; capturar o destinatário antes da remoção",
          audience: ["PENDING_SIGNUP_USER"],
        },
      ],
    });
    expect(
      EXPRESS_MUTATION_NOTIFICATION_TARGETS["POST /api/auth/register"],
    ).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando cria credenciais ou ativa vínculo e acesso institucional para a conta alvo",
          audience: ["TARGET_ACCOUNT_USER"],
        },
        {
          policy: "SILENT_AUDITED",
          when: "quando a tentativa não cria nem reativa acesso institucional",
          audience: [],
        },
      ],
    });
    expect(
      EXPRESS_MUTATION_NOTIFICATION_TARGETS["PUT /api/admin/users/:id"],
    ).toEqual({
      targets: [
        {
          policy: "NOTIFY",
          when: "quando muda roleInInstitution, managerScopes, schedule contexts, professional_access ou outra concessão ou revogação de acesso institucional",
          audience: ["TARGET_ACCOUNT_USER"],
        },
        {
          policy: "SILENT_AUDITED",
          when: "quando altera somente dados sem impacto no papel ou escopo institucional",
          audience: [],
        },
      ],
    });
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
