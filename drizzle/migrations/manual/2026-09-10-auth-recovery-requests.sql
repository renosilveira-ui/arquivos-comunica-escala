-- 2026-09-10 — recuperação de credenciais com outbox durável.
--
-- Aditiva e rerodável. A tabela homônima só é aceita quando colunas, índices,
-- FKs e CHECKs correspondem integralmente ao contrato esperado. O preflight
-- ocorre antes do primeiro DDL persistente; o postflight recalcula o catálogo.

SET @auth_recovery_previous_group_concat_max_len := @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 65535;

SET @auth_recovery_expected_columns_hash := '36d718a08e21a847c244b2b97c9bef7e9701d23cb443c8517c71ebc348435283';
SET @auth_recovery_expected_indexes_hash := 'bcdbb9309949f881a5188b80df5acf1eb27000163dd86ad1aed9a5daa07a8074';
SET @auth_recovery_expected_fks_hash := '27353245d307e19758d19b64cee145f2a76e7a03a24c174dfe9dd4111a1a0b31';
SET @auth_recovery_expected_checks_hash := 'c7e527d64518baf6ab72fca608ddea311807e2cae0b49730563b092ccfe43972';

SET @auth_recovery_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'auth_recovery_requests'
    AND TABLE_TYPE = 'BASE TABLE'
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
        )
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
    AND (
      SELECT COUNT(*)
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'auth_recovery_requests'
        AND TABLE_TYPE = 'BASE TABLE'
        AND ENGINE = 'InnoDB'
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
  state ENUM('QUEUED','PROCESSING','PENDING_DELIVERY','ACTIVE','USED','REVOKED','SKIPPED','DEAD') NOT NULL DEFAULT 'QUEUED',
  target_user_id INT NULL,
  target_membership_id INT NULL,
  requested_by_user_id INT NULL,
  requested_by_membership_id INT NULL,
  institution_id INT NULL,
  expected_target_session_version INT NULL,
  expected_actor_session_version INT NULL,
  email_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  token_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  sealed_payload TEXT NULL,
  expires_at DATETIME NULL,
  available_at DATETIME NOT NULL,
  lease_token VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  lease_until DATETIME NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  provider_accepted_at DATETIME NULL,
  used_at DATETIME NULL,
  last_error_code VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_auth_recovery_token_hash (token_hash),
  KEY fk_auth_recovery_target_membership (target_membership_id),
  KEY fk_auth_recovery_actor_user (requested_by_user_id),
  KEY fk_auth_recovery_actor_membership (requested_by_membership_id),
  KEY fk_auth_recovery_institution (institution_id),
  KEY idx_auth_recovery_ready (kind, state, available_at, id),
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
  CONSTRAINT chk_auth_recovery_attempts CHECK (attempt_count >= 0),
  CONSTRAINT chk_auth_recovery_admin_binding CHECK (
    kind = 'SELF_SERVICE'
    OR (
      target_user_id IS NOT NULL
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
    )
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
      '_UTF8MB4', ''), ' ', ''), CHAR(10), ''), CHAR(13), ''))
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
      AND TABLE_COLLATION = (SELECT DEFAULT_COLLATION_NAME FROM INFORMATION_SCHEMA.SCHEMATA
        WHERE SCHEMA_NAME = DATABASE())) = 1
  AND @auth_recovery_post_columns_hash = @auth_recovery_expected_columns_hash
  AND @auth_recovery_post_indexes_hash = @auth_recovery_expected_indexes_hash
  AND @auth_recovery_post_fks_hash = @auth_recovery_expected_fks_hash
  AND @auth_recovery_post_checks_hash = @auth_recovery_expected_checks_hash
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
