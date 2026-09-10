import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditActorLabel } from "../lib/audit-movement-presentation";

describe("minimização do ator na auditoria de movimentações", () => {
  it("preserva o nome recebido, inclusive snapshot histórico", () => {
    expect(auditActorLabel({ name: "Nome no momento do evento" })).toBe(
      "Nome no momento do evento",
    );
    expect(auditActorLabel({ name: "  Dra. Ana Lima  " })).toBe(
      "Dra. Ana Lima",
    );
  });

  it.each([undefined, null, {}, { name: null }, { name: "" }, { name: "   " }])(
    "ausência de nome (%j) usa apresentação neutra",
    (actor) => expect(auditActorLabel(actor)).toBe("Usuário desconhecido"),
  );

  it("ignora e-mail em payload legado, inclusive se o nome estiver ausente", () => {
    const legacy = { name: null, email: "third-party@test.local" };
    expect(auditActorLabel(legacy)).toBe("Usuário desconhecido");
    expect(auditActorLabel({ ...legacy, name: "Colega" })).toBe("Colega");
  });

  it("a projeção SQL não busca e-mail; UI usa o contrato tRPC e o apresentador mínimo", () => {
    const router = readFileSync("server/audit-router.ts", "utf8");
    const screen = readFileSync("app/audit-log.tsx", "utf8");
    expect(router).not.toMatch(/au\.email|actorUserEmail/);
    expect(screen).toContain("trpc.audit.listShiftMovements.useQuery(");
    expect(screen).toContain("auditActorLabel(row.actor)");
    expect(screen).not.toMatch(/trpc as any|row: any|actor\??\.email/);
  });
});
