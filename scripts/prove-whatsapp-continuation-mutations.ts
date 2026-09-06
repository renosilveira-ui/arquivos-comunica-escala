/**
 * Mutation proofs M1–M5 + MF1–MF3 da continuação WhatsApp.
 * Aplica uma mutação cirúrgica, espera falha nos testes-alvo, restaura.
 *
 * Uso (local, DATABASE_URL unset):
 *   TEST_DATABASE_URL=mysql://root:root@127.0.0.1:3306/escalas_test_wa_cont \
 *     pnpm exec tsx scripts/prove-whatsapp-continuation-mutations.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const applyPath = resolve(
  root,
  "server/integrations/whatsapp/continuation-apply.ts",
);
const interpreterPath = resolve(
  root,
  "server/integrations/whatsapp/continuation-interpreter.ts",
);
const attachPath = resolve(
  root,
  "server/integrations/whatsapp/continuation-attach.ts",
);
const consumerPath = resolve(
  root,
  "server/integrations/whatsapp/continuation-consumer.ts",
);
const readyNlPath = resolve(
  root,
  "server/integrations/whatsapp/ready-for-nl-consumer.ts",
);

type FileChange = {
  file: string;
  original: string;
  mutated: string;
};

type Proof = {
  id: string;
  changes: FileChange[];
  test: string;
  filter?: string;
};

function replaceOnce(source: string, from: string, to: string): string {
  if (!source.includes(from)) {
    throw new Error(`mutation target not found: ${from.slice(0, 80)}`);
  }
  return source.replace(from, to);
}

function runVitest(test: string, filter?: string): { ok: boolean; output: string } {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.DATABASE_SSL;
  env.NODE_ENV = "test";
  env.TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    "mysql://root:root@127.0.0.1:3306/escalas_test_wa_cont";
  const args = ["exec", "vitest", "run", test, "--reporter=dot"];
  if (filter) {
    args.push("-t", filter);
  }
  const result = spawnSync("pnpm", args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}

const applySrc = readFileSync(applyPath, "utf8");
const interpreterSrc = readFileSync(interpreterPath, "utf8");
const attachSrc = readFileSync(attachPath, "utf8");
const consumerSrc = readFileSync(consumerPath, "utf8");
const readyNlSrc = readFileSync(readyNlPath, "utf8");

const originals = new Map<string, string>([
  [applyPath, applySrc],
  [interpreterPath, interpreterSrc],
  [attachPath, attachSrc],
  [consumerPath, consumerSrc],
  [readyNlPath, readyNlSrc],
]);

const proofs: Proof[] = [
  {
    id: "M1",
    changes: [
      {
        file: applyPath,
        original: applySrc,
        mutated: replaceOnce(
          replaceOnce(
            applySrc,
            "pending.stage !== expectedStage ||\n        pending.sourceInboundMessageId !== input.expectedSourceInboundMessageId",
            "pending.sourceInboundMessageId !== input.expectedSourceInboundMessageId",
          ),
          "eq(whatsappPendingIntents.stage, expectedStage), // CONTINUATION_STAGE_FENCE",
          "// MUTATED: stage fence removed",
        ),
      },
    ],
    test: "tests/whatsapp-continuation.test.ts",
    filter: "stage fence|T19 STATE_CHANGED_TRANSIENT",
  },
  {
    id: "M2",
    changes: [
      {
        file: applyPath,
        original: applySrc,
        mutated: replaceOnce(
          replaceOnce(
            applySrc,
            "eq(whatsappPendingIntents.userId, input.userId), // CONTINUATION_USER_OWNERSHIP",
            "// MUTATED: user ownership removed",
          ),
          `if (
        pending.userId !== input.userId ||
        child.userId !== input.userId
      ) {
        return fail("OWNERSHIP_MISMATCH", { pendingId: pending.id }, pending);
      }`,
          "// MUTATED: in-memory ownership removed",
        ),
      },
    ],
    test: "tests/whatsapp-continuation.test.ts",
    filter: "T7 apply recusa user_id divergente",
  },
  {
    id: "M3",
    changes: [
      {
        file: interpreterPath,
        original: interpreterSrc,
        mutated: replaceOnce(
          interpreterSrc,
          "if (/^\\d+$/.test(folded)) {\n    const position = Number(folded);\n    if (!Number.isSafeInteger(position) || position < 1) return null;\n    const choice = candidates[position - 1];\n    if (!choice) return null;\n    return { choice, position };\n  }",
          `if (/^\\d+$/.test(folded)) {
    const asId = Number(folded);
    const byId = candidates.find((candidate) =>
      "shiftInstanceId" in candidate && candidate.shiftInstanceId === asId,
    );
    if (byId) return { choice: byId, position: 1 };
    const position = asId;
    if (!Number.isSafeInteger(position) || position < 1) return null;
    const choice = candidates[position - 1];
    if (!choice) return null;
    return { choice, position };
  }`,
        ),
      },
    ],
    test: "tests/whatsapp-continuation-interpreter.test.ts",
    filter: "CONTINUATION_CHOICE_NEVER_INTERNAL_ID",
  },
  {
    id: "M4",
    changes: [
      {
        file: applyPath,
        original: applySrc,
        mutated: replaceOnce(
          applySrc,
          "requireOutcomeWrite(\n        await writeOutcome(tx, {\n          childId: child.id,\n          pendingId: pending.id,\n          userId: input.userId,\n          outcome: childOutcome,\n        }),\n      );",
          "const wrote = true; // MUTATED: skip CONTINUATION_PERSIST_OUTCOME",
        ),
      },
    ],
    test: "tests/whatsapp-continuation.test.ts",
    filter: "T15–T17 TTL",
  },
  {
    id: "M5",
    changes: [
      {
        file: applyPath,
        original: applySrc,
        mutated: replaceOnce(
          applySrc,
          `      if (
        pending.status !== WhatsAppPendingStatuses.OPEN ||
        pending.stage !== expectedStage ||
        pending.sourceInboundMessageId !== input.expectedSourceInboundMessageId
      ) {
        // CONTINUATION_NOOP_NOT_ON_STATE_CHANGED
        return fail("STATE_CHANGED", { pendingId: pending.id }, pending);
      }`,
          `      if (
        pending.status !== WhatsAppPendingStatuses.OPEN ||
        pending.stage !== expectedStage ||
        pending.sourceInboundMessageId !== input.expectedSourceInboundMessageId
      ) {
        const noop = await writeOutcome(tx, {
          childId: child.id,
          pendingId: pending.id,
          userId: input.userId,
          outcome: "NOOP",
        });
        if (!noop) return fail("PERSISTENCE_FAILED", {}, pending);
        return {
          ok: true,
          outcome: "NOOP",
          row: pending,
          childOutcome: "NOOP",
        };
      }`,
        ),
      },
    ],
    test: "tests/whatsapp-continuation.test.ts",
    filter: "T19 STATE_CHANGED_TRANSIENT",
  },
  {
    id: "MF1",
    changes: [
      {
        file: attachPath,
        original: attachSrc,
        mutated: replaceOnce(
          replaceOnce(
            attachSrc,
            `      // CONTINUATION_NO_NEW_ATTACH_WITHOUT_PAYLOAD
      if (
        !isWhatsAppInboundPayloadUsable(
          {
            contentKind: child.contentKind,
            operationalText: child.operationalText,
            mediaUrl: child.mediaUrl,
            payloadExpiresAt: child.payloadExpiresAt,
            payloadClearedAt: child.payloadClearedAt,
          },
          now,
        )
      ) {
        return fail("PAYLOAD_UNAVAILABLE", {
          pendingId: pending.id,
          childInboundId: child.id,
        });
      }

`,
            "",
          ),
          `            isNull(whatsappInboundMessages.continuationPendingId),
            isNull(whatsappInboundMessages.payloadClearedAt),
            isNotNull(whatsappInboundMessages.operationalText),
            or(
              isNull(whatsappInboundMessages.payloadExpiresAt),
              gt(whatsappInboundMessages.payloadExpiresAt, now),
            ),`,
          `            isNull(whatsappInboundMessages.continuationPendingId),`,
        ),
      },
    ],
    test: "tests/whatsapp-continuation.test.ts",
    filter: "F1-T1|F1-T2",
  },
  {
    id: "MF2",
    changes: [
      {
        file: consumerPath,
        original: consumerSrc,
        mutated: replaceOnce(
          consumerSrc,
          `  // CONTINUATION_FOUNDING_REQUIRES_PAYLOAD
  if (!input.payloadUsable || !input.text) {
    return blocked("SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE");
  }
`,
          "",
        ),
      },
      {
        file: readyNlPath,
        original: readyNlSrc,
        mutated: replaceOnce(
          readyNlSrc,
          `    // CONTINUATION_FOUNDING_REQUIRES_PAYLOAD
    if (!input.payloadUsable || !input.text) {
      return blocked("SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE");
    }
`,
          "",
        ),
      },
    ],
    test: "tests/whatsapp-continuation.test.ts",
    filter: "F2-T2 expired pending",
  },
  {
    id: "MF3",
    changes: [
      {
        file: applyPath,
        original: applySrc,
        mutated: replaceOnce(
          applySrc,
          `          eq(whatsappPendingIntents.stage, expectedStage), // CONTINUATION_STAGE_FENCE
          gt(whatsappPendingIntents.expiresAt, now),
          ...(input.generation
            ? [
                jsonGenerationEquals(
                  whatsappPendingIntents.parsedPayload,
                  input.generation.parsedPayload,
                ),
                jsonGenerationEquals(
                  whatsappPendingIntents.clarificationPayload,
                  input.generation.clarificationPayload,
                ),
              ]
            : []),`,
          `          eq(whatsappPendingIntents.stage, expectedStage), // CONTINUATION_STAGE_FENCE
          gt(whatsappPendingIntents.expiresAt, now),`,
        ),
      },
    ],
    test: "tests/whatsapp-continuation.test.ts",
    filter: "F3 same-stage CHOICE generation CAS",
  },
];

function restoreAll() {
  for (const [file, contents] of originals) {
    writeFileSync(file, contents);
  }
}

const failures: string[] = [];
try {
  for (const proof of proofs) {
    for (const change of proof.changes) {
      writeFileSync(change.file, change.mutated);
    }
    const ran = runVitest(proof.test, proof.filter);
    restoreAll();
    if (ran.ok) {
      failures.push(`${proof.id} expected tests to fail, but they passed`);
      console.error(`${proof.id} FAIL: tests still green after mutation`);
      console.error(ran.output.slice(-2000));
    } else {
      console.log(`${proof.id} PASS: mutated code failed tests as required`);
    }
  }
} finally {
  restoreAll();
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("WHATSAPP_CONTINUATION_MUTATION_PROOFS=PASS");
