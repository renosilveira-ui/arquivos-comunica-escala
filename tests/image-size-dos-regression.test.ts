import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const projectRequire = createRequire(import.meta.url);
const metroEntry = projectRequire.resolve("metro");
const imageSizeEntry = createRequire(metroEntry).resolve("image-size");

const CHILD_SCRIPT = `
const { imageSize } = require(process.argv[1]);

try {
  const value = imageSize(Buffer.from(process.argv[2], "base64"));
  process.stdout.write(JSON.stringify({ kind: "result", value }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    kind: "error",
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  }));
}
`;

type Outcome =
  | {
      kind: "result";
      value: { width: number; height: number; type: string };
    }
  | {
      kind: "error";
      name: string;
      message: string;
    };

function runIsolated(payload: string): Outcome {
  const child = spawnSync(
    process.execPath,
    ["-e", CHILD_SCRIPT, imageSizeEntry, payload],
    {
      encoding: "utf8",
      timeout: 2_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    },
  );

  if (child.error) {
    throw new Error(`image-size subprocess failed: ${child.error.message}`);
  }

  if (child.status !== 0) {
    throw new Error(
      `image-size subprocess exited ${child.status}; signal=${child.signal}; stderr=${child.stderr}`,
    );
  }

  return JSON.parse(child.stdout) as Outcome;
}

const validCases = [
  [
    "JXL",
    "AAAADEpYTCANCocKAAAADGZ0eXBqeGwgAAAADGp4bGP/CkEA",
    { width: 8, height: 8, type: "jxl" },
  ],
  [
    "HEIF",
    "AAAAEGZ0eXBtaWYxAAAAAAAAADBtZXRhAAAAAAAAACRpcHJwAAAAHGlwY28AAAAUaXNwZQAAAAAAAAFAAAAA8A==",
    { width: 320, height: 240, type: "mif1" },
  ],
  ["ICNS", "aWNucwAAABBpczMyAAAACA==", { width: 16, height: 16, type: "is32" }],
] as const;

const malformedCases = [
  [
    "JXL com jxlp.size=0",
    "AAAADEpYTCANCocKAAAADGZ0eXBqeGwgAAAAAGp4bHA=",
    "Error",
    "No codestream found in JXL container",
  ],
  [
    "HEIF com ispe.size=0",
    "AAAAEGZ0eXBtaWYxAAAAAAAAADBtZXRhAAAAAAAAACRpcHJwAAAAHGlwY28AAAAAaXNwZQAAAAAAAAFAAAAA8A==",
    "TypeError",
    "Invalid HEIF, no size found",
  ],
  [
    "ICNS com entryLength=0",
    "aWNucwAAABBpczMyAAAAAA==",
    "TypeError",
    "Invalid ICNS, entry length must be at least 8 bytes",
  ],
] as const;

describe("image-size patched parser progress invariants", () => {
  it.each(validCases)(
    "preserva o controle positivo %s",
    (_name, payload, expected) => {
      expect(runIsolated(payload)).toEqual({
        kind: "result",
        value: expected,
      });
    },
  );

  it.each(malformedCases)(
    "rejeita %s sem bloquear o event loop",
    (_name, payload, errorName, message) => {
      expect(runIsolated(payload)).toEqual({
        kind: "error",
        name: errorName,
        message,
      });
    },
  );
});
