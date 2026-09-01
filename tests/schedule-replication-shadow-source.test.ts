import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shiftsCrud = readFileSync("server/shifts-crud.ts", "utf8");
const monthGuards = readFileSync("server/month-guards.ts", "utf8");
const replicationEvents = readFileSync(
  "server/schedule-replication-events.ts",
  "utf8",
);

function functionSlice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Função não encontrada: ${start}`);
  return source.slice(from, to);
}

describe("emissão SHADOW de publicação e replicação", () => {
  it("grava lote, escopos e fato pela mesma transação já dona da cópia", () => {
    const range = functionSlice(
      shiftsCrud,
      "async function replicateRange",
      "function localHourBrt",
    );
    const audit = range.indexOf("await recordAudit(");
    const event = range.indexOf(
      "await recordScheduleReplicationShadowEventInTransaction(tx",
    );

    expect(range).toContain("await db.transaction(async (tx) =>");
    expect(range).toContain("const createdShiftIds: number[] = []");
    expect(range).toContain("const createdAssignmentIds: number[] = []");
    expect(event).toBeGreaterThan(audit);
    expect(event).toBeLessThan(
      range.indexOf("ASSIGNMENT_WRITE_TRANSACTION_CONFIG"),
    );

    const batchInsert = replicationEvents.indexOf(
      ".insert(scheduleReplicationBatches)",
    );
    const scopeInsert = replicationEvents.indexOf(
      ".insert(scheduleReplicationBatchScopes)",
    );
    const ledgerInsert = replicationEvents.indexOf(
      "createOperationalEventInTransaction(",
    );
    expect(batchInsert).toBeGreaterThan(-1);
    expect(scopeInsert).toBeGreaterThan(batchInsert);
    expect(ledgerInsert).toBeGreaterThan(scopeInsert);
    expect(replicationEvents).not.toMatch(
      /from\s+["'].*(push|mail|resend|cron)/i,
    );
  });

  it("não transforma uma cópia de calendário vazio em comunicação a médicos", () => {
    const calendar = functionSlice(
      shiftsCrud,
      "async function replicateMonthCalendar",
      "/**\n * Abre os plantões vagos",
    );

    expect(calendar).toContain("if (createdShiftIds.length > 0)");
    expect(calendar).toContain('sourceKind: "MONTH_CALENDAR"');
    expect(calendar).toContain("createdAssignmentIds: []");
  });

  it("emite a publicação mensal após o CAS e antes da fila legada", () => {
    const cas = monthGuards.indexOf(
      "version: sql`${monthlyRosters.version} + 1`",
    );
    const event = monthGuards.indexOf(
      "await createOperationalEventInTransaction(tx",
    );
    const legacyOutbox = monthGuards.indexOf(
      "await enqueueComunicaRosterPublished(",
    );

    expect(cas).toBeGreaterThan(-1);
    expect(event).toBeGreaterThan(cas);
    expect(legacyOutbox).toBeGreaterThan(event);
    expect(monthGuards.slice(event, legacyOutbox)).toContain(
      "version: publishedVersion",
    );
    expect(monthGuards.slice(event, legacyOutbox)).toContain(
      "role: actor.roleInInstitution",
    );
  });
});
