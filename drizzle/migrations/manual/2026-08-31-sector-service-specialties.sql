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
-- Um índice homônimo, porém incompatível, não pode ser aceito como pai da FK
-- composta. Falhar antes do ALTER evita reinterpretar uma instalação parcial.
SET @sectors_topology_index_contract_matches := (
  SELECT COUNT(*) = 3
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 0
          AND (
            (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id')
            OR (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id')
            OR (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'id')
          )
        THEN 1 ELSE 0
      END
    ) = 3
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sectors'
    AND INDEX_NAME = 'uniq_sectors_topology_id'
);
SET @sectors_topology_index_precondition := IF(
  @idx_exists = 0 OR @sectors_topology_index_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM sector_service_specialties_sectors_index_contract_mismatch WHERE 1 = 0'
);
PREPARE sectors_topology_index_precondition_stmt FROM @sectors_topology_index_precondition;
EXECUTE sectors_topology_index_precondition_stmt;
DEALLOCATE PREPARE sectors_topology_index_precondition_stmt;

SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE sectors ADD UNIQUE KEY uniq_sectors_topology_id (institution_id, hospital_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sectors_topology_index_contract_matches := (
  SELECT COUNT(*) = 3
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 0
          AND (
            (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id')
            OR (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id')
            OR (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'id')
          )
        THEN 1 ELSE 0
      END
    ) = 3
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sectors'
    AND INDEX_NAME = 'uniq_sectors_topology_id'
);
SET @sectors_topology_index_postcondition := IF(
  @sectors_topology_index_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM sector_service_specialties_sectors_index_contract_mismatch WHERE 1 = 0'
);
PREPARE sectors_topology_index_postcondition_stmt FROM @sectors_topology_index_postcondition;
EXECUTE sectors_topology_index_postcondition_stmt;
DEALLOCATE PREPARE sectors_topology_index_postcondition_stmt;

-- `CREATE TABLE IF NOT EXISTS` não corrige uma tabela já existente. Antes de
-- reutilizá-la, aceitamos somente o núcleo compatível; índices e FKs ausentes
-- podem ser adicionados abaixo, mas um objeto homônimo e incompatível falha.
SET @sector_service_specialties_table_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
);
SET @sector_service_specialties_columns_contract_matches := (
  SELECT COUNT(*) = 6
    AND SUM(
      CASE
        WHEN (
          COLUMN_NAME = 'id'
          AND DATA_TYPE = 'int'
          AND LOWER(COLUMN_TYPE) NOT LIKE '%unsigned%'
          AND IS_NULLABLE = 'NO'
          AND LOWER(COALESCE(EXTRA, '')) LIKE '%auto_increment%'
        ) OR (
          COLUMN_NAME IN (
            'institution_id', 'hospital_id', 'sector_id', 'medical_specialty_id'
          )
          AND DATA_TYPE = 'int'
          AND LOWER(COLUMN_TYPE) NOT LIKE '%unsigned%'
          AND IS_NULLABLE = 'NO'
          AND COLUMN_DEFAULT IS NULL
          AND COALESCE(EXTRA, '') = ''
        ) OR (
          COLUMN_NAME = 'created_at'
          AND DATA_TYPE = 'timestamp'
          AND IS_NULLABLE = 'NO'
          AND UPPER(COALESCE(COLUMN_DEFAULT, '')) IN (
            'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()'
          )
          AND LOWER(COALESCE(EXTRA, '')) NOT LIKE '%on update%'
        )
        THEN 1 ELSE 0
      END
    ) = 6
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
);
SET @sector_service_specialties_engine_contract_matches := (
  SELECT COUNT(*) = 1
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND UPPER(ENGINE) = 'INNODB'
);
SET @sector_service_specialties_primary_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 0
          AND SEQ_IN_INDEX = 1
          AND COLUMN_NAME = 'id'
        THEN 1 ELSE 0
      END
    ) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'PRIMARY'
);
SET @sector_service_specialties_unique_index_entries := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'uniq_sector_service_specialty'
);
SET @sector_service_specialties_unique_index_contract_matches := (
  SELECT COUNT(*) = 4
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 0
          AND (
            (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id')
            OR (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id')
            OR (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'sector_id')
            OR (SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'medical_specialty_id')
          )
        THEN 1 ELSE 0
      END
    ) = 4
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'uniq_sector_service_specialty'
);
SET @sector_service_specialties_specialty_index_entries := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'idx_sector_service_specialty_specialty'
);
SET @sector_service_specialties_specialty_index_contract_matches := (
  SELECT COUNT(*) = 2
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 1
          AND (
            (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'medical_specialty_id')
            OR (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'institution_id')
          )
        THEN 1 ELSE 0
      END
    ) = 2
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'idx_sector_service_specialty_specialty'
);
SET @sector_service_specialties_institution_fk_entries := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_institution'
);
SET @sector_service_specialties_institution_fk_contract_matches := (
  (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_institution'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_institution') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_institution'
      AND ORDINAL_POSITION = 1
      AND COLUMN_NAME = 'institution_id'
      AND REFERENCED_TABLE_NAME = 'institutions'
      AND REFERENCED_COLUMN_NAME = 'id') = 1
);
SET @sector_service_specialties_hospital_fk_entries := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_hospital'
);
SET @sector_service_specialties_hospital_fk_contract_matches := (
  (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_hospital'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_hospital') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_hospital'
      AND ORDINAL_POSITION = 1
      AND COLUMN_NAME = 'hospital_id'
      AND REFERENCED_TABLE_NAME = 'hospitals'
      AND REFERENCED_COLUMN_NAME = 'id') = 1
);
SET @sector_service_specialties_sector_fk_entries := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_sector'
);
SET @sector_service_specialties_sector_fk_contract_matches := (
  (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_sector'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_sector') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_sector'
      AND ORDINAL_POSITION = 1
      AND COLUMN_NAME = 'sector_id'
      AND REFERENCED_TABLE_NAME = 'sectors'
      AND REFERENCED_COLUMN_NAME = 'id') = 1
);
SET @sector_service_specialties_medical_specialty_fk_entries := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_medical_specialty'
);
SET @sector_service_specialties_medical_specialty_fk_contract_matches := (
  (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_medical_specialty'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_medical_specialty') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_medical_specialty'
      AND ORDINAL_POSITION = 1
      AND COLUMN_NAME = 'medical_specialty_id'
      AND REFERENCED_TABLE_NAME = 'medical_specialties'
      AND REFERENCED_COLUMN_NAME = 'id') = 1
);
SET @sector_service_specialties_topology_fk_entries := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_NAME = 'fk_sector_service_specialty_topology'
);
SET @sector_service_specialties_topology_fk_contract_matches := (
  (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_topology'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_topology') = 3
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME = 'fk_sector_service_specialty_topology'
      AND (
        (ORDINAL_POSITION = 1
          AND COLUMN_NAME = 'institution_id'
          AND REFERENCED_TABLE_NAME = 'sectors'
          AND REFERENCED_COLUMN_NAME = 'institution_id')
        OR (ORDINAL_POSITION = 2
          AND COLUMN_NAME = 'hospital_id'
          AND REFERENCED_TABLE_NAME = 'sectors'
          AND REFERENCED_COLUMN_NAME = 'hospital_id')
        OR (ORDINAL_POSITION = 3
          AND COLUMN_NAME = 'sector_id'
          AND REFERENCED_TABLE_NAME = 'sectors'
          AND REFERENCED_COLUMN_NAME = 'id')
      )) = 3
);
-- Relações adicionais também alteram a semântica de escrita. Uma tabela
-- parcial pode estar sem algumas FKs previstas (que serão adicionadas), mas
-- não pode carregar uma FK desconhecida e ser aceita silenciosamente.
SET @sector_service_specialties_foreign_key_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sector_service_specialties_existing_contract_matches := (
  @sector_service_specialties_columns_contract_matches = 1
  AND @sector_service_specialties_engine_contract_matches = 1
  AND @sector_service_specialties_primary_contract_matches = 1
  AND (
    @sector_service_specialties_unique_index_entries = 0
    OR @sector_service_specialties_unique_index_contract_matches = 1
  )
  AND (
    @sector_service_specialties_specialty_index_entries = 0
    OR @sector_service_specialties_specialty_index_contract_matches = 1
  )
  AND (
    @sector_service_specialties_institution_fk_entries = 0
    OR @sector_service_specialties_institution_fk_contract_matches = 1
  )
  AND (
    @sector_service_specialties_hospital_fk_entries = 0
    OR @sector_service_specialties_hospital_fk_contract_matches = 1
  )
  AND (
    @sector_service_specialties_sector_fk_entries = 0
    OR @sector_service_specialties_sector_fk_contract_matches = 1
  )
  AND (
    @sector_service_specialties_medical_specialty_fk_entries = 0
    OR @sector_service_specialties_medical_specialty_fk_contract_matches = 1
  )
  AND (
    @sector_service_specialties_topology_fk_entries = 0
    OR @sector_service_specialties_topology_fk_contract_matches = 1
  )
  AND @sector_service_specialties_foreign_key_count = (
    IF(@sector_service_specialties_institution_fk_entries > 0, 1, 0)
    + IF(@sector_service_specialties_hospital_fk_entries > 0, 1, 0)
    + IF(@sector_service_specialties_sector_fk_entries > 0, 1, 0)
    + IF(@sector_service_specialties_medical_specialty_fk_entries > 0, 1, 0)
    + IF(@sector_service_specialties_topology_fk_entries > 0, 1, 0)
  )
);
SET @sector_service_specialties_existing_table_precondition := IF(
  @sector_service_specialties_table_exists = 0
    OR @sector_service_specialties_existing_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM sector_service_specialties_existing_table_contract_mismatch WHERE 1 = 0'
);
PREPARE sector_service_specialties_existing_table_precondition_stmt
  FROM @sector_service_specialties_existing_table_precondition;
EXECUTE sector_service_specialties_existing_table_precondition_stmt;
DEALLOCATE PREPARE sector_service_specialties_existing_table_precondition_stmt;

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
) ENGINE=InnoDB;

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

-- Confere o contrato completo depois dos reparos aditivos. A migration nunca
-- transforma uma tabela com o mesmo nome em uma estrutura diferente sem
-- parar: o próximo passo deve ser uma correção explícita e auditável.
SET @sector_service_specialties_columns_contract_matches := (
  SELECT COUNT(*) = 6
    AND SUM(
      CASE
        WHEN (
          COLUMN_NAME = 'id'
          AND DATA_TYPE = 'int'
          AND LOWER(COLUMN_TYPE) NOT LIKE '%unsigned%'
          AND IS_NULLABLE = 'NO'
          AND LOWER(COALESCE(EXTRA, '')) LIKE '%auto_increment%'
        ) OR (
          COLUMN_NAME IN (
            'institution_id', 'hospital_id', 'sector_id', 'medical_specialty_id'
          )
          AND DATA_TYPE = 'int'
          AND LOWER(COLUMN_TYPE) NOT LIKE '%unsigned%'
          AND IS_NULLABLE = 'NO'
          AND COLUMN_DEFAULT IS NULL
          AND COALESCE(EXTRA, '') = ''
        ) OR (
          COLUMN_NAME = 'created_at'
          AND DATA_TYPE = 'timestamp'
          AND IS_NULLABLE = 'NO'
          AND UPPER(COALESCE(COLUMN_DEFAULT, '')) IN (
            'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()'
          )
          AND LOWER(COALESCE(EXTRA, '')) NOT LIKE '%on update%'
        )
        THEN 1 ELSE 0
      END
    ) = 6
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
);
SET @sector_service_specialties_engine_contract_matches := (
  SELECT COUNT(*) = 1
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND UPPER(ENGINE) = 'INNODB'
);
SET @sector_service_specialties_primary_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 0
          AND SEQ_IN_INDEX = 1
          AND COLUMN_NAME = 'id'
        THEN 1 ELSE 0
      END
    ) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'PRIMARY'
);
SET @sector_service_specialties_unique_index_contract_matches := (
  SELECT COUNT(*) = 4
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 0
          AND (
            (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id')
            OR (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id')
            OR (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'sector_id')
            OR (SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'medical_specialty_id')
          )
        THEN 1 ELSE 0
      END
    ) = 4
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'uniq_sector_service_specialty'
);
SET @sector_service_specialties_specialty_index_contract_matches := (
  SELECT COUNT(*) = 2
    AND SUM(
      CASE
        WHEN NON_UNIQUE = 1
          AND (
            (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'medical_specialty_id')
            OR (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'institution_id')
          )
        THEN 1 ELSE 0
      END
    ) = 2
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sector_service_specialties'
    AND INDEX_NAME = 'idx_sector_service_specialty_specialty'
);
SET @sector_service_specialties_foreign_keys_contract_matches := (
  (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 5
  AND
  (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN (
        'fk_sector_service_specialty_institution',
        'fk_sector_service_specialty_hospital',
        'fk_sector_service_specialty_sector',
        'fk_sector_service_specialty_medical_specialty',
        'fk_sector_service_specialty_topology'
      )) = 5
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND CONSTRAINT_NAME IN (
        'fk_sector_service_specialty_institution',
        'fk_sector_service_specialty_hospital',
        'fk_sector_service_specialty_sector',
        'fk_sector_service_specialty_medical_specialty',
        'fk_sector_service_specialty_topology'
      )) = 7
  AND (SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sector_service_specialties'
      AND (
        (CONSTRAINT_NAME = 'fk_sector_service_specialty_institution'
          AND ORDINAL_POSITION = 1
          AND COLUMN_NAME = 'institution_id'
          AND REFERENCED_TABLE_NAME = 'institutions'
          AND REFERENCED_COLUMN_NAME = 'id')
        OR (CONSTRAINT_NAME = 'fk_sector_service_specialty_hospital'
          AND ORDINAL_POSITION = 1
          AND COLUMN_NAME = 'hospital_id'
          AND REFERENCED_TABLE_NAME = 'hospitals'
          AND REFERENCED_COLUMN_NAME = 'id')
        OR (CONSTRAINT_NAME = 'fk_sector_service_specialty_sector'
          AND ORDINAL_POSITION = 1
          AND COLUMN_NAME = 'sector_id'
          AND REFERENCED_TABLE_NAME = 'sectors'
          AND REFERENCED_COLUMN_NAME = 'id')
        OR (CONSTRAINT_NAME = 'fk_sector_service_specialty_medical_specialty'
          AND ORDINAL_POSITION = 1
          AND COLUMN_NAME = 'medical_specialty_id'
          AND REFERENCED_TABLE_NAME = 'medical_specialties'
          AND REFERENCED_COLUMN_NAME = 'id')
        OR (CONSTRAINT_NAME = 'fk_sector_service_specialty_topology'
          AND ORDINAL_POSITION = 1
          AND COLUMN_NAME = 'institution_id'
          AND REFERENCED_TABLE_NAME = 'sectors'
          AND REFERENCED_COLUMN_NAME = 'institution_id')
        OR (CONSTRAINT_NAME = 'fk_sector_service_specialty_topology'
          AND ORDINAL_POSITION = 2
          AND COLUMN_NAME = 'hospital_id'
          AND REFERENCED_TABLE_NAME = 'sectors'
          AND REFERENCED_COLUMN_NAME = 'hospital_id')
        OR (CONSTRAINT_NAME = 'fk_sector_service_specialty_topology'
          AND ORDINAL_POSITION = 3
          AND COLUMN_NAME = 'sector_id'
          AND REFERENCED_TABLE_NAME = 'sectors'
          AND REFERENCED_COLUMN_NAME = 'id')
      )) = 7
);
SET @sector_service_specialties_postcondition_matches := (
  @sector_service_specialties_columns_contract_matches = 1
  AND @sector_service_specialties_engine_contract_matches = 1
  AND @sector_service_specialties_primary_contract_matches = 1
  AND @sector_service_specialties_unique_index_contract_matches = 1
  AND @sector_service_specialties_specialty_index_contract_matches = 1
  AND @sector_service_specialties_foreign_keys_contract_matches = 1
);
SET @sector_service_specialties_postcondition := IF(
  @sector_service_specialties_postcondition_matches = 1,
  'SELECT 1',
  'SELECT * FROM sector_service_specialties_table_contract_mismatch WHERE 1 = 0'
);
PREPARE sector_service_specialties_postcondition_stmt
  FROM @sector_service_specialties_postcondition;
EXECUTE sector_service_specialties_postcondition_stmt;
DEALLOCATE PREPARE sector_service_specialties_postcondition_stmt;

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
