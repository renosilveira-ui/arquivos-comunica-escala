import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceExtensions = /\.(?:[cm]?[jt]s|tsx)$/;

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && sourceExtensions.test(entry.name) ? [path] : [];
  });
}

describe("inventário de writers e validadores legados de alocação", () => {
  it("não permite writers diretos em scripts manuais", () => {
    expect(existsSync(resolve(repositoryRoot, "scripts/test-reject-manual.ts"))).toBe(
      false,
    );

    const directAssignmentWrites = [
      /\.insert\(\s*shiftAssignmentsV2\s*\)/,
      /\.update\(\s*shiftAssignmentsV2\s*\)/,
      /\.delete\(\s*shiftAssignmentsV2\s*\)/,
      /\.update\(\s*shiftInstances\s*\)/,
      /\.delete\(\s*shiftInstances\s*\)/,
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?shift_(?:assignments_v2|instances)\b/i,
    ];
    const offenders = sourceFiles(resolve(repositoryRoot, "scripts"))
      .filter((path) => basename(path).toLowerCase().includes("manual"))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return directAssignmentWrites.some((pattern) => pattern.test(source));
      })
      .map((path) => path.slice(repositoryRoot.length + 1));

    expect(offenders).toEqual([]);
  });

  it("mantém removido o módulo de limite fixo e qualquer import exato", () => {
    expect(existsSync(resolve(repositoryRoot, "server/shift-validations.ts"))).toBe(
      false,
    );

    const legacyImport =
      /(?:from\s+|import\s*\(|require\s*\()\s*["'][^"']*shift-validations["']/;
    const offenders = ["app", "components", "hooks", "lib", "scripts", "server"]
      .flatMap((directory) =>
        sourceFiles(resolve(repositoryRoot, directory)),
      )
      .filter((path) => legacyImport.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(repositoryRoot.length + 1));

    expect(offenders).toEqual([]);
  });
});
