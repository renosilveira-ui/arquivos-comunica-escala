/**
 * Mutation proofs MD1–MD3: diagnóstico seguro do Twilio Verify.
 * Aplica uma mutação cirúrgica, espera falha nos testes-alvo, restaura.
 *
 *   TEST_DATABASE_URL=mysql://root:root@127.0.0.1:3306/escalas_test \
 *     pnpm exec tsx scripts/prove-whatsapp-verify-diagnostic-mutations.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const adapterPath = resolve(
  root,
  "server/integrations/whatsapp/twilio-verify-provider.ts",
);
const servicePath = resolve(root, "server/whatsapp-verification.ts");

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
    throw new Error(`mutation target not found: ${from.slice(0, 120)}`);
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
    "mysql://root:root@127.0.0.1:3306/escalas_test";
  const args = ["exec", "vitest", "run", test, "--reporter=dot"];
  if (filter) args.push("-t", filter);
  const result = spawnSync("pnpm", args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}

const adapterSrc = readFileSync(adapterPath, "utf8");
const serviceSrc = readFileSync(servicePath, "utf8");

const proofs: Proof[] = [
  {
    id: "MD1",
    test: "tests/whatsapp-verification-provider.test.ts",
    filter: "D1 400/68008",
    changes: [
      {
        file: adapterPath,
        original: adapterSrc,
        mutated: replaceOnce(
          adapterSrc,
          "...(providerErrorCode !== undefined ? { providerErrorCode } : {}),",
          "",
        ),
      },
    ],
  },
  {
    id: "MD1-D6",
    test: "tests/whatsapp-verification.test.ts",
    filter: "D6 start failure log",
    changes: [
      {
        file: adapterPath,
        original: adapterSrc,
        mutated: replaceOnce(
          adapterSrc,
          "...(providerErrorCode !== undefined ? { providerErrorCode } : {}),",
          "",
        ),
      },
    ],
  },
  {
    id: "MD2",
    test: "tests/whatsapp-verification.test.ts",
    filter: "D6 start failure log",
    changes: [
      {
        file: adapterPath,
        original: adapterSrc,
        mutated: replaceOnce(
          replaceOnce(
            adapterSrc,
            'import twilio from "twilio";',
            'import twilio from "twilio";\nimport { logger } from "../../_core/logger";',
          ),
          "const mapped = mapTwilioVerifyError(error);",
          "logger.info({ message: (error as { message?: string }).message });\n  const mapped = mapTwilioVerifyError(error);",
        ),
      },
    ],
  },
  {
    id: "MD3",
    test: "tests/whatsapp-verification.test.ts",
    filter: "D8 resposta ao usuário",
    changes: [
      {
        file: servicePath,
        original: serviceSrc,
        mutated: replaceOnce(
          serviceSrc,
          "return fail(started.kind, started.code);",
          "return {\n      ...fail(started.kind, started.code),\n      providerErrorCode: started.diagnostics?.providerErrorCode,\n    };",
        ),
      },
    ],
  },
];

let failed = false;
for (const proof of proofs) {
  try {
    for (const change of proof.changes) {
      writeFileSync(change.file, change.mutated);
    }
    const result = runVitest(proof.test, proof.filter);
    if (result.ok) {
      failed = true;
      console.error(
        `${proof.id} FAIL: mutation did not break ${proof.filter ?? proof.test}`,
      );
      console.error(result.output.slice(-1500));
    } else {
      console.log(`${proof.id} PASS (tests failed as required)`);
    }
  } finally {
    for (const change of proof.changes) {
      writeFileSync(change.file, change.original);
    }
  }
}

if (failed) {
  console.error("VERIFY_DIAGNOSTIC_MUTATION_PROOFS=FAIL");
  process.exit(1);
}
console.log("VERIFY_DIAGNOSTIC_MUTATION_PROOFS=PASS");
