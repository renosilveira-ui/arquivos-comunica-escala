import { describe, expect, it } from "vitest";

describe("default E2E database import tripwire", () => {
  it("rejects the direct server/db import", async () => {
    await expect(import("../server/db.js?direct-tripwire")).rejects.toThrow(
      "Default E2E gate must not import server/db",
    );
  });

  it("rejects a sibling module that imports ./db transitively", async () => {
    await expect(import("../server/audit-trail.js")).rejects.toThrow(
      "Default E2E gate must not import server/db",
    );
  });
});
