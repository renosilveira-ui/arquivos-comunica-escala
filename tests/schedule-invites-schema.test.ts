import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  scheduleInviteIssuanceFences,
  scheduleInviteIssuanceJournal,
  scheduleInvites,
} from "../drizzle/schema";

describe("schema de convites de escala", () => {
  it("amarra o convite à topologia instituição + hospital + setor", () => {
    expect(scheduleInvites.institutionId.notNull).toBe(true);
    expect(scheduleInvites.hospitalId.notNull).toBe(true);
    expect(scheduleInvites.sectorId.notNull).toBe(true);
    expect(scheduleInvites.codeHash.notNull).toBe(true);
    expect(scheduleInvites.codeHashVersion.notNull).toBe(true);
    expect(scheduleInvites.codeHashVersion.default).toBe("HMAC_SHA256_V2");
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

describe("schema da emissão durável", () => {
  it("amarra outbox a escopo+geração e mantém material opaco", () => {
    const config = getTableConfig(scheduleInviteIssuanceFences);
    expect(scheduleInviteIssuanceFences.generation.notNull).toBe(true);
    expect(scheduleInviteIssuanceFences.leaseToken.notNull).toBe(false);
    expect(scheduleInviteIssuanceFences.attemptExpiresAt.notNull).toBe(false);
    expect(scheduleInviteIssuanceFences.codeNonce.notNull).toBe(false);
    expect(scheduleInviteIssuanceFences.codePepperKeyId.notNull).toBe(false);
    expect(scheduleInviteIssuanceFences.recipientBindingHash.notNull).toBe(
      false,
    );
    expect(scheduleInviteIssuanceFences.providerIdempotencyKey.notNull).toBe(
      false,
    );
    expect(
      scheduleInviteIssuanceFences.providerRequestFingerprint.notNull,
    ).toBe(false);
    expect(
      config.uniqueConstraints
        .find(
          (constraint) =>
            constraint.name === "uniq_schedule_invite_issuance_scope",
        )
        ?.columns.map(({ name }) => name),
    ).toEqual([
      "institution_id",
      "hospital_id",
      "sector_id",
      "invited_user_id",
    ]);
    expect(config.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "chk_schedule_invite_issuance_lease_shape",
        "chk_schedule_invite_issuance_material_shape",
        "chk_schedule_invite_issuance_activation_shape",
      ]),
    );
    const foreignKeys = Object.fromEntries(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return [
          foreignKey.getName(),
          {
            columns: reference.columns.map(({ name }) => name),
            referencedColumns: reference.foreignColumns.map(({ name }) => name),
            onUpdate: foreignKey.onUpdate,
            onDelete: foreignKey.onDelete,
          },
        ];
      }),
    );
    expect(foreignKeys).toEqual({
      fk_schedule_invite_issuance_hospital_topology: {
        columns: ["institution_id", "hospital_id"],
        referencedColumns: ["institution_id", "id"],
        onUpdate: "restrict",
        onDelete: "restrict",
      },
      fk_schedule_invite_issuance_sector_topology: {
        columns: ["institution_id", "hospital_id", "sector_id"],
        referencedColumns: ["institution_id", "hospital_id", "id"],
        onUpdate: "restrict",
        onDelete: "restrict",
      },
      fk_schedule_invite_issuance_invited_user: {
        columns: ["invited_user_id"],
        referencedColumns: ["id"],
        onUpdate: "restrict",
        onDelete: "cascade",
      },
    });
  });

  it("journal é separado, indexado por geração e sem campos sensíveis", () => {
    const config = getTableConfig(scheduleInviteIssuanceJournal);
    expect(scheduleInviteIssuanceJournal.generation.notNull).toBe(true);
    expect(scheduleInviteIssuanceJournal.event.notNull).toBe(true);
    expect(config.foreignKeys).toHaveLength(0);
    expect(config.indexes[0]?.config.columns.map(({ name }) => name)).toEqual([
      "institution_id",
      "hospital_id",
      "sector_id",
      "invited_user_id",
      "generation",
      "id",
    ]);
    expect(Object.keys(scheduleInviteIssuanceJournal)).not.toEqual(
      expect.arrayContaining(["code", "codeHash", "email", "providerPayload"]),
    );
  });
});
