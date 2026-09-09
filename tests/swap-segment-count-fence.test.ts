import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tabs = readFileSync("app/(tabs)/trocas.tsx", "utf8");
const available = readFileSync(
  "components/swaps/AvailableSwapsList.tsx",
  "utf8",
);
const offers = readFileSync("app/my-offers.tsx", "utf8");
const applications = readFileSync("app/my-applications.tsx", "utf8");

describe("contagens dos segmentos de Trocas", () => {
  it("oculta a fotografia anterior já no primeiro render do novo tenant", () => {
    expect(tabs).toContain("useTenantState");
    expect(tabs).toContain("const { tenantRevision } = useTenantState()");
    expect(tabs).toContain("scopedCounts.tenantRevision === tenantRevision");
    expect(tabs).toContain("current.tenantRevision > tenantRevision");
    expect(tabs).toContain("{ tenantRevision, values: {} }");
    expect(tabs).not.toContain("useEffect");
  });

  it("remove uma contagem que deixou de representar uma fila autorizada", () => {
    expect(tabs).toContain("count: number | null");
    expect(tabs).toContain("if (count === null)");
    expect(tabs).toContain("delete next[key]");

    for (const source of [available, offers, applications]) {
      expect(source).toContain("canDisplayOperationalListCount(contentState)");
      expect(source).toMatch(/:\s*null/);
      expect(source).toContain("onCountChange?: (count: number | null) => void");
    }
  });
});
