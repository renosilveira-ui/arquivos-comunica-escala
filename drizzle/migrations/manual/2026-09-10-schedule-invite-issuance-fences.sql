-- 2026-09-10 — intenção/outbox e journal duráveis da emissão nominal.
--
-- Migration aditiva e rerodável. Aplicar ANTES da migration hash V2 e antes
-- de qualquer runtime novo. Não operar writers mistos. Nenhuma tabela guarda
-- código em claro, hash do código, e-mail ou payload do provedor.

-- Preflight de ambos os objetos ANTES do primeiro DDL permanente. Uma tabela
-- homônima só é aceita quando o manifesto final inteiro coincide; drift ou
-- objeto parcial falha sem tentar consertar estado desconhecido.
SET @siif_fence_objects := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_fence_tables := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siif_fence_columns_ok := (
  SELECT COUNT(*) = 20
    AND SUM(CASE WHEN COLUMN_NAME = 'id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' AND EXTRA LIKE '%auto_increment%' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'institution_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'hospital_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'sector_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'invited_user_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'generation' AND COLUMN_TYPE = 'int unsigned' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = '0' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'state' AND COLUMN_TYPE = 'enum(''IDLE'',''PREPARING'',''PROVIDER_UNKNOWN'',''PROVIDER_ACCEPTED'',''ACTIVE'',''PROVIDER_REJECTED'',''PROVIDER_ACCEPTED_ACTIVATION_FAILED'')' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = 'IDLE' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'lease_token' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'lease_expires_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'attempt_expires_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'code_nonce' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'code_pepper_key_id' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'recipient_binding_hash' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_idempotency_key' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_correlation_id' AND COLUMN_TYPE = 'varchar(128)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_accepted_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'schedule_invite_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'failure_code' AND COLUMN_TYPE = 'varchar(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'created_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'NO' AND LOWER(CAST(COLUMN_DEFAULT AS CHAR)) IN ('current_timestamp','now()') THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'updated_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'NO' AND LOWER(EXTRA) LIKE '%on update current_timestamp%' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_fence_indexes_ok := (
  SELECT COUNT(*) = 6
    AND SUM(CASE WHEN INDEX_NAME = 'PRIMARY' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'uniq_schedule_invite_issuance_scope' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'uniq_schedule_invite_issuance_scope' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'uniq_schedule_invite_issuance_scope' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'sector_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'uniq_schedule_invite_issuance_scope' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'invited_user_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'fk_schedule_invite_issuance_invited_user' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'invited_user_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_fence_fks_ok := (
  SELECT COUNT(*) = 6
    AND COUNT(DISTINCT CONSTRAINT_NAME) = 3
    AND SUM(CASE WHEN CONSTRAINT_NAME = 'fk_schedule_invite_issuance_hospital_topology' AND COLUMN_NAME IN ('institution_id','hospital_id') AND REFERENCED_TABLE_NAME = 'hospitals' THEN 1 ELSE 0 END) = 2
    AND SUM(CASE WHEN CONSTRAINT_NAME = 'fk_schedule_invite_issuance_sector_topology' AND COLUMN_NAME IN ('institution_id','hospital_id','sector_id') AND REFERENCED_TABLE_NAME = 'sectors' THEN 1 ELSE 0 END) = 3
    AND SUM(CASE WHEN CONSTRAINT_NAME = 'fk_schedule_invite_issuance_invited_user' AND COLUMN_NAME = 'invited_user_id' AND REFERENCED_TABLE_NAME = 'users' AND REFERENCED_COLUMN_NAME = 'id' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND REFERENCED_TABLE_NAME IS NOT NULL
);
SET @siif_fence_checks_ok := (
  SELECT COUNT(*) = 6 AND SUM(ENFORCED = 'YES') = 6
    AND SUM(CONSTRAINT_NAME = 'chk_schedule_invite_issuance_generation') = 1
    AND SUM(CONSTRAINT_NAME = 'chk_schedule_invite_issuance_lease_shape') = 1
    AND SUM(CONSTRAINT_NAME = 'chk_schedule_invite_issuance_material_shape') = 1
    AND SUM(CONSTRAINT_NAME = 'chk_schedule_invite_issuance_accepted_shape') = 1
    AND SUM(CONSTRAINT_NAME = 'chk_schedule_invite_issuance_failure_shape') = 1
    AND SUM(CONSTRAINT_NAME = 'chk_schedule_invite_issuance_activation_shape') = 1
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND CONSTRAINT_TYPE = 'CHECK'
);
SET @siif_fence_options_ok := (
  SELECT COUNT(*) = 1 AND MIN(ENGINE = 'InnoDB') = 1
    AND MIN(TABLE_COLLATION = 'utf8mb4_0900_ai_ci') = 1
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siif_fence_trigger_count := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_fences'
);
SET @siif_fence_contract_ok := (
  @siif_fence_objects = 1 AND @siif_fence_tables = 1
  AND @siif_fence_columns_ok AND @siif_fence_indexes_ok
  AND @siif_fence_fks_ok AND @siif_fence_checks_ok
  AND @siif_fence_options_ok AND @siif_fence_trigger_count = 0
);

SET @siij_objects := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
);
SET @siij_tables := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siij_columns_ok := (
  SELECT COUNT(*) = 11
    AND SUM(CASE WHEN COLUMN_NAME = 'id' AND COLUMN_TYPE = 'bigint unsigned' AND IS_NULLABLE = 'NO' AND EXTRA LIKE '%auto_increment%' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'institution_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'hospital_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'sector_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'invited_user_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'generation' AND COLUMN_TYPE = 'int unsigned' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'event' AND COLUMN_TYPE = 'enum(''CLAIMED'',''ATTEMPT_SUPERSEDED'',''DELIVERY_RECLAIMED'',''PROVIDER_ACCEPTED'',''PROVIDER_REJECTED'',''PROVIDER_UNKNOWN'',''ACTIVATION_RESUMED'',''ACTIVATED'',''ACTIVATION_FAILED'')' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'reason_code' AND COLUMN_TYPE = 'varchar(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_correlation_id' AND COLUMN_TYPE = 'varchar(128)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'schedule_invite_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'created_at' AND COLUMN_TYPE = 'timestamp(6)' AND IS_NULLABLE = 'NO' AND LOWER(CAST(COLUMN_DEFAULT AS CHAR)) IN ('current_timestamp(6)','now(6)') THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
);
SET @siij_indexes_ok := (
  SELECT COUNT(*) = 7
    AND SUM(CASE WHEN INDEX_NAME = 'PRIMARY' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'sector_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'invited_user_id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'generation' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 6 AND COLUMN_NAME = 'id' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
);
SET @siij_checks_ok := (
  SELECT COUNT(*) = 1 AND SUM(ENFORCED = 'YES') = 1
    AND SUM(CONSTRAINT_NAME = 'chk_schedule_invite_issuance_journal_generation') = 1
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
    AND CONSTRAINT_TYPE = 'CHECK'
);
SET @siij_fk_count := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
    AND REFERENCED_TABLE_NAME IS NOT NULL
);
SET @siij_trigger_count := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_journal'
);
SET @siij_options_ok := (
  SELECT COUNT(*) = 1 AND MIN(ENGINE = 'InnoDB') = 1
    AND MIN(TABLE_COLLATION = 'utf8mb4_0900_ai_ci') = 1
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siij_contract_ok := (
  @siij_objects = 1 AND @siij_tables = 1
  AND @siij_columns_ok AND @siij_indexes_ok AND @siij_checks_ok
  AND @siij_fk_count = 0 AND @siij_trigger_count = 0 AND @siij_options_ok
);

SET @siif_preflight_sql := IF(
  (@siif_fence_objects = 0 OR @siif_fence_contract_ok)
  AND (@siij_objects = 0 OR @siij_contract_ok),
  'SELECT 1',
  'SELECT JSON_EXTRACT(''SCHEDULE_INVITE_DURABLE_DELIVERY_PREFLIGHT_MISMATCH'', ''$'')'
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
    'IDLE', 'PREPARING', 'PROVIDER_UNKNOWN', 'PROVIDER_ACCEPTED',
    'ACTIVE', 'PROVIDER_REJECTED',
    'PROVIDER_ACCEPTED_ACTIVATION_FAILED'
  ) NOT NULL DEFAULT 'IDLE',
  lease_token CHAR(64) NULL DEFAULT NULL,
  lease_expires_at TIMESTAMP NULL DEFAULT NULL,
  attempt_expires_at TIMESTAMP NULL DEFAULT NULL,
  code_nonce CHAR(64) NULL DEFAULT NULL,
  code_pepper_key_id CHAR(64) NULL DEFAULT NULL,
  recipient_binding_hash CHAR(64) NULL DEFAULT NULL,
  provider_idempotency_key CHAR(64) NULL DEFAULT NULL,
  provider_correlation_id VARCHAR(128) NULL DEFAULT NULL,
  provider_accepted_at TIMESTAMP NULL DEFAULT NULL,
  schedule_invite_id INT NULL DEFAULT NULL,
  failure_code VARCHAR(64) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_schedule_invite_issuance_scope (
    institution_id, hospital_id, sector_id, invited_user_id
  ),
  CONSTRAINT fk_schedule_invite_issuance_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals (institution_id, id),
  CONSTRAINT fk_schedule_invite_issuance_sector_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors (institution_id, hospital_id, id),
  CONSTRAINT fk_schedule_invite_issuance_invited_user
    FOREIGN KEY (invited_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_schedule_invite_issuance_generation CHECK (
    (state = 'IDLE' AND generation = 0)
    OR (state <> 'IDLE' AND generation > 0)
  ),
  CONSTRAINT chk_schedule_invite_issuance_lease_shape CHECK (
    (state IN ('PREPARING','PROVIDER_UNKNOWN','PROVIDER_ACCEPTED')
      AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state NOT IN ('PREPARING','PROVIDER_UNKNOWN','PROVIDER_ACCEPTED')
      AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT chk_schedule_invite_issuance_material_shape CHECK (
    (state = 'IDLE' AND attempt_expires_at IS NULL AND code_nonce IS NULL
      AND code_pepper_key_id IS NULL AND recipient_binding_hash IS NULL
      AND provider_idempotency_key IS NULL)
    OR
    (state <> 'IDLE' AND attempt_expires_at IS NOT NULL AND code_nonce IS NOT NULL
      AND code_pepper_key_id IS NOT NULL AND recipient_binding_hash IS NOT NULL
      AND provider_idempotency_key IS NOT NULL)
  ),
  CONSTRAINT chk_schedule_invite_issuance_accepted_shape CHECK (
    (state IN ('PROVIDER_ACCEPTED','ACTIVE','PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND provider_accepted_at IS NOT NULL)
    OR
    (state NOT IN ('PROVIDER_ACCEPTED','ACTIVE','PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND provider_accepted_at IS NULL)
  ),
  CONSTRAINT chk_schedule_invite_issuance_failure_shape CHECK (
    (state IN ('PROVIDER_UNKNOWN','PROVIDER_REJECTED','PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND failure_code IS NOT NULL)
    OR
    (state NOT IN ('PROVIDER_UNKNOWN','PROVIDER_REJECTED','PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND failure_code IS NULL)
  ),
  CONSTRAINT chk_schedule_invite_issuance_activation_shape CHECK (
    (state = 'ACTIVE' AND schedule_invite_id IS NOT NULL)
    OR (state <> 'ACTIVE' AND schedule_invite_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS schedule_invite_issuance_journal (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  sector_id INT NOT NULL,
  invited_user_id INT NOT NULL,
  generation INT UNSIGNED NOT NULL,
  event ENUM(
    'CLAIMED', 'ATTEMPT_SUPERSEDED', 'DELIVERY_RECLAIMED',
    'PROVIDER_ACCEPTED', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN',
    'ACTIVATION_RESUMED', 'ACTIVATED', 'ACTIVATION_FAILED'
  ) NOT NULL,
  reason_code VARCHAR(64) NULL DEFAULT NULL,
  provider_correlation_id VARCHAR(128) NULL DEFAULT NULL,
  schedule_invite_id INT NULL DEFAULT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_schedule_invite_issuance_journal_generation (
    institution_id, hospital_id, sector_id, invited_user_id, generation, id
  ),
  CONSTRAINT chk_schedule_invite_issuance_journal_generation
    CHECK (generation > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Postflight mínimo no primeiro run; a segunda execução obrigatória faz o
-- preflight integral acima e prova idempotência/manifests sem alterar linhas.
SET @siif_postflight_missing := (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_invite_issuance_fences') <> 20
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_invite_issuance_fences'
       AND CONSTRAINT_TYPE = 'CHECK') <> 6
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_invite_issuance_journal') <> 11
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_invite_issuance_journal'
       AND CONSTRAINT_TYPE = 'CHECK') <> 1
);
SET @siif_postflight_sql := IF(
  @siif_postflight_missing = 0,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''SCHEDULE_INVITE_DURABLE_DELIVERY_POSTFLIGHT_MISMATCH'', ''$'')'
);
PREPARE siif_postflight_stmt FROM @siif_postflight_sql;
EXECUTE siif_postflight_stmt;
DEALLOCATE PREPARE siif_postflight_stmt;
