import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../server/routes/admin.ts", import.meta.url),
  "utf8",
);

const userUpdateStart = source.indexOf('adminRouter.put(\n  "/users/:id",');
const userUpdateEnd = source.indexOf(
  "// ---------------------------------------------------------------------------\n// POST /api/admin/users/:id/reset-password",
);
const userUpdateRoute = source.slice(userUpdateStart, userUpdateEnd);

describe("wiring SHADOW de ACCESS_UPDATED na atualização administrativa", () => {
  it("fica restrito ao PUT /users/:id e usa a mesma transação da mutação", () => {
    expect(userUpdateStart).toBeGreaterThanOrEqual(0);
    expect(userUpdateEnd).toBeGreaterThan(userUpdateStart);
    expect(source.match(/emitAccessUpdatedShadowInTransaction/g)).toHaveLength(
      2,
    );

    const transactionIndex = userUpdateRoute.indexOf(
      "connectionDb.transaction(",
    );
    const beforeIndex = userUpdateRoute.indexOf("const accessStateBefore");
    const revisionIndex = userUpdateRoute.indexOf(
      "operationalRevision: sql`${professionalInstitutions.operationalRevision} + 1`",
    );
    const eventIndex = userUpdateRoute.indexOf(
      "await emitAccessUpdatedShadowInTransaction(tx,",
    );
    const auditIndex = userUpdateRoute.indexOf("await recordAudit(");

    expect(transactionIndex).toBeGreaterThanOrEqual(0);
    expect(beforeIndex).toBeGreaterThan(transactionIndex);
    expect(revisionIndex).toBeGreaterThan(beforeIndex);
    expect(eventIndex).toBeGreaterThan(revisionIndex);
    expect(auditIndex).toBeGreaterThan(eventIndex);

    const eventBlock = userUpdateRoute.slice(
      userUpdateRoute.lastIndexOf("if (accessStateBefore)"),
      auditIndex,
    );
    expect(eventBlock).not.toContain("catch (");
    expect(eventBlock).toContain("affectedRows(revisionUpdate) !== 1");
    expect(eventBlock).toContain("hashProfessionalInstitutionAccessState");
  });

  it("só emite para mudança lógica de papel, ACL ou escopo gerencial", () => {
    expect(userUpdateRoute).toContain("const accessMutationRequested");
    expect(userUpdateRoute).toContain("shouldRewriteScheduleAccess ||");
    expect(userUpdateRoute).toContain("requestedInstitutionRole !== undefined");
    expect(userUpdateRoute).toContain("requestedManagerScopes !== undefined");
    expect(userUpdateRoute).toContain("const accessStateChanged =");
    expect(userUpdateRoute).toContain("if (accessStateChanged)");
    expect(source).toContain('transition: { from: "ACTIVE", to: "ACTIVE" }');
  });

  it("recalcula ator, alvo e topologia por IDs sem criar bloqueio clínico novo", () => {
    expect(source).toContain(
      "readCanonicalProfessionalInstitutionAccessStateForUpdate",
    );
    expect(source).toContain("expectedUserId: target.userId");
    expect(source).toContain("expectedProfessionalId: target.professionalId");
    expect(source).toContain("locked.caller.userId === target.userId");
    expect(source).not.toMatch(/qualificationMatches|sectorServiceSpecialt/i);
  });

  it("preserva o modo SHADOW com o único destinatário canônico nos dois canais", () => {
    const helperStart = source.indexOf(
      "async function emitAccessUpdatedShadowInTransaction",
    );
    const helperEnd = source.indexOf("export const adminRouter", helperStart);
    const helper = source.slice(helperStart, helperEnd);

    expect(helper).toContain('eventType: "ACCESS_UPDATED"');
    expect(helper).toContain('deliveryPolicy: "NOTIFY"');
    expect(helper).toContain('channels: ["PUSH", "EMAIL"]');
    expect(helper).not.toMatch(
      /notificationDeliveries|mailer|sendPush|provider|pushTokens|userOperationalEmailTrust|isTrustedOperationalEmail/i,
    );
    expect(userUpdateRoute).not.toMatch(
      /notificationDeliveries|sendPush|provider/i,
    );
  });
});
