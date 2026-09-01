import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MUTATION_NOTIFICATION_POLICIES,
  SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION,
  TRPC_MUTATION_NOTIFICATION_POLICIES,
} from "../server/mutation-notification-policy";
import {
  discoverTrpcMutations,
  inspectSsoOneTimeLaunchGet,
  readServerTypeScriptSources,
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

  it("documenta e limita a exceção GET que consome o código SSO de uso único", () => {
    expect(SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION).toMatchObject({
      id: "SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION",
      route: "GET /api/sso/launch",
    });

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
