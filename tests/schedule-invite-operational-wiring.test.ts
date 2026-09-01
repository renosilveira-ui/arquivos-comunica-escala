import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../server/schedule-invites.ts", import.meta.url),
  "utf8",
);
const authSource = readFileSync(
  new URL("../server/routes/auth.ts", import.meta.url),
  "utf8",
);
const eventSource = readFileSync(
  new URL("../server/schedule-invite-operational-events.ts", import.meta.url),
  "utf8",
);

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Trecho de source não encontrado: ${start}`);
  }
  return source.slice(startIndex, endIndex);
}

describe("wiring atômico dos fatos de convite", () => {
  it("cria o convite e seu fato no mesmo callback transacional antes do mailer legado", () => {
    const create = section(
      "  create: protectedProcedure",
      "  revoke: protectedProcedure",
    );
    const transaction = create.indexOf(
      "created = await db.transaction(async (tx) =>",
    );
    const insert = create.indexOf(".insert(scheduleInvites)");
    const createdEvent = create.indexOf(
      "recordScheduleInviteCreatedInTransaction(tx,",
    );
    const mailerCall = create.indexOf("mailer.sendMail(mail)");

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(transaction);
    expect(createdEvent).toBeGreaterThan(insert);
    expect(mailerCall).toBeGreaterThan(createdEvent);
    expect(create).not.toContain("await db.insert(scheduleInvites)");
  });

  it("grava aceite e revogação com CAS de revisão antes de qualquer fato", () => {
    const redeem = section(
      "export async function redeemScheduleInviteInTransaction",
      "export async function declineScheduleInviteInTransaction",
    );
    const revoke = section(
      "async function revokeLockedPendingScheduleInviteInTransaction",
      "export async function revokeScheduleInviteInTransaction",
    );

    expect(redeem).toContain("operationalRevision: sql");
    expect(redeem).toContain(
      "eq(scheduleInvites.operationalRevision, invite.operationalRevision)",
    );
    expect(
      redeem.indexOf("recordScheduleInviteAcceptedInTransaction(tx,"),
    ).toBeGreaterThan(redeem.indexOf("const increment = await tx"));
    expect(revoke).toContain("operationalRevision: sql");
    expect(revoke).toContain("recordScheduleInviteRevokedInTransaction(tx,");
  });

  it("faz rollback da mutação se a gravação do fato falhar", () => {
    const create = section(
      "  create: protectedProcedure",
      "  revoke: protectedProcedure",
    );
    const createTransaction = create.indexOf(
      "created = await db.transaction(async (tx) =>",
    );
    const createEvent = create.indexOf(
      "await recordScheduleInviteCreatedInTransaction(tx,",
    );
    const createReturn = create.indexOf(
      "return {\n              inviteId:",
      createEvent,
    );
    const redeem = section(
      "export async function redeemScheduleInviteInTransaction",
      "export async function declineScheduleInviteInTransaction",
    );
    const revoke = section(
      "async function revokeLockedPendingScheduleInviteInTransaction",
      "export async function revokeScheduleInviteInTransaction",
    );
    const routeRevoke = source.slice(
      source.indexOf("  revoke: protectedProcedure"),
    );
    const redeemRoute = authSource.slice(
      authSource.indexOf("const joined = await db.transaction(async (tx) =>"),
      authSource.indexOf("await enqueueScheduleInviteAcceptedSignal"),
    );

    // Os três helpers propagam a falha do ledger (coberto no teste do helper)
    // e são aguardados dentro do callback de transaction. Como não há catch
    // no callback, Drizzle rejeita a callback e desfaz a mutação antes do commit.
    expect(createTransaction).toBeGreaterThanOrEqual(0);
    expect(createEvent).toBeGreaterThan(createTransaction);
    expect(createReturn).toBeGreaterThan(createEvent);
    expect(create.slice(createEvent, createReturn)).not.toContain("catch");
    expect(redeem).toContain(
      "await recordScheduleInviteAcceptedInTransaction(tx,",
    );
    expect(redeemRoute).toContain(
      "return redeemScheduleInviteInTransaction(tx,",
    );
    expect(redeemRoute).not.toContain("catch");
    expect(revoke).toContain(
      "await recordScheduleInviteRevokedInTransaction(tx,",
    );
    expect(routeRevoke).toContain("await db.transaction((tx) =>");
    expect(routeRevoke).toContain("revokeScheduleInviteInTransaction(tx,");
  });

  it("não adiciona elegibilidade clínica ao writer nem consulta especialidade setorial", () => {
    const create = section(
      "  create: protectedProcedure",
      "  revoke: protectedProcedure",
    );
    const atomicCreate = create.slice(
      create.indexOf("created = await db.transaction(async (tx) =>"),
      create.indexOf("const mail = buildScheduleInviteMail"),
    );

    expect(atomicCreate).not.toContain("qualificationMatches");
    expect(atomicCreate).not.toMatch(
      /sectorServiceSpecialties|sector_service_specialties/,
    );
    expect(eventSource).not.toMatch(
      /medicalSpecialt(?:y|ies)|sectorServiceSpecialties|sector_service_specialties/,
    );
  });

  it("não emite fato canônico para recusa nem expiração nesta frente", () => {
    const decline = section(
      "export async function declineScheduleInviteInTransaction",
      "function isPendingScheduleInvite",
    );

    expect(decline).not.toContain("recordScheduleInvite");
    expect(decline).toContain("operationalRevision: sql");
    expect(source).not.toContain("SCHEDULE_INVITE_EXPIRED");
    expect(eventSource).not.toContain("SCHEDULE_INVITE_DECLINED");
    expect(eventSource).not.toContain("SCHEDULE_INVITE_EXPIRED");
  });
});
