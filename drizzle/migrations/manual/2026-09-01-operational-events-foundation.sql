-- 2026-09-01 — foundation corporativa de eventos operacionais.
--
-- Aditiva e rerodável. Esta migração só cria armazenamento; não migra
-- emissores existentes, não enfileira mensagens e não chama provedores.
-- Endereço de e-mail não é armazenado em recipients/deliveries: o alvo é uma
-- conta ou convite nominal já persistidos. Qualquer resolução futura deverá
-- revalidar identidade, escopo e confiança antes de entregar algo.
--
-- Esta fundação não autoriza writer, worker ou entrega. Uma ativação futura
-- só pode acontecer depois de provar e impor no caminho de escrita que:
--   1. actor_user_id e actor_professional_id representam o mesmo vínculo
--      institucional; e
--   2. quando contexto, turno e alocação coexistem, a alocação pertence ao
--      turno e o turno pertence ao contexto informado.
-- As FKs abaixo preservam a topologia comum, mas não substituem essas duas
-- verificações semânticas de ativação.

-- Uma tabela de fundação já existente só é aceitável se corresponder
-- integralmente ao contrato desta migração. CREATE TABLE IF NOT EXISTS, sem
-- esta guarda, aceitaria silenciosamente uma tabela parcial e deixaria a
-- fundação com FKs, índices ou checks ausentes.
--
-- O fingerprint inclui engine, colunas ordenadas, índices, FKs (inclusive
-- schema e ações de update/delete) e checks. Valores herdados do schema
-- corrente (collation padrão e referências internas) são normalizados para
-- que a mesma migration seja válida em bancos MySQL distintos.
-- A guarda prévia acontece antes de qualquer ALTER em tabelas-pai; a posterior
-- confirma o contrato das seis tabelas.
-- O limite de GROUP_CONCAT é elevado somente para o fingerprint e restaurado
-- depois da validação posterior, evitando truncar contratos extensos.
-- Drizzle materializa defaultNow() como NOW(), enquanto a DDL manual usa
-- CURRENT_TIMESTAMP; ambos descrevem o mesmo default de timestamp e o
-- fingerprint normaliza somente essa grafia de catálogo.
SET @operational_events_contract_previous_group_concat_max_len := @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 65535;

-- Não usar IF NOT EXISTS aqui: uma tabela temporária inesperada na conexão
-- também precisa falhar, e nunca substituir o contrato esperado.
CREATE TEMPORARY TABLE _operational_events_contract_expected (
  table_name VARCHAR(64) NOT NULL,
  contract_hash CHAR(64) NOT NULL,
  PRIMARY KEY (table_name)
) ENGINE=MEMORY;

INSERT INTO _operational_events_contract_expected (table_name, contract_hash) VALUES
  ('notification_deliveries', '5b6a9aa1e1c0b9f6c7c802e1426dc5a127a89a6a51a32a08df274a45bc831696'),
  ('operational_email_verification_tokens', '2c4e53e3bde09ac0988783e3ededd7d0df8c09afcace4b9b10f5975f0c81a3d0'),
  ('operational_event_recipients', 'e31345f78c453327f914db495583ddfd3ec1854ff8fca2980748a13f61a00a28'),
  ('operational_event_related_contexts', 'c60097a40c96471bbb11b7b1fb00b0fddf3d22a94040801f1615037ab3d5a7ff'),
  ('operational_events', '4e555009bf9ff1d7c7ecdd31ca515da0786201e34d8c685ff2a34c9647104568'),
  ('user_operational_email_trust', '60e2426c4e90c52a7a4cc169e7519040dfed86365fc53a31537b4ee14c97f10c');

SET @operational_events_contract_preflight_mismatches := (
  SELECT COUNT(*)
  FROM _operational_events_contract_expected AS expected_contract
  INNER JOIN (
    SELECT
      tables.TABLE_NAME AS table_name,
      SHA2(
        CONCAT_WS(
          '|',
          tables.TABLE_TYPE,
          COALESCE(tables.ENGINE, ''),
          CASE
            WHEN tables.TABLE_COLLATION = (
              SELECT schema_defaults.DEFAULT_COLLATION_NAME
              FROM INFORMATION_SCHEMA.SCHEMATA AS schema_defaults
              WHERE schema_defaults.SCHEMA_NAME = tables.TABLE_SCHEMA
            ) THEN '<DATABASE_DEFAULT>'
            ELSE COALESCE(tables.TABLE_COLLATION, '<NULL>')
          END,
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                columns.ORDINAL_POSITION,
                columns.COLUMN_NAME,
                LOWER(columns.COLUMN_TYPE),
                columns.IS_NULLABLE,
                CASE
                  WHEN UPPER(COALESCE(columns.COLUMN_DEFAULT, '')) IN ('NOW()', 'CURRENT_TIMESTAMP()') THEN 'CURRENT_TIMESTAMP'
                  ELSE COALESCE(UPPER(columns.COLUMN_DEFAULT), '<NULL>')
                END,
                LOWER(COALESCE(columns.EXTRA, '')),
                CASE
                  WHEN columns.CHARACTER_SET_NAME IS NULL THEN '<NULL>'
                  WHEN columns.COLLATION_NAME = tables.TABLE_COLLATION THEN '<TABLE_DEFAULT>'
                  ELSE CONCAT(
                    columns.CHARACTER_SET_NAME,
                    '/',
                    columns.COLLATION_NAME
                  )
                END,
                COALESCE(columns.GENERATION_EXPRESSION, '')
              )
              ORDER BY columns.ORDINAL_POSITION
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.COLUMNS AS columns
            WHERE columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
              AND columns.TABLE_NAME = tables.TABLE_NAME
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                indexes.INDEX_NAME,
                indexes.NON_UNIQUE,
                indexes.SEQ_IN_INDEX,
                indexes.COLUMN_NAME,
                COALESCE(indexes.COLLATION, '<NULL>'),
                COALESCE(indexes.SUB_PART, '<NULL>'),
                indexes.INDEX_TYPE,
                COALESCE(indexes.IS_VISIBLE, '<NULL>')
              )
              ORDER BY indexes.INDEX_NAME, indexes.SEQ_IN_INDEX
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.STATISTICS AS indexes
            WHERE indexes.TABLE_SCHEMA = tables.TABLE_SCHEMA
              AND indexes.TABLE_NAME = tables.TABLE_NAME
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                key_columns.CONSTRAINT_NAME,
                key_columns.ORDINAL_POSITION,
                key_columns.COLUMN_NAME,
                CASE
                  WHEN key_columns.REFERENCED_TABLE_SCHEMA = tables.TABLE_SCHEMA
                    THEN '<CURRENT_SCHEMA>'
                  ELSE key_columns.REFERENCED_TABLE_SCHEMA
                END,
                key_columns.REFERENCED_TABLE_NAME,
                key_columns.REFERENCED_COLUMN_NAME,
                referential_constraints.MATCH_OPTION,
                referential_constraints.UPDATE_RULE,
                referential_constraints.DELETE_RULE
              )
              ORDER BY key_columns.CONSTRAINT_NAME, key_columns.ORDINAL_POSITION
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS key_columns
            INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS referential_constraints
              ON referential_constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
              AND referential_constraints.TABLE_NAME = key_columns.TABLE_NAME
              AND referential_constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
            WHERE key_columns.CONSTRAINT_SCHEMA = tables.TABLE_SCHEMA
              AND key_columns.TABLE_NAME = tables.TABLE_NAME
              AND key_columns.REFERENCED_TABLE_NAME IS NOT NULL
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                table_constraints.CONSTRAINT_NAME,
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(
                        REPLACE(UPPER(check_constraints.CHECK_CLAUSE), CHAR(96), ''),
                        '_UTF8MB4',
                        ''
                      ),
                      ' ',
                      ''
                    ),
                    CHAR(10),
                    ''
                  ),
                  CHAR(13),
                  ''
                )
              )
              ORDER BY table_constraints.CONSTRAINT_NAME
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS table_constraints
            INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS check_constraints
              ON check_constraints.CONSTRAINT_SCHEMA = table_constraints.CONSTRAINT_SCHEMA
              AND check_constraints.CONSTRAINT_NAME = table_constraints.CONSTRAINT_NAME
            WHERE table_constraints.CONSTRAINT_SCHEMA = tables.TABLE_SCHEMA
              AND table_constraints.TABLE_NAME = tables.TABLE_NAME
              AND table_constraints.CONSTRAINT_TYPE = 'CHECK'
          ), '')
        ),
        256
      ) AS contract_hash
    FROM INFORMATION_SCHEMA.TABLES AS tables
    WHERE tables.TABLE_SCHEMA = DATABASE()
      AND tables.TABLE_NAME IN (
        'operational_events',
        'operational_event_related_contexts',
        'operational_event_recipients',
        'notification_deliveries',
        'user_operational_email_trust',
        'operational_email_verification_tokens'
      )
  ) AS actual_contract
    ON actual_contract.table_name = expected_contract.table_name
  WHERE actual_contract.contract_hash <> expected_contract.contract_hash
);
SET @operational_events_contract_guard_sql := IF(
  @operational_events_contract_preflight_mismatches = 0,
  'SELECT 1',
  'SELECT 1 FROM __operational_events_contract_preflight_rejected__'
);
PREPARE operational_events_contract_preflight_stmt FROM @operational_events_contract_guard_sql;
EXECUTE operational_events_contract_preflight_stmt;
DEALLOCATE PREPARE operational_events_contract_preflight_stmt;

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

SET @operational_events_contract_postflight_mismatches := (
  SELECT COUNT(*)
  FROM _operational_events_contract_expected AS expected_contract
  LEFT JOIN (
    SELECT
      tables.TABLE_NAME AS table_name,
      SHA2(
        CONCAT_WS(
          '|',
          tables.TABLE_TYPE,
          COALESCE(tables.ENGINE, ''),
          CASE
            WHEN tables.TABLE_COLLATION = (
              SELECT schema_defaults.DEFAULT_COLLATION_NAME
              FROM INFORMATION_SCHEMA.SCHEMATA AS schema_defaults
              WHERE schema_defaults.SCHEMA_NAME = tables.TABLE_SCHEMA
            ) THEN '<DATABASE_DEFAULT>'
            ELSE COALESCE(tables.TABLE_COLLATION, '<NULL>')
          END,
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                columns.ORDINAL_POSITION,
                columns.COLUMN_NAME,
                LOWER(columns.COLUMN_TYPE),
                columns.IS_NULLABLE,
                CASE
                  WHEN UPPER(COALESCE(columns.COLUMN_DEFAULT, '')) IN ('NOW()', 'CURRENT_TIMESTAMP()') THEN 'CURRENT_TIMESTAMP'
                  ELSE COALESCE(UPPER(columns.COLUMN_DEFAULT), '<NULL>')
                END,
                LOWER(COALESCE(columns.EXTRA, '')),
                CASE
                  WHEN columns.CHARACTER_SET_NAME IS NULL THEN '<NULL>'
                  WHEN columns.COLLATION_NAME = tables.TABLE_COLLATION THEN '<TABLE_DEFAULT>'
                  ELSE CONCAT(
                    columns.CHARACTER_SET_NAME,
                    '/',
                    columns.COLLATION_NAME
                  )
                END,
                COALESCE(columns.GENERATION_EXPRESSION, '')
              )
              ORDER BY columns.ORDINAL_POSITION
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.COLUMNS AS columns
            WHERE columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
              AND columns.TABLE_NAME = tables.TABLE_NAME
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                indexes.INDEX_NAME,
                indexes.NON_UNIQUE,
                indexes.SEQ_IN_INDEX,
                indexes.COLUMN_NAME,
                COALESCE(indexes.COLLATION, '<NULL>'),
                COALESCE(indexes.SUB_PART, '<NULL>'),
                indexes.INDEX_TYPE,
                COALESCE(indexes.IS_VISIBLE, '<NULL>')
              )
              ORDER BY indexes.INDEX_NAME, indexes.SEQ_IN_INDEX
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.STATISTICS AS indexes
            WHERE indexes.TABLE_SCHEMA = tables.TABLE_SCHEMA
              AND indexes.TABLE_NAME = tables.TABLE_NAME
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                key_columns.CONSTRAINT_NAME,
                key_columns.ORDINAL_POSITION,
                key_columns.COLUMN_NAME,
                CASE
                  WHEN key_columns.REFERENCED_TABLE_SCHEMA = tables.TABLE_SCHEMA
                    THEN '<CURRENT_SCHEMA>'
                  ELSE key_columns.REFERENCED_TABLE_SCHEMA
                END,
                key_columns.REFERENCED_TABLE_NAME,
                key_columns.REFERENCED_COLUMN_NAME,
                referential_constraints.MATCH_OPTION,
                referential_constraints.UPDATE_RULE,
                referential_constraints.DELETE_RULE
              )
              ORDER BY key_columns.CONSTRAINT_NAME, key_columns.ORDINAL_POSITION
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS key_columns
            INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS referential_constraints
              ON referential_constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
              AND referential_constraints.TABLE_NAME = key_columns.TABLE_NAME
              AND referential_constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
            WHERE key_columns.CONSTRAINT_SCHEMA = tables.TABLE_SCHEMA
              AND key_columns.TABLE_NAME = tables.TABLE_NAME
              AND key_columns.REFERENCED_TABLE_NAME IS NOT NULL
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                table_constraints.CONSTRAINT_NAME,
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(
                        REPLACE(UPPER(check_constraints.CHECK_CLAUSE), CHAR(96), ''),
                        '_UTF8MB4',
                        ''
                      ),
                      ' ',
                      ''
                    ),
                    CHAR(10),
                    ''
                  ),
                  CHAR(13),
                  ''
                )
              )
              ORDER BY table_constraints.CONSTRAINT_NAME
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS table_constraints
            INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS check_constraints
              ON check_constraints.CONSTRAINT_SCHEMA = table_constraints.CONSTRAINT_SCHEMA
              AND check_constraints.CONSTRAINT_NAME = table_constraints.CONSTRAINT_NAME
            WHERE table_constraints.CONSTRAINT_SCHEMA = tables.TABLE_SCHEMA
              AND table_constraints.TABLE_NAME = tables.TABLE_NAME
              AND table_constraints.CONSTRAINT_TYPE = 'CHECK'
          ), '')
        ),
        256
      ) AS contract_hash
    FROM INFORMATION_SCHEMA.TABLES AS tables
    WHERE tables.TABLE_SCHEMA = DATABASE()
      AND tables.TABLE_NAME IN (
        'operational_events',
        'operational_event_related_contexts',
        'operational_event_recipients',
        'notification_deliveries',
        'user_operational_email_trust',
        'operational_email_verification_tokens'
      )
  ) AS actual_contract
    ON actual_contract.table_name = expected_contract.table_name
  WHERE actual_contract.table_name IS NULL
    OR actual_contract.contract_hash <> expected_contract.contract_hash
);
SET @operational_events_contract_guard_sql := IF(
  @operational_events_contract_postflight_mismatches = 0,
  'SELECT 1',
  'SELECT 1 FROM __operational_events_contract_postflight_rejected__'
);
PREPARE operational_events_contract_postflight_stmt FROM @operational_events_contract_guard_sql;
EXECUTE operational_events_contract_postflight_stmt;
DEALLOCATE PREPARE operational_events_contract_postflight_stmt;

SET @operational_events_contract_restore_session_sql := CONCAT(
  'SET SESSION group_concat_max_len = ',
  @operational_events_contract_previous_group_concat_max_len
);
PREPARE operational_events_contract_restore_session_stmt
  FROM @operational_events_contract_restore_session_sql;
EXECUTE operational_events_contract_restore_session_stmt;
DEALLOCATE PREPARE operational_events_contract_restore_session_stmt;

-- A tabela temporária existe apenas durante esta aplicação. A remoção ocorre
-- somente depois de todo o contrato passar; se ela já existia antes, o CREATE
-- inicial falha fechado e nenhuma limpeza pode mascarar esse estado.
DROP TEMPORARY TABLE _operational_events_contract_expected;
