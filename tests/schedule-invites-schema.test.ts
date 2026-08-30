import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { scheduleInvites } from "../drizzle/schema";

describe("schema de convites de escala", () => {
  it("amarra o convite à topologia instituição + hospital + setor", () => {
    expect(scheduleInvites.institutionId.notNull).toBe(true);
    expect(scheduleInvites.hospitalId.notNull).toBe(true);
    expect(scheduleInvites.sectorId.notNull).toBe(true);
    expect(scheduleInvites.codeHash.notNull).toBe(true);
    expect(scheduleInvites.createdByUserId.notNull).toBe(true);
    expect(scheduleInvites.invitedUserId.notNull).toBe(false);
    expect(scheduleInvites.invitedEmail.notNull).toBe(false);
    expect(scheduleInvites.maxRedemptions.notNull).toBe(true);
    expect(scheduleInvites.redeemedCount.notNull).toBe(true);
    expect(scheduleInvites.expiresAt.notNull).toBe(true);
    expect(scheduleInvites.revokedAt.notNull).toBe(false);
    expect(scheduleInvites.declinedAt.notNull).toBe(false);
    expect(scheduleInvites.declinedByUserId.notNull).toBe(false);
  });

  it("guarda só o hash e impede dois convites com o mesmo código", () => {
    const config = getTableConfig(scheduleInvites);
    const uniqueColumns = Object.fromEntries(
      config.uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map(({ name }) => name),
      ]),
    );
    expect(uniqueColumns).toMatchObject({
      uniq_schedule_invite_code_hash: ["code_hash"],
    });
    expect(
      config.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["institution_id"],
        ["hospital_id"],
        ["sector_id"],
        ["created_by_user_id"],
        ["invited_user_id"],
        ["declined_by_user_id"],
        ["institution_id", "hospital_id"],
        ["institution_id", "hospital_id", "sector_id"],
      ]),
    );
  });
});
