/**
 * Mutation proofs M1–M4 da verificação WhatsApp (Twilio Verify).
 * Aplica uma mutação cirúrgica, espera falha nos testes-alvo, restaura.
 *
 * Uso (local, DATABASE_URL unset):
 *   TEST_DATABASE_ALLOW_DESTRUCTIVE=1 \
 *   TEST_DATABASE_EXPECTED_NAME=escalas_test_wa_verify \
 *   TEST_DATABASE_DISPOSABLE_MARKER='<marcador de 32+ caracteres já preparado>' \
 *   TEST_DATABASE_URL=mysql://root:root@127.0.0.1:3306/escalas_test_wa_verify \
 *     pnpm exec tsx scripts/prove-whatsapp-verify-mutations.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const providerPath = resolve(
  root,
  "server/whatsapp-verification-provider.ts",
);
const servicePath = resolve(root, "server/whatsapp-verification.ts");
const domainPath = resolve(root, "server/user-contact-channels.ts");

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

const providerSrc = readFileSync(providerPath, "utf8");
const serviceSrc = readFileSync(servicePath, "utf8");
const domainSrc = readFileSync(domainPath, "utf8");

const proofs: Proof[] = [
  {
    id: "M1",
    test: "tests/whatsapp-verification.test.ts",
    filter: "V4 OTP inválido",
    changes: [
      {
        file: providerPath,
        original: providerSrc,
        mutated: replaceOnce(
          providerSrc,
          'return status === "approved";',
          "return typeof status === \"string\";",
        ),
      },
    ],
  },
  {
    id: "M2",
    test: "tests/whatsapp-verification.test.ts",
    filter: "V7 OTP de A não verifica B",
    changes: [
      {
        file: domainPath,
        original: domainSrc,
        mutated: replaceOnce(
          domainSrc,
          "eq(userContactChannels.normalizedAddress, expected.e164),\n        eq(userContactChannels.active, true),",
          "eq(userContactChannels.active, true),",
        ),
      },
    ],
  },
  {
    id: "M3",
    test: "tests/whatsapp-verification.test.ts",
    filter: "V7 OTP de A não verifica B",
    changes: [
      {
        file: servicePath,
        original: serviceSrc,
        mutated: replaceOnce(
          serviceSrc,
          "const channel = await getActiveWhatsAppChannelForUser(input.userId);\n  if (!channel) {\n    return fail(\"USER_ERROR\", \"NO_NUMBER\", { status: \"missing\" });\n  }\n  if (channel.verified) {",
          "const requested = (input as { phone?: string }).phone;\n  const channel = requested\n    ? { e164: requested, verified: false }\n    : await getActiveWhatsAppChannelForUser(input.userId);\n  if (!channel) {\n    return fail(\"USER_ERROR\", \"NO_NUMBER\", { status: \"missing\" });\n  }\n  if (channel.verified) {",
        ),
      },
    ],
  },
  {
    id: "M4",
    test: "tests/whatsapp-verification.test.ts",
    filter: "V1 informa número válido",
    changes: [
      {
        file: servicePath,
        original: serviceSrc,
        mutated: replaceOnce(
          serviceSrc,
          "if (saved.verified && channel.verified) {",
          "await markWhatsAppContactVerified({\n        userId: input.userId,\n        expectedE164: channel.e164,\n      });\n      if (saved.verified && channel.verified) {",
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
      console.error(`${proof.id} FAIL: mutation did not break ${proof.filter ?? proof.test}`);
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
  console.error("VERIFY_MUTATION_PROOFS=FAIL");
  process.exit(1);
}
console.log("VERIFY_MUTATION_PROOFS=PASS");
