import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAudit, type AuditEntry } from "../server/audit-trail";

const dbState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../server/db", () => ({
  getDb: vi.fn(async () => dbState.current),
}));

const entry: AuditEntry = {
  institutionId: 1,
  actorUserId: 10,
  actorRole: "USER",
  action: "USER_UPDATED",
  entityType: "USER",
  entityId: 10,
  description: "teste de contrato fail-closed",
};

describe("recordAudit: contrato fail-closed", () => {
  beforeEach(() => {
    dbState.current = undefined;
    vi.restoreAllMocks();
  });

  it("propaga por padrão quando o banco de auditoria está indisponível", async () => {
    await expect(recordAudit(entry)).rejects.toThrow("Audit database unavailable");
  });

  it("propaga por padrão uma falha de persistência", async () => {
    const insertionFailure = new Error("forced audit insert failure");
    dbState.current = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw insertionFailure;
        }),
      })),
    };

    await expect(recordAudit(entry)).rejects.toBe(insertionFailure);
  });

  it("não aceita opt-out best-effort nem quando um caller JS burla o tipo", async () => {
    const insertionFailure = new Error("forced audit insert failure");
    dbState.current = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw insertionFailure;
        }),
      })),
    };

    await expect(
      recordAudit(entry, { strict: false } as unknown as { strict: true }),
    ).rejects.toBe(insertionFailure);
  });

  it.each([undefined, null, 0, -1, 1.5, Number.NaN])(
    "recusa institutionId inválido (%s) antes de acessar o banco",
    async (institutionId) => {
      await expect(
        recordAudit(
          { ...entry, institutionId } as unknown as AuditEntry,
        ),
      ).rejects.toThrow("AuditEntry.institutionId");
    },
  );
});
