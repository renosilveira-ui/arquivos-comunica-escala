-- 2026-09-08 — recursos comerciais por instituição.
--
-- CROSS_SCHEDULE_ROSTER_VIEW controla somente a leitura operacional das
-- escalas e equipes de outros setores da mesma instituição. Não concede papel,
-- manager_scope, professional_access, elegibilidade nem qualquer mutação.
--
-- Compatibilidade aprovada: instituições criadas até 2026-09-08T22:12:00Z
-- recebem o recurso habilitado. O corte usa epoch para não depender do fuso da
-- sessão MySQL. Instituições posteriores ficam fechadas por ausência de linha.
-- A reaplicação é segura e nunca sobrescreve uma decisão administrativa.

CREATE TABLE IF NOT EXISTS institution_feature_entitlements (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  feature_code VARCHAR(64) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  source ENUM(
    'LEGACY_COMPATIBILITY',
    'ADMIN_OVERRIDE',
    'COMMERCIAL_PACKAGE'
  ) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  updated_by_user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_institution_feature (institution_id, feature_code),
  KEY idx_institution_feature_lookup
    (institution_id, enabled, feature_code),
  CONSTRAINT fk_institution_feature_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_institution_feature_updated_by
    FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- CREATE TABLE IF NOT EXISTS não pode legitimar uma tabela homônima parcial.
-- O contrato físico inteiro é validado antes do backfill.
SET @institution_feature_columns_contract_matches := (
  SELECT COUNT(*) = 9
    AND SUM(
      CASE
        WHEN COLUMN_NAME = 'id'
          AND DATA_TYPE = 'int'
          AND IS_NULLABLE = 'NO'
          AND LOWER(COALESCE(EXTRA, '')) LIKE '%auto_increment%'
        THEN 1
        WHEN COLUMN_NAME = 'institution_id'
          AND DATA_TYPE = 'int'
          AND IS_NULLABLE = 'NO'
          AND COLUMN_DEFAULT IS NULL
        THEN 1
        WHEN COLUMN_NAME = 'feature_code'
          AND DATA_TYPE = 'varchar'
          AND CHARACTER_MAXIMUM_LENGTH = 64
          AND IS_NULLABLE = 'NO'
          AND COLUMN_DEFAULT IS NULL
        THEN 1
        WHEN COLUMN_NAME = 'enabled'
          AND DATA_TYPE = 'tinyint'
          AND COLUMN_TYPE = 'tinyint(1)'
          AND IS_NULLABLE = 'NO'
          AND COLUMN_DEFAULT IN ('0', 0)
        THEN 1
        WHEN COLUMN_NAME = 'source'
          AND DATA_TYPE = 'enum'
          AND IS_NULLABLE = 'NO'
          AND COLUMN_DEFAULT IS NULL
          AND COLUMN_TYPE = 'enum(''LEGACY_COMPATIBILITY'',''ADMIN_OVERRIDE'',''COMMERCIAL_PACKAGE'')'
        THEN 1
        WHEN COLUMN_NAME = 'version'
          AND DATA_TYPE = 'int'
          AND IS_NULLABLE = 'NO'
          AND COLUMN_DEFAULT IN ('1', 1)
        THEN 1
        WHEN COLUMN_NAME = 'updated_by_user_id'
          AND DATA_TYPE = 'int'
          AND IS_NULLABLE = 'YES'
          AND COLUMN_DEFAULT IS NULL
        THEN 1
        WHEN COLUMN_NAME = 'created_at'
          AND DATA_TYPE = 'timestamp'
          AND IS_NULLABLE = 'NO'
          AND UPPER(COALESCE(COLUMN_DEFAULT, '')) IN (
            'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()'
          )
          AND LOWER(COALESCE(EXTRA, '')) NOT LIKE '%on update%'
        THEN 1
        WHEN COLUMN_NAME = 'updated_at'
          AND DATA_TYPE = 'timestamp'
          AND IS_NULLABLE = 'NO'
          AND UPPER(COALESCE(COLUMN_DEFAULT, '')) IN (
            'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()'
          )
          AND LOWER(COALESCE(EXTRA, '')) LIKE '%on update%'
        THEN 1
        ELSE 0
      END
    ) = 9
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'institution_feature_entitlements'
);
SET @institution_feature_engine_contract_matches := (
  SELECT COUNT(*) = 1
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'institution_feature_entitlements'
    AND UPPER(ENGINE) = 'INNODB'
);
SET @institution_feature_primary_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'id'
        THEN 1 ELSE 0 END
    ) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'institution_feature_entitlements'
    AND INDEX_NAME = 'PRIMARY'
);
SET @institution_feature_unique_contract_matches := (
  SELECT COUNT(*) = 2
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 0
          AND SEQ_IN_INDEX = 1
          AND COLUMN_NAME = 'institution_id' THEN 1
        WHEN NON_UNIQUE = 0
          AND SEQ_IN_INDEX = 2
          AND COLUMN_NAME = 'feature_code' THEN 1
        ELSE 0
      END
    ) = 2
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'institution_feature_entitlements'
    AND INDEX_NAME = 'uniq_institution_feature'
);
SET @institution_feature_lookup_contract_matches := (
  SELECT COUNT(*) = 3
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 1
          AND SEQ_IN_INDEX = 1
          AND COLUMN_NAME = 'institution_id' THEN 1
        WHEN NON_UNIQUE = 1
          AND SEQ_IN_INDEX = 2
          AND COLUMN_NAME = 'enabled' THEN 1
        WHEN NON_UNIQUE = 1
          AND SEQ_IN_INDEX = 3
          AND COLUMN_NAME = 'feature_code' THEN 1
        ELSE 0
      END
    ) = 3
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'institution_feature_entitlements'
    AND INDEX_NAME = 'idx_institution_feature_lookup'
);
SET @institution_feature_foreign_keys_contract_matches := (
  (SELECT COUNT(*)
   FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'institution_feature_entitlements'
     AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 2
  AND
  (SELECT COUNT(*)
   FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'institution_feature_entitlements'
     AND (
       (CONSTRAINT_NAME = 'fk_institution_feature_institution'
        AND COLUMN_NAME = 'institution_id'
        AND REFERENCED_TABLE_NAME = 'institutions'
        AND REFERENCED_COLUMN_NAME = 'id')
       OR
       (CONSTRAINT_NAME = 'fk_institution_feature_updated_by'
        AND COLUMN_NAME = 'updated_by_user_id'
        AND REFERENCED_TABLE_NAME = 'users'
        AND REFERENCED_COLUMN_NAME = 'id')
     )) = 2
);
SET @institution_feature_contract_matches := (
  @institution_feature_columns_contract_matches = 1
  AND @institution_feature_engine_contract_matches = 1
  AND @institution_feature_primary_contract_matches = 1
  AND @institution_feature_unique_contract_matches = 1
  AND @institution_feature_lookup_contract_matches = 1
  AND @institution_feature_foreign_keys_contract_matches = 1
);
SET @institution_feature_contract_guard := IF(
  @institution_feature_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM institution_feature_entitlements_contract_mismatch WHERE 1 = 0'
);
PREPARE institution_feature_contract_guard_stmt
  FROM @institution_feature_contract_guard;
EXECUTE institution_feature_contract_guard_stmt;
DEALLOCATE PREPARE institution_feature_contract_guard_stmt;

-- Expande o enum de auditoria preservando todos os valores já instalados.
SET @audit_action_contract_matches := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
    AND LOWER(COLUMN_TYPE) LIKE 'enum(%'
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT IS NULL
    AND COLUMN_COMMENT = ''
);
SET @audit_action_guard := IF(
  @audit_action_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM institution_feature_audit_action_contract_mismatch WHERE 1 = 0'
);
PREPARE audit_action_guard_stmt FROM @audit_action_guard;
EXECUTE audit_action_guard_stmt;
DEALLOCATE PREPARE audit_action_guard_stmt;

SET @action_column_type := (
  SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
  LIMIT 1
);
SET @action_character_set := (
  SELECT CHARACTER_SET_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
  LIMIT 1
);
SET @action_collation := (
  SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
  LIMIT 1
);
SET @ddl := IF(
  LOCATE('''INSTITUTION_FEATURE_UPDATED''', @action_column_type) = 0,
  CONCAT(
    'ALTER TABLE audit_trail MODIFY COLUMN action ',
    LEFT(@action_column_type, CHAR_LENGTH(@action_column_type) - 1),
    ',''INSTITUTION_FEATURE_UPDATED'') CHARACTER SET ',
    @action_character_set,
    ' COLLATE ',
    @action_collation,
    ' NOT NULL'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @audit_entity_contract_matches := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'entity_type'
    AND LOWER(COLUMN_TYPE) LIKE 'enum(%'
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT IS NULL
    AND COLUMN_COMMENT = ''
);
SET @audit_entity_guard := IF(
  @audit_entity_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM institution_feature_audit_entity_contract_mismatch WHERE 1 = 0'
);
PREPARE audit_entity_guard_stmt FROM @audit_entity_guard;
EXECUTE audit_entity_guard_stmt;
DEALLOCATE PREPARE audit_entity_guard_stmt;

SET @entity_column_type := (
  SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'entity_type'
  LIMIT 1
);
SET @entity_character_set := (
  SELECT CHARACTER_SET_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'entity_type'
  LIMIT 1
);
SET @entity_collation := (
  SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'entity_type'
  LIMIT 1
);
SET @ddl := IF(
  LOCATE('''INSTITUTION''', @entity_column_type) = 0,
  CONCAT(
    'ALTER TABLE audit_trail MODIFY COLUMN entity_type ',
    LEFT(@entity_column_type, CHAR_LENGTH(@entity_column_type) - 1),
    ',''INSTITUTION'') CHARACTER SET ',
    @entity_character_set,
    ' COLLATE ',
    @entity_collation,
    ' NOT NULL'
  ),
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT INTO institution_feature_entitlements (
  institution_id,
  feature_code,
  enabled,
  source,
  version,
  updated_by_user_id
)
SELECT
  institutions.id,
  'CROSS_SCHEDULE_ROSTER_VIEW',
  1,
  'LEGACY_COMPATIBILITY',
  1,
  NULL
FROM institutions
WHERE UNIX_TIMESTAMP(institutions.created_at) <= 1788905520
ON DUPLICATE KEY UPDATE
  feature_code = institution_feature_entitlements.feature_code;
