import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const actionability = readFileSync("server/vacancy-actionability.ts", "utf8");
const routers = readFileSync("server/routers.ts", "utf8");
const auxRouters = readFileSync("server/aux-routers.ts", "utf8");
const mobileVacancies = readFileSync("app/(tabs)/vacancies.tsx", "utf8");

describe("limites de leitura de vagas", () => {
  it("limita a lista pública ao dia civil completo usado pelo mobile", () => {
    expect(actionability).toContain("actionableVacancyListInputSchema");
    expect(actionability).toContain("ACTIONABLE_VACANCY_QUERY_REQUIRES_BOUND");
    expect(actionability).not.toContain("OFFSET ${input.page.offset}");
    expect(routers).toContain(".input(actionableVacancyListInputSchema)");
    expect(routers).not.toContain(
      ".input(actionableVacancyListInputSchema.optional())",
    );
    expect(routers).toContain("filters: input");
    expect(mobileVacancies).toContain(
      "date: toLocalISODateString(filters.date)",
    );
  });

  it("não pagina o contador diário nem a resolução exata de push", () => {
    const exactRoute = routers.slice(
      routers.indexOf("resolveVacancyIntent: protectedProcedure"),
      routers.indexOf("export const appRouter"),
    );
    const countsRoute = auxRouters.slice(
      auxRouters.indexOf("actionableVacancyCounts: protectedProcedure"),
    );
    expect(exactRoute).toContain("shiftInstanceId: input.shiftInstanceId");
    expect(exactRoute).not.toContain("page:");
    expect(countsRoute).toContain("filters: input");
    expect(countsRoute).not.toContain("page:");
    expect(actionability).toContain("? sql`LIMIT 1`");
  });
});
