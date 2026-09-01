-- 2026-09-02 — revisão e compromisso canônico para ACCESS_UPDATED.
--
-- Pré-requisito: foundation de eventos e modo de emissão já aplicados.
-- Aditiva e rerodável: não reescreve vínculos, ACLs, escopos ou fatos
-- existentes. ACCESS_UPDATED só é emitido pelo writer novo com revisão e hash
-- canônicos; fatos anteriores permanecem sem access_state_hash.

SET @professional_institutions_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_institutions'
);
SET @operational_events_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
);
SET @emission_mode_contract_matches := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
    AND COLUMN_NAME = 'emission_mode'
    AND COLUMN_TYPE = 'enum(''SHADOW'',''ACTIVE'')'
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT = 'SHADOW'
);

-- Sem as tabelas ou o modo imutável SHADOW, parar é mais seguro que marcar
-- uma aplicação parcial como bem-sucedida.
SET @access_updated_foundation_precondition := IF(
  @professional_institutions_exists = 1
  AND @operational_events_exists = 1
  AND @emission_mode_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM operational_access_updated_foundation_missing WHERE 1 = 0'
);
PREPARE access_updated_foundation_stmt FROM @access_updated_foundation_precondition;
EXECUTE access_updated_foundation_stmt;
DEALLOCATE PREPARE access_updated_foundation_stmt;

SET @operational_revision_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_institutions'
    AND COLUMN_NAME = 'operational_revision'
);
SET @operational_revision_contract_matches := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_institutions'
    AND COLUMN_NAME = 'operational_revision'
    AND COLUMN_TYPE = 'int'
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT = '0'
);
SET @operational_revision_contract_precondition := IF(
  @operational_revision_exists = 0
  OR @operational_revision_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM professional_institutions_revision_contract_mismatch WHERE 1 = 0'
);
PREPARE operational_revision_contract_stmt FROM @operational_revision_contract_precondition;
EXECUTE operational_revision_contract_stmt;
DEALLOCATE PREPARE operational_revision_contract_stmt;

SET @operational_revision_ddl := IF(
  @operational_revision_exists = 0,
  'ALTER TABLE professional_institutions ADD COLUMN operational_revision INT NOT NULL DEFAULT 0 AFTER active',
  'SELECT 1'
);
PREPARE operational_revision_stmt FROM @operational_revision_ddl;
EXECUTE operational_revision_stmt;
DEALLOCATE PREPARE operational_revision_stmt;

SET @access_state_hash_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
    AND COLUMN_NAME = 'access_state_hash'
);
SET @access_state_hash_contract_matches := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
    AND COLUMN_NAME = 'access_state_hash'
    AND COLUMN_TYPE = 'varchar(64)'
    AND IS_NULLABLE = 'YES'
    AND CHARACTER_SET_NAME = 'utf8mb4'
    AND COLLATION_NAME = 'utf8mb4_bin'
    AND COLUMN_DEFAULT IS NULL
);
SET @access_state_hash_contract_precondition := IF(
  @access_state_hash_exists = 0
  OR @access_state_hash_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM operational_events_access_hash_contract_mismatch WHERE 1 = 0'
);
PREPARE access_state_hash_contract_stmt FROM @access_state_hash_contract_precondition;
EXECUTE access_state_hash_contract_stmt;
DEALLOCATE PREPARE access_state_hash_contract_stmt;

SET @access_state_hash_ddl := IF(
  @access_state_hash_exists = 0,
  'ALTER TABLE operational_events ADD COLUMN access_state_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER event_hash',
  'SELECT 1'
);
PREPARE access_state_hash_stmt FROM @access_state_hash_ddl;
EXECUTE access_state_hash_stmt;
DEALLOCATE PREPARE access_state_hash_stmt;
