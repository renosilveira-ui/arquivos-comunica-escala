-- 2026-08-31 — especialidades assistenciais descritivas por setor.
--
-- Migração aditiva e rerodável. Esta tabela não participa de admission_policy,
-- professional_access, convites, alocação, troca ou elegibilidade. A política
-- de uma schedule_context continua sendo a única fonte de qualificação.
--
-- Não há backfill nesta migration: nomes de setor são dados operacionais e
-- devem ser confirmados por instituição antes de qualquer carga.

-- A FK composta abaixo não depende implicitamente da migration de contexts:
-- garante a chave-pai no próprio arquivo, de forma aditiva e rerodável.
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

CREATE TABLE IF NOT EXISTS sector_service_specialties (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  sector_id INT NOT NULL,
  medical_specialty_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_sector_service_specialty
    (institution_id, hospital_id, sector_id, medical_specialty_id),
  KEY idx_sector_service_specialty_specialty
    (medical_specialty_id, institution_id),
  CONSTRAINT fk_sector_service_specialty_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_sector_service_specialty_hospital
    FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_sector_service_specialty_sector
    FOREIGN KEY (sector_id) REFERENCES sectors(id),
  CONSTRAINT fk_sector_service_specialty_medical_specialty
    FOREIGN KEY (medical_specialty_id) REFERENCES medical_specialties(id),
  CONSTRAINT fk_sector_service_specialty_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors(institution_id, hospital_id, id)
);

-- Recupera instalações parcialmente criadas sem sobrescrever dados existentes.
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'uniq_sector_service_specialty'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE sector_service_specialties ADD UNIQUE KEY uniq_sector_service_specialty (institution_id, hospital_id, sector_id, medical_specialty_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'idx_sector_service_specialty_specialty'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE sector_service_specialties ADD KEY idx_sector_service_specialty_specialty (medical_specialty_id, institution_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_institution'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE sector_service_specialties ADD CONSTRAINT fk_sector_service_specialty_institution FOREIGN KEY (institution_id) REFERENCES institutions(id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_hospital'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE sector_service_specialties ADD CONSTRAINT fk_sector_service_specialty_hospital FOREIGN KEY (hospital_id) REFERENCES hospitals(id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_sector'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE sector_service_specialties ADD CONSTRAINT fk_sector_service_specialty_sector FOREIGN KEY (sector_id) REFERENCES sectors(id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_medical_specialty'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE sector_service_specialties ADD CONSTRAINT fk_sector_service_specialty_medical_specialty FOREIGN KEY (medical_specialty_id) REFERENCES medical_specialties(id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_topology'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE sector_service_specialties ADD CONSTRAINT fk_sector_service_specialty_topology FOREIGN KEY (institution_id, hospital_id, sector_id) REFERENCES sectors(institution_id, hospital_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A alteração de metadado é auditada como alteração de setor. O enum é
-- expandido de forma aditiva e preserva todos os valores históricos. Uma
-- coluna ausente, anulável ou que não seja enum não é reinterpretada: a
-- migration falha antes do ALTER, sem adaptar um contrato de auditoria que
-- não reconhece.
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
SET @audit_action_precondition := IF(
  @audit_action_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM sector_service_specialties_audit_action_contract_mismatch WHERE 1 = 0'
);
PREPARE audit_action_precondition_stmt FROM @audit_action_precondition;
EXECUTE audit_action_precondition_stmt;
DEALLOCATE PREPARE audit_action_precondition_stmt;

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
  LOCATE('''SECTOR_SERVICE_SPECIALTIES_UPDATED''', @action_column_type) = 0,
  CONCAT(
    'ALTER TABLE audit_trail MODIFY COLUMN action ',
    LEFT(@action_column_type, CHAR_LENGTH(@action_column_type) - 1),
    ', ''SECTOR_SERVICE_SPECIALTIES_UPDATED'') CHARACTER SET ',
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
SET @audit_entity_precondition := IF(
  @audit_entity_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM sector_service_specialties_audit_entity_contract_mismatch WHERE 1 = 0'
);
PREPARE audit_entity_precondition_stmt FROM @audit_entity_precondition;
EXECUTE audit_entity_precondition_stmt;
DEALLOCATE PREPARE audit_entity_precondition_stmt;

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
  LOCATE('''SECTOR''', @entity_column_type) = 0,
  CONCAT(
    'ALTER TABLE audit_trail MODIFY COLUMN entity_type ',
    LEFT(@entity_column_type, CHAR_LENGTH(@entity_column_type) - 1),
    ', ''SECTOR'') CHARACTER SET ',
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
