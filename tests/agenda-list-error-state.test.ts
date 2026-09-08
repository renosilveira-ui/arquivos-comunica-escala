import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { presentQueryError } from "../lib/query-error-presentation";

const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");

describe("erro da grade da agenda não vira falha de conexão", () => {
  it("listAgenda expõe o erro da query para QueryErrorState", () => {
    expect(agenda).toContain(
      "const { data, isLoading, isError, error, refetch } = trpc.shifts.listAgenda.useQuery(",
    );
    expect(agenda).toContain('trpc.shifts.listAgenda.useQuery');
    expect(agenda).toContain('title="Não foi possível carregar a agenda"');
    expect(agenda).toContain("error={error}");
  });

  it("não hardcoda copy de conexão no ramo isError da grade", () => {
    const errorStart = agenda.indexOf("isError && !data");
    const errorEnd = agenda.indexOf(
      'title="Não foi possível carregar a agenda"',
    );
    expect(errorStart).toBeGreaterThan(-1);
    expect(errorEnd).toBeGreaterThan(errorStart);
    const listAgendaError = agenda.slice(errorStart, errorEnd + 80);
    expect(listAgendaError).toContain("QueryErrorState");
    expect(listAgendaError).toContain("error={error}");
    expect(listAgendaError).not.toMatch(/verifique sua conexão/i);
    expect(listAgendaError).not.toContain("TouchableOpacity");
    expect(agenda).not.toMatch(/Verifique sua conexão e tente novamente/);
  });

  it("401, 403 e 500 da agenda não usam a mensagem de conexão", () => {
    const access = presentQueryError({ data: { code: "FORBIDDEN" } });
    const unauthorized = presentQueryError({ data: { code: "UNAUTHORIZED" } });
    const server = presentQueryError({
      data: { code: "INTERNAL_SERVER_ERROR" },
    });
    const network = presentQueryError({
      message: "Network request failed",
    });
    expect(access.kind).toBe("ACCESS");
    expect(unauthorized.kind).toBe("ACCESS");
    expect(server.kind).toBe("SERVICE");
    expect(network.kind).toBe("NETWORK");
    expect(access.body).not.toMatch(/conexão/i);
    expect(unauthorized.body).not.toMatch(/conexão/i);
    expect(server.body).not.toMatch(/conexão/i);
    expect(network.body).toMatch(/conexão/i);
    expect(new Set([access.body, server.body, network.body]).size).toBe(3);
  });
});
