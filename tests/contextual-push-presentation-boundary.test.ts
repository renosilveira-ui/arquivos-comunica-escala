import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function typescriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory()
      ? typescriptFiles(path)
      : /\.tsx?$/.test(entry)
        ? [path]
        : [];
  });
}

describe("fronteira da apresentação contextual de push", () => {
  it("mantém renderização contextual fora dos produtores de eventos", () => {
    const allowed = new Set([
      "server/contextual-push-presentation.ts",
      "server/notifications-service.ts",
      "server/push-delivery.ts",
    ]);
    const offenders = typescriptFiles("server")
      .map((path) => ({
        path: relative(".", path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ path, source }) =>
          !allowed.has(path) && source.includes("contextual-push-presentation"),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("conserva o transporte Expo visível sob a única chamada produtiva rastreada", () => {
    const callers = typescriptFiles("server")
      .map((path) => ({
        path: relative(".", path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ path, source }) =>
          path !== "server/notifications-service.ts" &&
          /\bsendPushNotification\s*\(/.test(source),
      )
      .map(({ path }) => path);

    expect(callers).toEqual(["server/push-delivery.ts"]);
  });
});
