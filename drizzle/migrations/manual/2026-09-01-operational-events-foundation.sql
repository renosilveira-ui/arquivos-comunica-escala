-- 2026-09-01 — foundation corporativa de eventos operacionais.
--
-- Aditiva e rerodável. Esta migração só cria armazenamento; não migra
-- emissores existentes, não enfileira mensagens e não chama provedores.
-- Endereço de e-mail não é armazenado em recipients/deliveries: o alvo é uma
-- conta ou convite nominal já persistidos. Qualquer resolução futura deverá
-- revalidar identidade, escopo e confiança antes de entregar algo.

-- As FKs compostas exigem chaves-pai com a topologia completa. `id` já é PK;
-- estas chaves apenas tornam a combinação explicitamente referenciável e
-- bloqueiam cruzamento entre tenants/setores no banco.
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'hospitals'
    AND INDEX_NAME = 'uniq_hospitals_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE hospitals ADD UNIQUE KEY uniq_hospitals_topology_id (institution_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sectors'
    AND INDEX_NAME = 'uniq_sectors_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE sectors ADD UNIQUE KEY uniq_sectors_topology_id (institution_id, hospital_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND INDEX_NAME = 'uniq_schedule_context_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE schedule_contexts ADD UNIQUE KEY uniq_schedule_context_topology_id (institution_id, hospital_id, sector_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND INDEX_NAME = 'uniq_shift_instances_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE shift_instances ADD UNIQUE KEY uniq_shift_instances_topology_id (institution_id, hospital_id, sector_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_assignments_v2'
    AND INDEX_NAME = 'uniq_shift_assignments_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE shift_assignments_v2 ADD UNIQUE KEY uniq_shift_assignments_topology_id (institution_id, hospital_id, sector_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND INDEX_NAME = 'uniq_schedule_invites_id_institution'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE schedule_invites ADD UNIQUE KEY uniq_schedule_invites_id_institution (id, institution_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A FK composta USER → instituição exige uma chave-pai única. A guarda usa
-- as colunas, não um nome gerado, porque deployments legados podem divergir.
SET @idx_exists := (
  SELECT COUNT(*)
  FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'professional_institutions'
    GROUP BY INDEX_NAME
    HAVING MAX(NON_UNIQUE) = 0
      AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'user_id,institution_id'
  ) AS unique_user_institution_keys
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE professional_institutions ADD UNIQUE KEY uniq_prof_inst_user_institution (user_id, institution_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS operational_events (
  id INT NOT NULL AUTO_INCREMENT,
  idempotency_key_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  event_hash VARCHAR(64) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  delivery_policy ENUM('NOTIFY', 'BROADCAST', 'SILENT_AUDITED') NOT NULL,
  recipient_resolution ENUM('RESOLVED', 'NO_ELIGIBLE_RECIPIENTS', 'NO_RESPONSIBLE_MANAGERS', 'NO_DELIVERABLE_RECIPIENTS', 'NOT_APPLICABLE') NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL,
  aggregate_id INT NOT NULL,
  aggregate_version INT NOT NULL,
  transition_from VARCHAR(80) NULL,
  transition_to VARCHAR(80) NULL,
  actor_kind ENUM('USER', 'SYSTEM') NOT NULL,
  actor_user_id INT NULL,
  actor_professional_id INT NULL,
  actor_role VARCHAR(32) NOT NULL,
  institution_id INT NOT NULL,
  hospital_id INT NULL,
  scope_kind ENUM('INSTITUTION', 'HOSPITAL', 'SECTOR') NOT NULL,
  sector_id INT NULL,
  schedule_context_id INT NULL,
  shift_instance_id INT NULL,
  assignment_id INT NULL,
  occurred_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_operational_event_idempotency (institution_id, idempotency_key_hash),
  UNIQUE KEY uniq_operational_events_id_institution (id, institution_id),
  KEY idx_operational_events_context (institution_id, hospital_id, sector_id, occurred_at),
  KEY idx_operational_events_aggregate (aggregate_type, aggregate_id, aggregate_version),
  KEY idx_operational_events_shift (shift_instance_id),
  CONSTRAINT fk_operational_events_actor_user
    FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT fk_operational_events_actor_user_institution
    FOREIGN KEY (actor_user_id, institution_id)
    REFERENCES professional_institutions(user_id, institution_id),
  CONSTRAINT fk_operational_events_actor_professional
    FOREIGN KEY (actor_professional_id) REFERENCES professionals(id),
  CONSTRAINT fk_operational_events_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_operational_events_hospital
    FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_operational_events_sector
    FOREIGN KEY (sector_id) REFERENCES sectors(id),
  CONSTRAINT fk_operational_events_schedule_context
    FOREIGN KEY (schedule_context_id) REFERENCES schedule_contexts(id),
  CONSTRAINT fk_operational_events_shift
    FOREIGN KEY (shift_instance_id) REFERENCES shift_instances(id),
  CONSTRAINT fk_operational_events_assignment
    FOREIGN KEY (assignment_id) REFERENCES shift_assignments_v2(id),
  CONSTRAINT fk_operational_events_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals(institution_id, id),
  CONSTRAINT fk_operational_events_sector_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors(institution_id, hospital_id, id),
  CONSTRAINT fk_operational_events_schedule_context_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id, schedule_context_id)
    REFERENCES schedule_contexts(institution_id, hospital_id, sector_id, id),
  CONSTRAINT fk_operational_events_shift_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id, shift_instance_id)
    REFERENCES shift_instances(institution_id, hospital_id, sector_id, id),
  CONSTRAINT fk_operational_events_assignment_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id, assignment_id)
    REFERENCES shift_assignments_v2(institution_id, hospital_id, sector_id, id),
  CONSTRAINT chk_operational_event_scope
    CHECK (
      (
        scope_kind = 'INSTITUTION'
        AND hospital_id IS NULL
        AND sector_id IS NULL
        AND schedule_context_id IS NULL
        AND shift_instance_id IS NULL
        AND assignment_id IS NULL
      )
      OR
      (
        scope_kind = 'HOSPITAL'
        AND hospital_id IS NOT NULL
        AND sector_id IS NULL
        AND schedule_context_id IS NULL
        AND shift_instance_id IS NULL
        AND assignment_id IS NULL
      )
      OR
      (
        scope_kind = 'SECTOR'
        AND hospital_id IS NOT NULL
        AND sector_id IS NOT NULL
      )
    ),
  CONSTRAINT chk_operational_event_actor
    CHECK (
      (
        actor_kind = 'USER'
        AND actor_user_id IS NOT NULL
      )
      OR
      (
        actor_kind = 'SYSTEM'
        AND actor_user_id IS NULL
        AND actor_professional_id IS NULL
      )
    )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS operational_event_related_contexts (
  id INT NOT NULL AUTO_INCREMENT,
  operational_event_id INT NOT NULL,
  relation_kind ENUM('COUNTERPART', 'AFFECTED_SCOPE') NOT NULL,
  institution_id INT NOT NULL,
  hospital_id INT NULL,
  scope_kind ENUM('INSTITUTION', 'HOSPITAL', 'SECTOR') NOT NULL,
  sector_id INT NULL,
  schedule_context_id INT NULL,
  shift_instance_id INT NULL,
  assignment_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_operational_event_related_context (operational_event_id, relation_kind, id),
  CONSTRAINT fk_operational_event_related_context_event_institution
    FOREIGN KEY (operational_event_id, institution_id)
    REFERENCES operational_events(id, institution_id) ON DELETE CASCADE,
  CONSTRAINT fk_operational_event_related_context_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_operational_event_related_context_hospital
    FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_operational_event_related_context_sector
    FOREIGN KEY (sector_id) REFERENCES sectors(id),
  CONSTRAINT fk_operational_event_related_context_schedule_context
    FOREIGN KEY (schedule_context_id) REFERENCES schedule_contexts(id),
  CONSTRAINT fk_operational_event_related_context_shift
    FOREIGN KEY (shift_instance_id) REFERENCES shift_instances(id),
  CONSTRAINT fk_operational_event_related_context_assignment
    FOREIGN KEY (assignment_id) REFERENCES shift_assignments_v2(id),
  CONSTRAINT fk_operational_event_related_context_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals(institution_id, id),
  CONSTRAINT fk_operational_event_related_context_sector_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors(institution_id, hospital_id, id),
  CONSTRAINT fk_operational_event_related_context_schedule_context_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id, schedule_context_id)
    REFERENCES schedule_contexts(institution_id, hospital_id, sector_id, id),
  CONSTRAINT fk_operational_event_related_context_shift_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id, shift_instance_id)
    REFERENCES shift_instances(institution_id, hospital_id, sector_id, id),
  CONSTRAINT fk_operational_event_related_context_assignment_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id, assignment_id)
    REFERENCES shift_assignments_v2(institution_id, hospital_id, sector_id, id),
  CONSTRAINT chk_operational_event_related_context_scope
    CHECK (
      (
        scope_kind = 'INSTITUTION'
        AND hospital_id IS NULL
        AND sector_id IS NULL
        AND schedule_context_id IS NULL
        AND shift_instance_id IS NULL
        AND assignment_id IS NULL
      )
      OR
      (
        scope_kind = 'HOSPITAL'
        AND hospital_id IS NOT NULL
        AND sector_id IS NULL
        AND schedule_context_id IS NULL
        AND shift_instance_id IS NULL
        AND assignment_id IS NULL
      )
      OR
      (
        scope_kind = 'SECTOR'
        AND hospital_id IS NOT NULL
        AND sector_id IS NOT NULL
      )
    )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS operational_event_recipients (
  id INT NOT NULL AUTO_INCREMENT,
  operational_event_id INT NOT NULL,
  institution_id INT NOT NULL,
  recipient_kind ENUM('USER', 'SCHEDULE_INVITE') NOT NULL,
  user_id INT NULL,
  schedule_invite_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_operational_event_recipient_user (operational_event_id, user_id),
  UNIQUE KEY uniq_operational_event_recipient_invite (operational_event_id, schedule_invite_id),
  KEY idx_operational_event_recipient_target (recipient_kind, user_id, schedule_invite_id),
  CONSTRAINT fk_operational_event_recipients_event
    FOREIGN KEY (operational_event_id) REFERENCES operational_events(id) ON DELETE CASCADE,
  CONSTRAINT fk_operational_event_recipient_event_institution
    FOREIGN KEY (operational_event_id, institution_id)
    REFERENCES operational_events(id, institution_id) ON DELETE CASCADE,
  CONSTRAINT fk_operational_event_recipient_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_operational_event_recipients_user
    FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_operational_event_recipient_user_institution
    FOREIGN KEY (user_id, institution_id)
    REFERENCES professional_institutions(user_id, institution_id),
  CONSTRAINT fk_operational_event_recipients_schedule_invite
    FOREIGN KEY (schedule_invite_id) REFERENCES schedule_invites(id),
  CONSTRAINT fk_operational_event_recipient_schedule_invite_institution
    FOREIGN KEY (schedule_invite_id, institution_id)
    REFERENCES schedule_invites(id, institution_id),
  CONSTRAINT chk_operational_event_recipient_target
    CHECK (
      (recipient_kind = 'USER' AND user_id IS NOT NULL AND schedule_invite_id IS NULL)
      OR
      (recipient_kind = 'SCHEDULE_INVITE' AND user_id IS NULL AND schedule_invite_id IS NOT NULL)
    )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INT NOT NULL AUTO_INCREMENT,
  operational_event_recipient_id INT NOT NULL,
  channel ENUM('PUSH', 'EMAIL') NOT NULL,
  status ENUM('QUEUED', 'PROCESSING', 'PROVIDER_ACCEPTED', 'DELIVERED', 'FAILED', 'DEAD', 'SKIPPED') NOT NULL DEFAULT 'QUEUED',
  dedup_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL,
  lease_until DATETIME NULL,
  provider_accepted_at DATETIME NULL,
  delivered_at DATETIME NULL,
  provider_reference VARCHAR(255) NULL,
  last_error_code VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_notification_delivery_dedup (dedup_key),
  UNIQUE KEY uniq_notification_delivery_channel (operational_event_recipient_id, channel),
  KEY idx_notification_deliveries_ready (status, available_at, id),
  KEY idx_notification_deliveries_recipient (operational_event_recipient_id, id),
  CONSTRAINT fk_notification_deliveries_recipient
    FOREIGN KEY (operational_event_recipient_id) REFERENCES operational_event_recipients(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_operational_email_trust (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  email_hash VARCHAR(64) NOT NULL,
  state ENUM('PENDING', 'TRUSTED', 'REVOKED') NOT NULL DEFAULT 'PENDING',
  source ENUM('ADMIN_CREATED', 'INVITE_ACTIVATED', 'USER_CONFIRMED', 'LEGACY') NOT NULL,
  trusted_at DATETIME NULL,
  invalidated_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_operational_email_trust_user (user_id),
  KEY idx_operational_email_trust_hash (email_hash),
  CONSTRAINT fk_operational_email_trust_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS operational_email_verification_tokens (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  email_hash VARCHAR(64) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_operational_email_verification_token (token_hash),
  KEY idx_operational_email_verification_user (user_id, expires_at),
  CONSTRAINT fk_operational_email_verification_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
