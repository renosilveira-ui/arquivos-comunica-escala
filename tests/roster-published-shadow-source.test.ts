import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../server/month-guards.ts", import.meta.url),
  "utf8",
);

function publishMonthSource(): string {
  const start = source.indexOf("export async function publishMonth(");
  const end = source.indexOf("export async function lockMonth(", start);
  if (start < 0 || end < 0) {
    throw new Error("Não foi possível localizar publishMonth no source");
  }
  return source.slice(start, end);
}

describe("emissão sombra na publicação de escala", () => {
  it("registra ROSTER_PUBLISHED após o CAS e dentro da transação da publicação", () => {
    const publishSource = publishMonthSource();
    const updateIndex = publishSource.indexOf(".update(monthlyRosters)");
    const eventIndex = publishSource.indexOf(
      "createOperationalEventInTransaction(tx, {",
    );
    const comunicaOutboxIndex = publishSource.indexOf(
      "enqueueComunicaRosterPublished({",
    );

    expect(publishSource).toContain("await db.transaction(async (tx) => {");
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeGreaterThan(updateIndex);
    expect(comunicaOutboxIndex).toBeGreaterThan(eventIndex);
    expect(publishSource).toContain('eventType: "ROSTER_PUBLISHED"');
    expect(publishSource).toContain('type: "MONTHLY_ROSTER"');
    expect(publishSource).toContain("version: publishedVersion");
    expect(publishSource).toContain('scopeKind: "HOSPITAL"');
    expect(publishSource).toContain("recipientResolution:");
  });

  it("usa apenas IDs canônicos no novo ledger e preserva o outbox Comunica+", () => {
    const publishSource = publishMonthSource();
    const eventIndex = publishSource.indexOf(
      "createOperationalEventInTransaction(tx, {",
    );
    const eventEnd = publishSource.indexOf(
      "for (const recipient of recipients)",
      eventIndex,
    );
    const eventBlock = publishSource.slice(eventIndex, eventEnd);

    expect(eventBlock).toContain("userId: recipient.userId");
    expect(eventBlock).not.toContain("recipient.email");
    expect(eventBlock).not.toMatch(/email:\s*/i);
    expect(publishSource).toContain("enqueueComunicaRosterPublished({");
  });

  it("não adiciona adaptador de push ou e-mail ao fluxo em sombra", () => {
    expect(source).not.toMatch(
      /from\s+["'].*(push-delivery|mailer|resend)["']/i,
    );
  });
});
