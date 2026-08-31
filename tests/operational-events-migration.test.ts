import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-31-operational-events-foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual da foundation de eventos operacionais", () => {
  it("é aditiva, rerodável e não apaga dados", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_events",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_event_recipients",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_event_related_contexts",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS notification_deliveries",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS user_operational_email_trust",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_email_verification_tokens",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/^\s*UPDATE\s+/im);
    expect(migration).not.toMatch(
      /\bALTER\s+TABLE\b[^']*\b(DROP|MODIFY|CHANGE|RENAME)\b/i,
    );
  });

  it("admite escopo institucional, hospitalar e setorial sem falsificar topologia", () => {
    expect(migration).toContain(
      "scope_kind ENUM('INSTITUTION', 'HOSPITAL', 'SECTOR') NOT NULL",
    );
    expect(migration).toContain("hospital_id INT NULL");
    expect(migration).toContain("sector_id INT NULL");
    expect(migration).toContain("CONSTRAINT chk_operational_event_scope");
    expect(migration).toContain("scope_kind = 'INSTITUTION'");
    expect(migration).toContain("scope_kind = 'HOSPITAL'");
    expect(migration).toContain("scope_kind = 'SECTOR'");
    expect(migration).toContain("fk_operational_events_hospital_topology");
    expect(migration).toContain("fk_operational_events_sector_topology");
    expect(migration).toContain(
      "fk_operational_events_schedule_context_topology",
    );
    expect(migration).toContain("fk_operational_events_shift_topology");
    expect(migration).toContain("fk_operational_events_assignment_topology");
    expect(migration).toContain("CONSTRAINT chk_operational_event_actor");
    expect(migration).toContain("actor_kind ENUM('USER', 'SYSTEM') NOT NULL");
  });

  it("amarra contextos relacionados ao mesmo evento e à mesma instituição", () => {
    expect(migration).toContain(
      "FOREIGN KEY (operational_event_id, institution_id)",
    );
    expect(migration).toContain(
      "REFERENCES operational_events(id, institution_id) ON DELETE CASCADE",
    );
    expect(migration).toContain(
      "fk_operational_event_related_context_shift_topology",
    );
    expect(migration).toContain(
      "fk_operational_event_related_context_assignment_topology",
    );
  });

  it("amarra destinatários ao tenant do evento e não persiste entrada livre", () => {
    const eventSection = migration.match(
      /CREATE TABLE IF NOT EXISTS operational_events[\s\S]*?ENGINE=InnoDB;/,
    )?.[0];
    const recipientSection = migration.match(
      /CREATE TABLE IF NOT EXISTS operational_event_recipients[\s\S]*?ENGINE=InnoDB;/,
    )?.[0];

    expect(migration).toContain(
      "ALTER TABLE schedule_invites ADD UNIQUE KEY uniq_schedule_invites_id_institution",
    );
    expect(eventSection).toContain("idempotency_key_hash VARCHAR(64)");
    expect(eventSection).not.toMatch(/\bmetadata\b/i);
    expect(eventSection).not.toMatch(/\breason\b/i);
    expect(recipientSection).toContain("institution_id INT NOT NULL");
    expect(recipientSection).toContain(
      "FOREIGN KEY (operational_event_id, institution_id)",
    );
    expect(recipientSection).toContain(
      "FOREIGN KEY (schedule_invite_id, institution_id)",
    );
    expect(eventSection).toContain(
      "FOREIGN KEY (actor_user_id, institution_id)",
    );
    expect(recipientSection).toContain("FOREIGN KEY (user_id, institution_id)");
    expect(eventSection).toContain(
      "REFERENCES professional_institutions(user_id, institution_id)",
    );
    expect(recipientSection).toContain(
      "REFERENCES professional_institutions(user_id, institution_id)",
    );
  });

  it("cria as chaves-pai antes das FKs compostas de turno e alocação", () => {
    const hospitalIndex = migration.indexOf(
      "ALTER TABLE hospitals ADD UNIQUE KEY uniq_hospitals_topology_id",
    );
    const sectorIndex = migration.indexOf(
      "ALTER TABLE sectors ADD UNIQUE KEY uniq_sectors_topology_id",
    );
    const scheduleContextIndex = migration.indexOf(
      "ALTER TABLE schedule_contexts ADD UNIQUE KEY uniq_schedule_context_topology_id",
    );
    const shiftIndex = migration.indexOf(
      "ALTER TABLE shift_instances ADD UNIQUE KEY uniq_shift_instances_topology_id",
    );
    const assignmentIndex = migration.indexOf(
      "ALTER TABLE shift_assignments_v2 ADD UNIQUE KEY uniq_shift_assignments_topology_id",
    );
    const professionalInstitutionIndex = migration.indexOf(
      "ALTER TABLE professional_institutions ADD UNIQUE KEY uniq_prof_inst_user_institution",
    );
    const shiftFk = migration.indexOf(
      "CONSTRAINT fk_operational_events_shift_topology",
    );
    const assignmentFk = migration.indexOf(
      "CONSTRAINT fk_operational_events_assignment_topology",
    );

    expect(shiftIndex).toBeGreaterThanOrEqual(0);
    expect(assignmentIndex).toBeGreaterThanOrEqual(0);
    expect(hospitalIndex).toBeGreaterThanOrEqual(0);
    expect(sectorIndex).toBeGreaterThanOrEqual(0);
    expect(scheduleContextIndex).toBeGreaterThanOrEqual(0);
    expect(professionalInstitutionIndex).toBeGreaterThanOrEqual(0);
    expect(shiftFk).toBeGreaterThan(shiftIndex);
    expect(assignmentFk).toBeGreaterThan(assignmentIndex);
    expect(
      migration.indexOf("CONSTRAINT fk_operational_events_hospital_topology"),
    ).toBeGreaterThan(hospitalIndex);
    expect(
      migration.indexOf("CONSTRAINT fk_operational_events_sector_topology"),
    ).toBeGreaterThan(sectorIndex);
    expect(
      migration.indexOf(
        "CONSTRAINT fk_operational_events_schedule_context_topology",
      ),
    ).toBeGreaterThan(scheduleContextIndex);
    expect(
      migration.indexOf(
        "CONSTRAINT fk_operational_events_actor_user_institution",
      ),
    ).toBeGreaterThan(professionalInstitutionIndex);
    expect(
      migration.indexOf(
        "CONSTRAINT fk_operational_event_recipient_user_institution",
      ),
    ).toBeGreaterThan(professionalInstitutionIndex);
  });

  it("não introduz endereço de destinatário no evento ou delivery", () => {
    const recipientSection = migration.match(
      /CREATE TABLE IF NOT EXISTS operational_event_recipients[\s\S]*?ENGINE=InnoDB;/,
    )?.[0];
    const deliverySection = migration.match(
      /CREATE TABLE IF NOT EXISTS notification_deliveries[\s\S]*?ENGINE=InnoDB;/,
    )?.[0];

    expect(recipientSection).toBeDefined();
    expect(deliverySection).toBeDefined();
    expect(recipientSection).not.toMatch(/\bemail\b/i);
    expect(deliverySection).not.toMatch(
      /recipient_email|email_address|destination/i,
    );
    expect(deliverySection).not.toMatch(/provider_receipt/i);
    expect(recipientSection).toContain(
      "recipient_kind ENUM('USER', 'SCHEDULE_INVITE')",
    );
    expect(deliverySection).toContain(
      "UNIQUE KEY uniq_notification_delivery_dedup",
    );
  });
});
