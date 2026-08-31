import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  normalizeRelation,
} from "drizzle-orm/relations";
import * as schema from "../drizzle/schema";
import {
  notificationDeliveries,
  operationalEmailVerificationTokens,
  operationalEventRecipients,
  operationalEventRecipientsRelations,
  operationalEventRelatedContexts,
  operationalEventRelatedContextsRelations,
  operationalEvents,
  operationalEventsRelations,
  notificationDeliveriesRelations,
  operationalEmailVerificationTokensRelations,
  shiftAssignmentsV2,
  shiftInstances,
  scheduleInvites,
  professionalInstitutions,
  userOperationalEmailTrustRelations,
  userOperationalEmailTrust,
} from "../drizzle/schema";

describe("schema da foundation de eventos operacionais", () => {
  it("preserva escopos institucional, hospitalar e setorial sem inferir topologia", () => {
    expect(operationalEvents.institutionId.notNull).toBe(true);
    expect(operationalEvents.hospitalId.notNull).toBe(false);
    expect(operationalEvents.scopeKind.notNull).toBe(true);
    expect(operationalEvents.scopeKind.enumValues).toEqual([
      "INSTITUTION",
      "HOSPITAL",
      "SECTOR",
    ]);
    expect(operationalEvents.sectorId.notNull).toBe(false);
    expect(operationalEvents.scheduleContextId.notNull).toBe(false);
    expect(operationalEvents.shiftInstanceId.notNull).toBe(false);
    expect(operationalEvents.assignmentId.notNull).toBe(false);

    const config = getTableConfig(operationalEvents);
    expect(config.checks.map(({ name }) => name)).toContain(
      "chk_operational_event_scope",
    );
    expect(config.checks.map(({ name }) => name)).toContain(
      "chk_operational_event_actor",
    );
    expect(
      config.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["institution_id", "hospital_id"],
        ["institution_id", "hospital_id", "sector_id"],
        ["institution_id", "hospital_id", "sector_id", "schedule_context_id"],
        ["institution_id", "hospital_id", "sector_id", "shift_instance_id"],
        ["institution_id", "hospital_id", "sector_id", "assignment_id"],
        ["actor_user_id", "institution_id"],
      ]),
    );
  });

  it("mantém contexto relacionado na mesma instituição com FKs compostas", () => {
    expect(operationalEventRelatedContexts.scopeKind.enumValues).toEqual([
      "INSTITUTION",
      "HOSPITAL",
      "SECTOR",
    ]);
    expect(operationalEventRelatedContexts.relationKind.enumValues).toEqual([
      "COUNTERPART",
      "AFFECTED_SCOPE",
    ]);
    const config = getTableConfig(operationalEventRelatedContexts);
    expect(config.checks.map(({ name }) => name)).toContain(
      "chk_operational_event_related_context_scope",
    );
    expect(
      config.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["operational_event_id", "institution_id"],
        ["institution_id", "hospital_id"],
        ["institution_id", "hospital_id", "sector_id"],
        ["institution_id", "hospital_id", "sector_id", "schedule_context_id"],
        ["institution_id", "hospital_id", "sector_id", "shift_instance_id"],
        ["institution_id", "hospital_id", "sector_id", "assignment_id"],
      ]),
    );
  });

  it("expõe chaves-pai compostas para reforçar a topologia de turno e alocação", () => {
    const shiftKeys = Object.fromEntries(
      getTableConfig(shiftInstances).uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map(({ name }) => name),
      ]),
    );
    const assignmentKeys = Object.fromEntries(
      getTableConfig(shiftAssignmentsV2).uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map(({ name }) => name),
      ]),
    );

    expect(shiftKeys).toMatchObject({
      uniq_shift_instances_topology_id: [
        "institution_id",
        "hospital_id",
        "sector_id",
        "id",
      ],
    });
    expect(assignmentKeys).toMatchObject({
      uniq_shift_assignments_topology_id: [
        "institution_id",
        "hospital_id",
        "sector_id",
        "id",
      ],
    });
  });

  it("aceita somente usuário ou convite persistido como destinatário", () => {
    const config = getTableConfig(operationalEventRecipients);
    const uniqueColumns = Object.fromEntries(
      config.uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map(({ name }) => name),
      ]),
    );

    expect(operationalEventRecipients.recipientKind.enumValues).toEqual([
      "USER",
      "SCHEDULE_INVITE",
    ]);
    expect(config.checks.map(({ name }) => name)).toContain(
      "chk_operational_event_recipient_target",
    );
    expect(operationalEventRecipients.institutionId.notNull).toBe(true);
    expect(
      config.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["operational_event_id", "institution_id"],
        ["user_id", "institution_id"],
        ["schedule_invite_id", "institution_id"],
      ]),
    );
    expect(uniqueColumns).toMatchObject({
      uniq_operational_event_recipient_user: [
        "operational_event_id",
        "user_id",
      ],
      uniq_operational_event_recipient_invite: [
        "operational_event_id",
        "schedule_invite_id",
      ],
    });
  });

  it("separa estados e deduplicação por canal", () => {
    expect(notificationDeliveries.channel.enumValues).toEqual([
      "PUSH",
      "EMAIL",
    ]);
    expect(notificationDeliveries.status.enumValues).toEqual([
      "QUEUED",
      "PROCESSING",
      "PROVIDER_ACCEPTED",
      "DELIVERED",
      "FAILED",
      "DEAD",
      "SKIPPED",
    ]);
    expect(notificationDeliveries.dedupKey.notNull).toBe(true);
  });

  it("guarda confiança e tokens por hash, não pelo endereço em claro", () => {
    expect(userOperationalEmailTrust.emailHash.notNull).toBe(true);
    expect(operationalEmailVerificationTokens.emailHash.notNull).toBe(true);
    expect(operationalEmailVerificationTokens.tokenHash.notNull).toBe(true);
    expect(operationalEmailVerificationTokens.usedAt.notNull).toBe(false);
    expect("email" in userOperationalEmailTrust).toBe(false);
    expect("email" in operationalEmailVerificationTokens).toBe(false);
  });

  it("não disponibiliza texto livre ou chave de idempotência em claro no evento", () => {
    expect(operationalEvents.idempotencyKeyHash.notNull).toBe(true);
    expect("idempotencyKey" in operationalEvents).toBe(false);
    expect("reason" in operationalEvents).toBe(false);
    expect("metadata" in operationalEvents).toBe(false);
    const constraints = Object.fromEntries(
      getTableConfig(operationalEvents).uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map(({ name }) => name),
      ]),
    );
    expect(constraints).toMatchObject({
      uniq_operational_event_idempotency: [
        "institution_id",
        "idempotency_key_hash",
      ],
    });
  });

  it("expõe a chave-pai composta de convite necessária ao destinatário canônico", () => {
    const constraints = Object.fromEntries(
      getTableConfig(scheduleInvites).uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map(({ name }) => name),
      ]),
    );
    expect(constraints).toMatchObject({
      uniq_schedule_invites_id_institution: ["id", "institution_id"],
    });
  });

  it("amarra ator e destinatário USER ao vínculo institucional canônico", () => {
    const constraints = Object.fromEntries(
      getTableConfig(professionalInstitutions).uniqueConstraints.map(
        (constraint) => [
          constraint.name,
          constraint.columns.map(({ name }) => name),
        ],
      ),
    );

    expect(Object.values(constraints)).toContainEqual([
      "user_id",
      "institution_id",
    ]);
  });

  it("expõe relações tipadas para evento, destinatário, delivery e confiança", () => {
    expect(operationalEventsRelations).toBeDefined();
    expect(operationalEventRelatedContextsRelations).toBeDefined();
    expect(operationalEventRecipientsRelations).toBeDefined();
    expect(notificationDeliveriesRelations).toBeDefined();
    expect(userOperationalEmailTrustRelations).toBeDefined();
    expect(operationalEmailVerificationTokensRelations).toBeDefined();
  });

  it("normaliza as relações novas sem ambiguidade", () => {
    const { tables, tableNamesMap } = extractTablesRelationalConfig(
      schema,
      createTableRelationsHelpers,
    );
    const tableNames = [
      "scheduleInvites",
      "operationalEvents",
      "operationalEventRelatedContexts",
      "operationalEventRecipients",
      "notificationDeliveries",
      "userOperationalEmailTrust",
      "operationalEmailVerificationTokens",
    ];

    for (const tableName of tableNames) {
      const table = tables[tableName];
      expect(table).toBeDefined();
      for (const relation of Object.values(table!.relations)) {
        expect(() =>
          normalizeRelation(
            tables,
            tableNamesMap,
            relation as Parameters<typeof normalizeRelation>[2],
          ),
        ).not.toThrow();
      }
    }
  });
});
