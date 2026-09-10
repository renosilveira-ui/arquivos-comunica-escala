-- 2026-09-10 — fence durável da emissão de convite nominal.
--
-- Migration aditiva e rerodável. Aplicar ANTES do runtime que usa a tabela;
-- o deploy não executa migrations. Não operar duas versões do writer ao
-- mesmo tempo: a versão anterior usa GET_LOCK e não participa desta fence.
--
-- A tabela não guarda código, hash, e-mail ou payload do provedor. Ela
-- serializa transações curtas e registra apenas estado operacional opaco.
-- Nenhuma conexão SQL precisa permanecer aberta durante a chamada de rede.

SET @siif_previous_group_concat_max_len := @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 65535;

SET @siif_expected_columns_hash :=
  '07102eb4627bff5e3096cc07117394a308fdeacf1923d1897821ba8244f3565c';
SET @siif_expected_indexes_hash :=
  '97b012c78f3b2ed99ec4c05a091db827ba7b8a2180279a334d584e07b23eff5c';
SET @siif_expected_foreign_keys_hash :=
  '3872a344cafba2749dbd46dc010d43963654eddfcfcc4892154f05e4f81b2323';
SET @siif_expected_checks_hash :=
  '284a82c3e0ebc3cf5e78ed8902e93e06234370185d520a2b22ea6b99d8376f4a';
SET @siif_expected_table_options_hash :=
  'e26e2991ce3e5ce1cb83afa94491ee06ba31e280a83451d7b5774c653955482f';

-- Preflight ANTES do primeiro DDL permanente. Uma tabela homônima só pode
-- ser aceita quando todo o manifesto (incluindo ausência de extras) coincide.
SET @siif_existing_object_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_existing_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siif_columns_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(
    '|',
    ORDINAL_POSITION,
    COLUMN_NAME,
    COLUMN_TYPE,
    IS_NULLABLE,
    REPLACE(
      LOWER(COALESCE(CAST(COLUMN_DEFAULT AS CHAR), '<NULL>')),
      'now()',
      'current_timestamp'
    ),
    LOWER(EXTRA),
    COALESCE(CHARACTER_SET_NAME, '<NULL>'),
    COALESCE(COLLATION_NAME, '<NULL>'),
    COALESCE(GENERATION_EXPRESSION, '<NULL>'),
    COALESCE(COLUMN_COMMENT, '')
  ) ORDER BY ORDINAL_POSITION SEPARATOR ';'), 256)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_indexes_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(
    '|',
    INDEX_NAME,
    NON_UNIQUE,
    SEQ_IN_INDEX,
    COLUMN_NAME,
    COALESCE(SUB_PART, 0),
    INDEX_TYPE,
    COALESCE(COLLATION, '<NULL>'),
    COALESCE(NULLABLE, '<NULL>'),
    COALESCE(IS_VISIBLE, '<NULL>'),
    COALESCE(EXPRESSION, '<NULL>')
  ) ORDER BY INDEX_NAME, SEQ_IN_INDEX SEPARATOR ';'), 256)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_foreign_keys_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(
    '|',
    k.CONSTRAINT_NAME,
    k.ORDINAL_POSITION,
    k.COLUMN_NAME,
    CASE
      WHEN k.REFERENCED_TABLE_SCHEMA = DATABASE() THEN '<SELF>'
      ELSE COALESCE(k.REFERENCED_TABLE_SCHEMA, '<NULL>')
    END,
    k.REFERENCED_TABLE_NAME,
    k.REFERENCED_COLUMN_NAME,
    r.UNIQUE_CONSTRAINT_NAME,
    r.MATCH_OPTION,
    r.UPDATE_RULE,
    r.DELETE_RULE
  ) ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION SEPARATOR ';'), 256)
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
  INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
   AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
  WHERE k.TABLE_SCHEMA = DATABASE()
    AND k.TABLE_NAME = 'schedule_invite_issuance_fences'
    AND k.REFERENCED_TABLE_NAME IS NOT NULL
);
SET @siif_checks_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(
    '|',
    tc.CONSTRAINT_NAME,
    cc.CHECK_CLAUSE,
    tc.ENFORCED
  ) ORDER BY tc.CONSTRAINT_NAME SEPARATOR ';'), 256)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
    ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
   AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'schedule_invite_issuance_fences'
    AND tc.CONSTRAINT_TYPE = 'CHECK'
);
SET @siif_table_options_hash := (
  SELECT SHA2(CONCAT_WS(
    '|', ENGINE, TABLE_COLLATION, ROW_FORMAT, CREATE_OPTIONS, TABLE_COMMENT
  ), 256)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siif_trigger_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_fences'
);
SET @siif_existing_contract_ok := (
  @siif_existing_object_count = 1
  AND @siif_existing_table_count = 1
  AND BINARY @siif_columns_hash = BINARY @siif_expected_columns_hash
  AND BINARY @siif_indexes_hash = BINARY @siif_expected_indexes_hash
  AND BINARY @siif_foreign_keys_hash = BINARY @siif_expected_foreign_keys_hash
  AND BINARY @siif_checks_hash = BINARY @siif_expected_checks_hash
  AND BINARY @siif_table_options_hash = BINARY @siif_expected_table_options_hash
  AND @siif_trigger_count = 0
);
SET @siif_preflight_sql := IF(
  @siif_existing_object_count = 0 OR @siif_existing_contract_ok,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''SCHEDULE_INVITE_ISSUANCE_FENCE_PREFLIGHT_MISMATCH'', ''$'')'
);
PREPARE siif_preflight_stmt FROM @siif_preflight_sql;
EXECUTE siif_preflight_stmt;
DEALLOCATE PREPARE siif_preflight_stmt;

CREATE TABLE IF NOT EXISTS schedule_invite_issuance_fences (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  sector_id INT NOT NULL,
  invited_user_id INT NOT NULL,
  generation INT UNSIGNED NOT NULL DEFAULT 0,
  state ENUM(
    'IDLE',
    'PREPARING',
    'PROVIDER_ACCEPTED',
    'ACTIVE',
    'PROVIDER_REJECTED',
    'PROVIDER_ACCEPTED_ACTIVATION_FAILED'
  ) NOT NULL DEFAULT 'IDLE',
  lease_expires_at TIMESTAMP NULL DEFAULT NULL,
  provider_accepted_at TIMESTAMP NULL DEFAULT NULL,
  failure_code VARCHAR(64) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_schedule_invite_issuance_scope (
    institution_id,
    hospital_id,
    sector_id,
    invited_user_id
  ),
  CONSTRAINT fk_schedule_invite_issuance_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals (institution_id, id),
  CONSTRAINT fk_schedule_invite_issuance_sector_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors (institution_id, hospital_id, id),
  CONSTRAINT fk_schedule_invite_issuance_invited_user
    FOREIGN KEY (invited_user_id) REFERENCES users (id)
    ON DELETE CASCADE,
  CONSTRAINT chk_schedule_invite_issuance_generation
    CHECK (
      (state = 'IDLE' AND generation = 0)
      OR
      (state <> 'IDLE' AND generation > 0)
    ),
  CONSTRAINT chk_schedule_invite_issuance_lease_shape CHECK (
    (
      state IN ('PREPARING', 'PROVIDER_ACCEPTED')
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      state NOT IN ('PREPARING', 'PROVIDER_ACCEPTED')
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT chk_schedule_invite_issuance_accepted_shape CHECK (
    (
      state IN (
        'PROVIDER_ACCEPTED',
        'ACTIVE',
        'PROVIDER_ACCEPTED_ACTIVATION_FAILED'
      )
      AND provider_accepted_at IS NOT NULL
    )
    OR
    (
      state NOT IN (
        'PROVIDER_ACCEPTED',
        'ACTIVE',
        'PROVIDER_ACCEPTED_ACTIVATION_FAILED'
      )
      AND provider_accepted_at IS NULL
    )
  ),
  CONSTRAINT chk_schedule_invite_issuance_failure_shape CHECK (
    (
      state IN ('PROVIDER_REJECTED', 'PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND failure_code IS NOT NULL
    )
    OR
    (
      state NOT IN ('PROVIDER_REJECTED', 'PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND failure_code IS NULL
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Postflight integral. Recalcula o mesmo manifesto após o CREATE e recusa
-- drift, extras ou trigger inesperado. Os blocos são repetidos de propósito:
-- a prova não depende dos valores capturados antes do DDL.
SET @siif_post_columns_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(
    '|', ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
    REPLACE(
      LOWER(COALESCE(CAST(COLUMN_DEFAULT AS CHAR), '<NULL>')),
      'now()',
      'current_timestamp'
    ),
    LOWER(EXTRA),
    COALESCE(CHARACTER_SET_NAME, '<NULL>'),
    COALESCE(COLLATION_NAME, '<NULL>'),
    COALESCE(GENERATION_EXPRESSION, '<NULL>'),
    COALESCE(COLUMN_COMMENT, '')
  ) ORDER BY ORDINAL_POSITION SEPARATOR ';'), 256)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_post_indexes_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(
    '|', INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
    COALESCE(SUB_PART, 0), INDEX_TYPE,
    COALESCE(COLLATION, '<NULL>'), COALESCE(NULLABLE, '<NULL>'),
    COALESCE(IS_VISIBLE, '<NULL>'), COALESCE(EXPRESSION, '<NULL>')
  ) ORDER BY INDEX_NAME, SEQ_IN_INDEX SEPARATOR ';'), 256)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_post_foreign_keys_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(
    '|', k.CONSTRAINT_NAME, k.ORDINAL_POSITION, k.COLUMN_NAME,
    CASE
      WHEN k.REFERENCED_TABLE_SCHEMA = DATABASE() THEN '<SELF>'
      ELSE COALESCE(k.REFERENCED_TABLE_SCHEMA, '<NULL>')
    END,
    k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
    r.UNIQUE_CONSTRAINT_NAME, r.MATCH_OPTION, r.UPDATE_RULE, r.DELETE_RULE
  ) ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION SEPARATOR ';'), 256)
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
  INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
   AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
  WHERE k.TABLE_SCHEMA = DATABASE()
    AND k.TABLE_NAME = 'schedule_invite_issuance_fences'
    AND k.REFERENCED_TABLE_NAME IS NOT NULL
);
SET @siif_post_checks_hash := (
  SELECT SHA2(GROUP_CONCAT(CONCAT_WS(
    '|', tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE, tc.ENFORCED
  ) ORDER BY tc.CONSTRAINT_NAME SEPARATOR ';'), 256)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
    ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
   AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'schedule_invite_issuance_fences'
    AND tc.CONSTRAINT_TYPE = 'CHECK'
);
SET @siif_post_table_options_hash := (
  SELECT SHA2(CONCAT_WS(
    '|', ENGINE, TABLE_COLLATION, ROW_FORMAT, CREATE_OPTIONS, TABLE_COMMENT
  ), 256)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siif_post_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siif_post_trigger_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_fences'
);
SET @siif_post_contract_ok := (
  @siif_post_table_count = 1
  AND BINARY @siif_post_columns_hash = BINARY @siif_expected_columns_hash
  AND BINARY @siif_post_indexes_hash = BINARY @siif_expected_indexes_hash
  AND BINARY @siif_post_foreign_keys_hash = BINARY @siif_expected_foreign_keys_hash
  AND BINARY @siif_post_checks_hash = BINARY @siif_expected_checks_hash
  AND BINARY @siif_post_table_options_hash = BINARY @siif_expected_table_options_hash
  AND @siif_post_trigger_count = 0
);
SET @siif_postflight_sql := IF(
  @siif_post_contract_ok,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''SCHEDULE_INVITE_ISSUANCE_FENCE_POSTFLIGHT_MISMATCH'', ''$'')'
);
PREPARE siif_postflight_stmt FROM @siif_postflight_sql;
EXECUTE siif_postflight_stmt;
DEALLOCATE PREPARE siif_postflight_stmt;

SET SESSION group_concat_max_len = @siif_previous_group_concat_max_len;
