-- 2026-09-10 — recuperação de credenciais com outbox durável.
--
-- Aditiva e rerodável. A tabela homônima só é aceita quando colunas, índices,
-- FKs e CHECKs correspondem integralmente ao contrato esperado. O preflight
-- ocorre antes do primeiro DDL persistente; o postflight recalcula o catálogo.

SET @auth_recovery_previous_group_concat_max_len := @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 65535;

-- Manifestos legíveis são a fonte da expectativa; o próprio MySQL calcula os
-- hashes. Assim, toda coluna/índice/FK/CHECK esperado fica revisável no diff e
-- nenhum digest mágico pode ocultar um objeto extra ou ausente.
SET @auth_recovery_expected_columns_manifest := CONCAT_WS('|',
  '1:id:int:NO:<NULL>:auto_increment:<NULL>:<NULL>',
  '2:kind:enum(''SELF_SERVICE'',''ADMIN_INITIATED''):NO:<NULL>::utf8mb4:<TABLE_DEFAULT>',
  '3:request_actor_kind:enum(''UNAUTHENTICATED'',''AUTHENTICATED_ADMIN''):NO:<NULL>::utf8mb4:<TABLE_DEFAULT>',
  '4:state:enum(''QUEUED'',''PROCESSING'',''ACTIVE'',''USED'',''REVOKED'',''SKIPPED'',''DEAD''):NO:QUEUED::utf8mb4:<TABLE_DEFAULT>',
  '5:target_user_id:int:YES:<NULL>::<NULL>:<NULL>',
  '6:target_membership_id:int:YES:<NULL>::<NULL>:<NULL>',
  '7:requested_by_user_id:int:YES:<NULL>::<NULL>:<NULL>',
  '8:requested_by_membership_id:int:YES:<NULL>::<NULL>:<NULL>',
  '9:institution_id:int:YES:<NULL>::<NULL>:<NULL>',
  '10:expected_target_session_version:int:YES:<NULL>::<NULL>:<NULL>',
  '11:expected_actor_session_version:int:YES:<NULL>::<NULL>:<NULL>',
  '12:email_hash:varchar(64):YES:<NULL>::utf8mb4:utf8mb4_bin',
  '13:token_hash:varchar(64):NO:<NULL>::utf8mb4:utf8mb4_bin',
  '14:sealed_payload:text:YES:<NULL>::utf8mb4:<TABLE_DEFAULT>',
  '15:expires_at:datetime:YES:<NULL>::<NULL>:<NULL>',
  '16:available_at:datetime:NO:<NULL>::<NULL>:<NULL>',
  '17:delivery_deadline_at:datetime:NO:<NULL>::<NULL>:<NULL>',
  '18:lease_token:varchar(36):YES:<NULL>::utf8mb4:utf8mb4_bin',
  '19:lease_until:datetime:YES:<NULL>::<NULL>:<NULL>',
  '20:attempt_count:int:NO:0::<NULL>:<NULL>',
  '21:provider_accepted_at:datetime:YES:<NULL>::<NULL>:<NULL>',
  '22:used_at:datetime:YES:<NULL>::<NULL>:<NULL>',
  '23:finished_at:datetime:YES:<NULL>::<NULL>:<NULL>',
  '24:last_error_code:varchar(80):YES:<NULL>::utf8mb4:<TABLE_DEFAULT>',
  '25:created_at:timestamp:NO:CURRENT_TIMESTAMP:default_generated:<NULL>:<NULL>',
  '26:updated_at:timestamp:NO:CURRENT_TIMESTAMP:default_generated on update current_timestamp:<NULL>:<NULL>',
  '27:active_slot:tinyint:YES:<NULL>::<NULL>:<NULL>'
);
SET @auth_recovery_expected_indexes_manifest := CONCAT_WS('|',
  'fk_auth_recovery_actor_membership:1:1:requested_by_membership_id:A:<NULL>:BTREE:YES',
  'fk_auth_recovery_actor_user:1:1:requested_by_user_id:A:<NULL>:BTREE:YES',
  'fk_auth_recovery_institution:1:1:institution_id:A:<NULL>:BTREE:YES',
  'fk_auth_recovery_target_membership:1:1:target_membership_id:A:<NULL>:BTREE:YES',
  'idx_auth_recovery_ready:1:1:kind:A:<NULL>:BTREE:YES',
  'idx_auth_recovery_ready:1:2:state:A:<NULL>:BTREE:YES',
  'idx_auth_recovery_ready:1:3:available_at:A:<NULL>:BTREE:YES',
  'idx_auth_recovery_ready:1:4:delivery_deadline_at:A:<NULL>:BTREE:YES',
  'idx_auth_recovery_ready:1:5:id:A:<NULL>:BTREE:YES',
  'idx_auth_recovery_target:1:1:target_user_id:A:<NULL>:BTREE:YES',
  'idx_auth_recovery_target:1:2:state:A:<NULL>:BTREE:YES',
  'idx_auth_recovery_target:1:3:id:A:<NULL>:BTREE:YES',
  'PRIMARY:0:1:id:A:<NULL>:BTREE:YES',
  'uniq_auth_recovery_active_target:0:1:target_user_id:A:<NULL>:BTREE:YES',
  'uniq_auth_recovery_active_target:0:2:active_slot:A:<NULL>:BTREE:YES',
  'uniq_auth_recovery_token_hash:0:1:token_hash:A:<NULL>:BTREE:YES'
);
SET @auth_recovery_expected_fks_manifest := CONCAT_WS('|',
  'fk_auth_recovery_actor_membership:1:requested_by_membership_id:<CURRENT_SCHEMA>:professional_institutions:id:NONE:RESTRICT:RESTRICT',
  'fk_auth_recovery_actor_user:1:requested_by_user_id:<CURRENT_SCHEMA>:users:id:NONE:RESTRICT:RESTRICT',
  'fk_auth_recovery_institution:1:institution_id:<CURRENT_SCHEMA>:institutions:id:NONE:RESTRICT:RESTRICT',
  'fk_auth_recovery_target_membership:1:target_membership_id:<CURRENT_SCHEMA>:professional_institutions:id:NONE:RESTRICT:RESTRICT',
  'fk_auth_recovery_target_user:1:target_user_id:<CURRENT_SCHEMA>:users:id:NONE:RESTRICT:RESTRICT'
);
-- CHECK_CLAUSE é normalizado removendo quoting, charset e whitespace, mas
-- preservando operadores, ordem e parênteses. O runner efêmero deve comparar
-- este manifesto ao catálogo antes de qualquer aplicação em staging.
SET @auth_recovery_expected_checks_manifest := CONCAT_WS('|',
  'chk_auth_recovery_active_binding:(STATE NOT IN (''ACTIVE'',''USED'') OR (TARGET_USER_ID IS NOT NULL AND TARGET_MEMBERSHIP_ID IS NOT NULL AND EXPECTED_TARGET_SESSION_VERSION IS NOT NULL AND EMAIL_HASH IS NOT NULL AND TOKEN_HASH IS NOT NULL AND EXPIRES_AT IS NOT NULL AND PROVIDER_ACCEPTED_AT IS NOT NULL AND SEALED_PAYLOAD IS NULL AND LEASE_TOKEN IS NULL AND LEASE_UNTIL IS NULL)):YES',
  'chk_auth_recovery_active_slot:((STATE = ''ACTIVE'' AND ACTIVE_SLOT = 1) OR (STATE <> ''ACTIVE'' AND ACTIVE_SLOT IS NULL)):YES',
  'chk_auth_recovery_actor_binding:((KIND = ''SELF_SERVICE'' AND REQUEST_ACTOR_KIND = ''UNAUTHENTICATED'' AND REQUESTED_BY_USER_ID IS NULL AND REQUESTED_BY_MEMBERSHIP_ID IS NULL AND INSTITUTION_ID IS NULL AND EXPECTED_ACTOR_SESSION_VERSION IS NULL) OR (KIND = ''ADMIN_INITIATED'' AND REQUEST_ACTOR_KIND = ''AUTHENTICATED_ADMIN'' AND TARGET_USER_ID IS NOT NULL AND TARGET_MEMBERSHIP_ID IS NOT NULL AND REQUESTED_BY_USER_ID IS NOT NULL AND REQUESTED_BY_MEMBERSHIP_ID IS NOT NULL AND INSTITUTION_ID IS NOT NULL AND EXPECTED_TARGET_SESSION_VERSION IS NOT NULL AND EXPECTED_ACTOR_SESSION_VERSION IS NOT NULL AND EMAIL_HASH IS NOT NULL AND TOKEN_HASH IS NOT NULL)):YES',
  'chk_auth_recovery_attempts:(ATTEMPT_COUNT >= 0 AND ATTEMPT_COUNT <= 5):YES',
  'chk_auth_recovery_deadline:(DELIVERY_DEADLINE_AT > AVAILABLE_AT):YES',
  'chk_auth_recovery_hashes:(TOKEN_HASH REGEXP ''^[0-9a-f]{64}$'' AND (EMAIL_HASH IS NULL OR EMAIL_HASH REGEXP ''^[0-9a-f]{64}$'')):YES',
  'chk_auth_recovery_state_payload:((STATE = ''QUEUED'' AND SEALED_PAYLOAD IS NOT NULL AND LEASE_TOKEN IS NULL AND LEASE_UNTIL IS NULL AND PROVIDER_ACCEPTED_AT IS NULL AND EXPIRES_AT IS NULL AND USED_AT IS NULL AND FINISHED_AT IS NULL AND ATTEMPT_COUNT < 5) OR (STATE = ''PROCESSING'' AND SEALED_PAYLOAD IS NOT NULL AND LEASE_TOKEN IS NOT NULL AND LEASE_UNTIL IS NOT NULL AND PROVIDER_ACCEPTED_AT IS NULL AND EXPIRES_AT IS NULL AND USED_AT IS NULL AND FINISHED_AT IS NULL AND ATTEMPT_COUNT >= 1) OR (STATE = ''ACTIVE'' AND SEALED_PAYLOAD IS NULL AND LEASE_TOKEN IS NULL AND LEASE_UNTIL IS NULL AND USED_AT IS NULL AND FINISHED_AT IS NULL AND EXPIRES_AT > PROVIDER_ACCEPTED_AT) OR (STATE = ''USED'' AND SEALED_PAYLOAD IS NULL AND LEASE_TOKEN IS NULL AND LEASE_UNTIL IS NULL AND USED_AT IS NOT NULL AND FINISHED_AT IS NOT NULL AND USED_AT = FINISHED_AT) OR (STATE = ''REVOKED'' AND SEALED_PAYLOAD IS NULL AND LEASE_TOKEN IS NULL AND LEASE_UNTIL IS NULL AND USED_AT IS NULL AND FINISHED_AT IS NOT NULL) OR (STATE IN (''SKIPPED'',''DEAD'') AND SEALED_PAYLOAD IS NULL AND LEASE_TOKEN IS NULL AND LEASE_UNTIL IS NULL AND PROVIDER_ACCEPTED_AT IS NULL AND EXPIRES_AT IS NULL AND USED_AT IS NULL AND FINISHED_AT IS NOT NULL)):YES'
);
SET @auth_recovery_expected_columns_hash := SHA2(@auth_recovery_expected_columns_manifest, 256);
SET @auth_recovery_expected_indexes_hash := SHA2(@auth_recovery_expected_indexes_manifest, 256);
SET @auth_recovery_expected_fks_hash := SHA2(@auth_recovery_expected_fks_manifest, 256);
SET @auth_recovery_expected_checks_hash := SHA2(
  REPLACE(UPPER(@auth_recovery_expected_checks_manifest), ' ', ''),
  256
);

SET @auth_recovery_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'auth_recovery_requests'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @auth_recovery_trigger_count := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND EVENT_OBJECT_TABLE = 'auth_recovery_requests'
);

SET @auth_recovery_columns_hash := (
  SELECT SHA2(
    GROUP_CONCAT(
      CONCAT_WS(
        ':',
        columns.ORDINAL_POSITION,
        columns.COLUMN_NAME,
        LOWER(columns.COLUMN_TYPE),
        columns.IS_NULLABLE,
        CASE
          WHEN UPPER(COALESCE(columns.COLUMN_DEFAULT, '')) IN ('NOW()', 'CURRENT_TIMESTAMP()')
            THEN 'CURRENT_TIMESTAMP'
          ELSE COALESCE(UPPER(columns.COLUMN_DEFAULT), '<NULL>')
        END,
        LOWER(COALESCE(columns.EXTRA, '')),
        COALESCE(columns.CHARACTER_SET_NAME, '<NULL>'),
        CASE
          WHEN columns.COLLATION_NAME = tables.TABLE_COLLATION THEN '<TABLE_DEFAULT>'
          ELSE COALESCE(columns.COLLATION_NAME, '<NULL>')
        END
      )
      ORDER BY columns.ORDINAL_POSITION
      SEPARATOR '|'
    ),
    256
  )
  FROM INFORMATION_SCHEMA.COLUMNS AS columns
  INNER JOIN INFORMATION_SCHEMA.TABLES AS tables
    ON tables.TABLE_SCHEMA = columns.TABLE_SCHEMA
    AND tables.TABLE_NAME = columns.TABLE_NAME
  WHERE columns.TABLE_SCHEMA = DATABASE()
    AND columns.TABLE_NAME = 'auth_recovery_requests'
);

SET @auth_recovery_indexes_hash := (
  SELECT SHA2(
    GROUP_CONCAT(
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
    ),
    256
  )
  FROM INFORMATION_SCHEMA.STATISTICS AS indexes
  WHERE indexes.TABLE_SCHEMA = DATABASE()
    AND indexes.TABLE_NAME = 'auth_recovery_requests'
);

SET @auth_recovery_fks_hash := (
  SELECT SHA2(
    GROUP_CONCAT(
      CONCAT_WS(
        ':',
        key_columns.CONSTRAINT_NAME,
        key_columns.ORDINAL_POSITION,
        key_columns.COLUMN_NAME,
        CASE
          WHEN key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() THEN '<CURRENT_SCHEMA>'
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
    ),
    256
  )
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS key_columns
  INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS referential_constraints
    ON referential_constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
    AND referential_constraints.TABLE_NAME = key_columns.TABLE_NAME
    AND referential_constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
  WHERE key_columns.CONSTRAINT_SCHEMA = DATABASE()
    AND key_columns.TABLE_NAME = 'auth_recovery_requests'
    AND key_columns.REFERENCED_TABLE_NAME IS NOT NULL
);

SET @auth_recovery_checks_hash := (
  SELECT SHA2(
    GROUP_CONCAT(
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
        ),
        COALESCE(table_constraints.ENFORCED, '<NULL>')
      )
      ORDER BY table_constraints.CONSTRAINT_NAME
      SEPARATOR '|'
    ),
    256
  )
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS table_constraints
  INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS check_constraints
    ON check_constraints.CONSTRAINT_SCHEMA = table_constraints.CONSTRAINT_SCHEMA
    AND check_constraints.CONSTRAINT_NAME = table_constraints.CONSTRAINT_NAME
  WHERE table_constraints.CONSTRAINT_SCHEMA = DATABASE()
    AND table_constraints.TABLE_NAME = 'auth_recovery_requests'
    AND table_constraints.CONSTRAINT_TYPE = 'CHECK'
);

SET @auth_recovery_preflight_ok := (
  @auth_recovery_table_count = 0
  OR (
    @auth_recovery_table_count = 1
    AND @auth_recovery_columns_hash = @auth_recovery_expected_columns_hash
    AND @auth_recovery_indexes_hash = @auth_recovery_expected_indexes_hash
    AND @auth_recovery_fks_hash = @auth_recovery_expected_fks_hash
    AND @auth_recovery_checks_hash = @auth_recovery_expected_checks_hash
    AND @auth_recovery_trigger_count = 0
    AND (
      SELECT COUNT(*)
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'auth_recovery_requests'
        AND TABLE_TYPE = 'BASE TABLE'
        AND ENGINE = 'InnoDB'
        AND COALESCE(CREATE_OPTIONS, '') = ''
        AND TABLE_COLLATION = (
          SELECT DEFAULT_COLLATION_NAME
          FROM INFORMATION_SCHEMA.SCHEMATA
          WHERE SCHEMA_NAME = DATABASE()
        )
    ) = 1
  )
);
SET @auth_recovery_preflight_sql := IF(
  @auth_recovery_preflight_ok,
  'SELECT 1',
  'SELECT 1 FROM __auth_recovery_contract_preflight_rejected__'
);
PREPARE auth_recovery_preflight_stmt FROM @auth_recovery_preflight_sql;
EXECUTE auth_recovery_preflight_stmt;
DEALLOCATE PREPARE auth_recovery_preflight_stmt;

CREATE TABLE IF NOT EXISTS auth_recovery_requests (
  id INT NOT NULL AUTO_INCREMENT,
  kind ENUM('SELF_SERVICE','ADMIN_INITIATED') NOT NULL,
  request_actor_kind ENUM('UNAUTHENTICATED','AUTHENTICATED_ADMIN') NOT NULL,
  state ENUM('QUEUED','PROCESSING','ACTIVE','USED','REVOKED','SKIPPED','DEAD') NOT NULL DEFAULT 'QUEUED',
  target_user_id INT NULL,
  target_membership_id INT NULL,
  requested_by_user_id INT NULL,
  requested_by_membership_id INT NULL,
  institution_id INT NULL,
  expected_target_session_version INT NULL,
  expected_actor_session_version INT NULL,
  email_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  token_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  sealed_payload TEXT NULL,
  expires_at DATETIME NULL,
  available_at DATETIME NOT NULL,
  delivery_deadline_at DATETIME NOT NULL,
  lease_token VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  lease_until DATETIME NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  provider_accepted_at DATETIME NULL,
  used_at DATETIME NULL,
  finished_at DATETIME NULL,
  last_error_code VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  active_slot TINYINT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_auth_recovery_token_hash (token_hash),
  UNIQUE KEY uniq_auth_recovery_active_target (target_user_id, active_slot),
  KEY fk_auth_recovery_target_membership (target_membership_id),
  KEY fk_auth_recovery_actor_user (requested_by_user_id),
  KEY fk_auth_recovery_actor_membership (requested_by_membership_id),
  KEY fk_auth_recovery_institution (institution_id),
  KEY idx_auth_recovery_ready (kind, state, available_at, delivery_deadline_at, id),
  KEY idx_auth_recovery_target (target_user_id, state, id),
  CONSTRAINT fk_auth_recovery_target_user
    FOREIGN KEY (target_user_id) REFERENCES users (id),
  CONSTRAINT fk_auth_recovery_target_membership
    FOREIGN KEY (target_membership_id) REFERENCES professional_institutions (id),
  CONSTRAINT fk_auth_recovery_actor_user
    FOREIGN KEY (requested_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_auth_recovery_actor_membership
    FOREIGN KEY (requested_by_membership_id) REFERENCES professional_institutions (id),
  CONSTRAINT fk_auth_recovery_institution
    FOREIGN KEY (institution_id) REFERENCES institutions (id),
  CONSTRAINT chk_auth_recovery_attempts CHECK (
    attempt_count >= 0 AND attempt_count <= 5
  ),
  CONSTRAINT chk_auth_recovery_actor_binding CHECK (
    (
      kind = 'SELF_SERVICE'
      AND request_actor_kind = 'UNAUTHENTICATED'
      AND requested_by_user_id IS NULL
      AND requested_by_membership_id IS NULL
      AND institution_id IS NULL
      AND expected_actor_session_version IS NULL
    )
    OR (
      kind = 'ADMIN_INITIATED'
      AND request_actor_kind = 'AUTHENTICATED_ADMIN'
      AND target_user_id IS NOT NULL
      AND target_membership_id IS NOT NULL
      AND requested_by_user_id IS NOT NULL
      AND requested_by_membership_id IS NOT NULL
      AND institution_id IS NOT NULL
      AND expected_target_session_version IS NOT NULL
      AND expected_actor_session_version IS NOT NULL
      AND email_hash IS NOT NULL
      AND token_hash IS NOT NULL
    )
  ),
  CONSTRAINT chk_auth_recovery_active_binding CHECK (
    state NOT IN ('ACTIVE', 'USED')
    OR (
      target_user_id IS NOT NULL
      AND target_membership_id IS NOT NULL
      AND expected_target_session_version IS NOT NULL
      AND email_hash IS NOT NULL
      AND token_hash IS NOT NULL
      AND expires_at IS NOT NULL
      AND provider_accepted_at IS NOT NULL
      AND sealed_payload IS NULL
      AND lease_token IS NULL
      AND lease_until IS NULL
    )
  ),
  CONSTRAINT chk_auth_recovery_state_payload CHECK (
    (
      state = 'QUEUED'
      AND sealed_payload IS NOT NULL
      AND lease_token IS NULL
      AND lease_until IS NULL
      AND provider_accepted_at IS NULL
      AND expires_at IS NULL
      AND used_at IS NULL
      AND finished_at IS NULL
      AND attempt_count < 5
    )
    OR (
      state = 'PROCESSING'
      AND sealed_payload IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_until IS NOT NULL
      AND provider_accepted_at IS NULL
      AND expires_at IS NULL
      AND used_at IS NULL
      AND finished_at IS NULL
      AND attempt_count >= 1
    )
    OR (
      state = 'ACTIVE'
      AND sealed_payload IS NULL
      AND lease_token IS NULL
      AND lease_until IS NULL
      AND used_at IS NULL
      AND finished_at IS NULL
      AND expires_at > provider_accepted_at
    )
    OR (
      state = 'USED'
      AND sealed_payload IS NULL
      AND lease_token IS NULL
      AND lease_until IS NULL
      AND used_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND used_at = finished_at
    )
    OR (
      state = 'REVOKED'
      AND sealed_payload IS NULL
      AND lease_token IS NULL
      AND lease_until IS NULL
      AND used_at IS NULL
      AND finished_at IS NOT NULL
    )
    OR (
      state IN ('SKIPPED', 'DEAD')
      AND sealed_payload IS NULL
      AND lease_token IS NULL
      AND lease_until IS NULL
      AND provider_accepted_at IS NULL
      AND expires_at IS NULL
      AND used_at IS NULL
      AND finished_at IS NOT NULL
    )
  ),
  CONSTRAINT chk_auth_recovery_deadline CHECK (
    delivery_deadline_at > available_at
  ),
  CONSTRAINT chk_auth_recovery_hashes CHECK (
    token_hash REGEXP '^[0-9a-f]{64}$'
    AND (email_hash IS NULL OR email_hash REGEXP '^[0-9a-f]{64}$')
  ),
  CONSTRAINT chk_auth_recovery_active_slot CHECK (
    (state = 'ACTIVE' AND active_slot = 1)
    OR (state <> 'ACTIVE' AND active_slot IS NULL)
  )
) ENGINE=InnoDB;

-- Recalcula o catálogo; não reutiliza os valores do preflight.
SET @auth_recovery_post_columns_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(':', columns.ORDINAL_POSITION, columns.COLUMN_NAME,
    LOWER(columns.COLUMN_TYPE), columns.IS_NULLABLE,
    CASE WHEN UPPER(COALESCE(columns.COLUMN_DEFAULT, '')) IN ('NOW()', 'CURRENT_TIMESTAMP()')
      THEN 'CURRENT_TIMESTAMP' ELSE COALESCE(UPPER(columns.COLUMN_DEFAULT), '<NULL>') END,
    LOWER(COALESCE(columns.EXTRA, '')), COALESCE(columns.CHARACTER_SET_NAME, '<NULL>'),
    CASE WHEN columns.COLLATION_NAME = tables.TABLE_COLLATION THEN '<TABLE_DEFAULT>'
      ELSE COALESCE(columns.COLLATION_NAME, '<NULL>') END)
    ORDER BY columns.ORDINAL_POSITION SEPARATOR '|'), 256)
  FROM INFORMATION_SCHEMA.COLUMNS AS columns
  INNER JOIN INFORMATION_SCHEMA.TABLES AS tables
    ON tables.TABLE_SCHEMA = columns.TABLE_SCHEMA AND tables.TABLE_NAME = columns.TABLE_NAME
  WHERE columns.TABLE_SCHEMA = DATABASE() AND columns.TABLE_NAME = 'auth_recovery_requests'
);
SET @auth_recovery_post_indexes_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(':', INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX,
    COLUMN_NAME, COALESCE(COLLATION, '<NULL>'), COALESCE(SUB_PART, '<NULL>'),
    INDEX_TYPE, COALESCE(IS_VISIBLE, '<NULL>'))
    ORDER BY INDEX_NAME, SEQ_IN_INDEX SEPARATOR '|'), 256)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_recovery_requests'
);
SET @auth_recovery_post_fks_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(':', k.CONSTRAINT_NAME, k.ORDINAL_POSITION,
    k.COLUMN_NAME, CASE WHEN k.REFERENCED_TABLE_SCHEMA = DATABASE() THEN '<CURRENT_SCHEMA>'
      ELSE k.REFERENCED_TABLE_SCHEMA END, k.REFERENCED_TABLE_NAME,
    k.REFERENCED_COLUMN_NAME, r.MATCH_OPTION, r.UPDATE_RULE, r.DELETE_RULE)
    ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION SEPARATOR '|'), 256)
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS k
  INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS r
    ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
    AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
  WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = 'auth_recovery_requests'
    AND k.REFERENCED_TABLE_NAME IS NOT NULL
);
SET @auth_recovery_post_checks_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(':', tc.CONSTRAINT_NAME,
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(cc.CHECK_CLAUSE), CHAR(96), ''),
      '_UTF8MB4', ''), ' ', ''), CHAR(10), ''), CHAR(13), ''),
    COALESCE(tc.ENFORCED, '<NULL>'))
    ORDER BY tc.CONSTRAINT_NAME SEPARATOR '|'), 256)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
  INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS cc
    ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'auth_recovery_requests'
    AND tc.CONSTRAINT_TYPE = 'CHECK'
);
SET @auth_recovery_postflight_ok := (
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_recovery_requests'
      AND TABLE_TYPE = 'BASE TABLE' AND ENGINE = 'InnoDB'
      AND COALESCE(CREATE_OPTIONS, '') = ''
      AND TABLE_COLLATION = (SELECT DEFAULT_COLLATION_NAME FROM INFORMATION_SCHEMA.SCHEMATA
        WHERE SCHEMA_NAME = DATABASE())) = 1
  AND @auth_recovery_post_columns_hash = @auth_recovery_expected_columns_hash
  AND @auth_recovery_post_indexes_hash = @auth_recovery_expected_indexes_hash
  AND @auth_recovery_post_fks_hash = @auth_recovery_expected_fks_hash
  AND @auth_recovery_post_checks_hash = @auth_recovery_expected_checks_hash
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
    WHERE TRIGGER_SCHEMA = DATABASE()
      AND EVENT_OBJECT_TABLE = 'auth_recovery_requests') = 0
);
SET @auth_recovery_postflight_sql := IF(
  @auth_recovery_postflight_ok,
  'SELECT 1',
  'SELECT 1 FROM __auth_recovery_contract_postflight_rejected__'
);
PREPARE auth_recovery_postflight_stmt FROM @auth_recovery_postflight_sql;
EXECUTE auth_recovery_postflight_stmt;
DEALLOCATE PREPARE auth_recovery_postflight_stmt;

SET SESSION group_concat_max_len = @auth_recovery_previous_group_concat_max_len;
