-- 2026-09-09 — torna reproduzíveis contratos antigos ainda usados em runtime.
--
-- As colunas estruturadas de modalidade existiam apenas na trilha legada do
-- Drizzle e institution_config não possuía SQL manual. Staging evolui pela
-- trilha manual; portanto, uma instalação nova precisava depender de história
-- externa ao diretório canônico de migrations.
--
-- Esta migration é somente aditiva. Estado homônimo parcial ou incompatível
-- falha antes do primeiro DDL. Nenhuma linha histórica é reclassificada.

SET @csr_shift_base_contract_matches := (
  SELECT COUNT(*) = 2
    AND SUM(CASE
      WHEN COLUMN_NAME = 'id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO' THEN 1
      WHEN COLUMN_NAME = 'institution_id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO' THEN 1
      ELSE 0 END) = 2
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME IN ('id', 'institution_id')
);

SET @csr_institutions_contract_matches := (
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'institutions'
     AND UPPER(ENGINE) = 'INNODB') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'institutions'
     AND COLUMN_NAME = 'id'
     AND DATA_TYPE = 'int'
     AND IS_NULLABLE = 'NO') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'institutions'
     AND INDEX_NAME = 'PRIMARY'
     AND NON_UNIQUE = 0
     AND SEQ_IN_INDEX = 1
     AND COLUMN_NAME = 'id') = 1
);

SET @csr_modality_column_count := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME IN (
      'modality', 'coverage_type', 'payment_model', 'productivity_cap_brl'
    )
);

SET @csr_modality_columns_contract_matches := (
  @csr_modality_column_count = 0
  OR (
    @csr_modality_column_count = 4
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME = 'modality'
        AND DATA_TYPE = 'enum'
        AND COLUMN_TYPE = 'enum(''PLANTAO'',''SOBREAVISO'')'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT = 'PLANTAO') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME = 'coverage_type'
        AND DATA_TYPE = 'enum'
        AND COLUMN_TYPE = 'enum(''URGENCIA_EMERGENCIA'',''ELETIVAS'')'
        AND IS_NULLABLE = 'YES'
        AND COLUMN_DEFAULT IS NULL) = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME = 'payment_model'
        AND DATA_TYPE = 'enum'
        AND COLUMN_TYPE = 'enum(''FIXO'',''FIXO_PRODUTIVIDADE_TETO'',''FIXO_PRODUTIVIDADE_SEM_TETO'',''PRODUTIVIDADE_PURA'')'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT = 'FIXO') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME = 'productivity_cap_brl'
        AND DATA_TYPE = 'decimal'
        AND NUMERIC_PRECISION = 12
        AND NUMERIC_SCALE = 2
        AND IS_NULLABLE = 'YES'
        AND COLUMN_DEFAULT IS NULL) = 1
  )
);

SET @csr_modality_index_count := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND INDEX_NAME = 'idx_shift_instances_modality'
);

SET @csr_modality_index_contract_matches := (
  @csr_modality_index_count = 0
  OR (
    @csr_modality_index_count = 2
    AND (SELECT SUM(CASE
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1
        AND COLUMN_NAME = 'institution_id' THEN 1
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 2
        AND COLUMN_NAME = 'modality' THEN 1
      ELSE 0 END)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'shift_instances'
      AND INDEX_NAME = 'idx_shift_instances_modality') = 2
  )
);

SET @csr_institution_config_exists := (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'institution_config'
);

SET @csr_institution_config_columns_contract_matches := (
  @csr_institution_config_exists = 0
  OR (
    @csr_institution_config_exists = 1
    AND (SELECT COUNT(*) = 5 AND SUM(CASE
      WHEN COLUMN_NAME = 'id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND LOWER(COALESCE(EXTRA, '')) LIKE '%auto_increment%' THEN 1
      WHEN COLUMN_NAME = 'institution_id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL THEN 1
      WHEN COLUMN_NAME = 'edit_window_days'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IN ('3', 3) THEN 1
      WHEN COLUMN_NAME = 'created_at'
        AND DATA_TYPE = 'timestamp'
        AND IS_NULLABLE = 'NO'
        AND UPPER(COALESCE(COLUMN_DEFAULT, '')) IN (
          'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()'
        )
        AND LOWER(COALESCE(EXTRA, '')) NOT LIKE '%on update%' THEN 1
      WHEN COLUMN_NAME = 'updated_at'
        AND DATA_TYPE = 'timestamp'
        AND IS_NULLABLE = 'NO'
        AND UPPER(COALESCE(COLUMN_DEFAULT, '')) IN (
          'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()'
        )
        AND LOWER(COALESCE(EXTRA, '')) LIKE '%on update%' THEN 1
      ELSE 0 END) = 5
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'institution_config')
  )
);

SET @csr_institution_config_keys_contract_matches := (
  @csr_institution_config_exists = 0
  OR (
    (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'institution_config'
       AND INDEX_NAME = 'PRIMARY'
       AND NON_UNIQUE = 0
       AND SEQ_IN_INDEX = 1
       AND COLUMN_NAME = 'id') = 1
    AND
    (SELECT COUNT(*) FROM (
      SELECT INDEX_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'institution_config'
        AND INDEX_NAME <> 'PRIMARY'
        AND NON_UNIQUE = 0
      GROUP BY INDEX_NAME
      HAVING COUNT(*) = 1
        AND MAX(SEQ_IN_INDEX) = 1
        AND MAX(COLUMN_NAME) = 'institution_id'
    ) AS csr_unique_institution_indexes) = 1
    AND
    (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'institution_config'
       AND INDEX_NAME = 'idx_institution_config_institution_id') = 2
    AND
    (SELECT SUM(CASE
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1
        AND COLUMN_NAME = 'institution_id' THEN 1
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 2
        AND COLUMN_NAME = 'id' THEN 1
      ELSE 0 END)
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'institution_config'
       AND INDEX_NAME = 'idx_institution_config_institution_id') = 2
  )
);

SET @csr_institution_config_fk_contract_matches := (
  @csr_institution_config_exists = 0
  OR (
    (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'institution_config'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1
    AND
    (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'institution_config'
       AND COLUMN_NAME = 'institution_id'
       AND REFERENCED_TABLE_NAME = 'institutions'
       AND REFERENCED_COLUMN_NAME = 'id') = 1
    AND
    (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'institution_config'
       AND DELETE_RULE = 'CASCADE') = 1
  )
);

SET @csr_preflight_contract_matches := (
  @csr_shift_base_contract_matches = 1
  AND @csr_institutions_contract_matches = 1
  AND @csr_modality_columns_contract_matches = 1
  AND @csr_modality_index_contract_matches = 1
  AND @csr_institution_config_columns_contract_matches = 1
  AND @csr_institution_config_keys_contract_matches = 1
  AND @csr_institution_config_fk_contract_matches = 1
);

SET @csr_guard_sql := IF(
  @csr_preflight_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM core_schema_reproducibility_contract_mismatch WHERE 1 = 0'
);
PREPARE csr_guard_stmt FROM @csr_guard_sql;
EXECUTE csr_guard_stmt;
DEALLOCATE PREPARE csr_guard_stmt;

SET @csr_modality_ddl := IF(
  @csr_modality_column_count = 0,
  'ALTER TABLE shift_instances
    ADD COLUMN modality ENUM(''PLANTAO'',''SOBREAVISO'') NOT NULL DEFAULT ''PLANTAO'',
    ADD COLUMN coverage_type ENUM(''URGENCIA_EMERGENCIA'',''ELETIVAS'') NULL,
    ADD COLUMN payment_model ENUM(''FIXO'',''FIXO_PRODUTIVIDADE_TETO'',''FIXO_PRODUTIVIDADE_SEM_TETO'',''PRODUTIVIDADE_PURA'') NOT NULL DEFAULT ''FIXO'',
    ADD COLUMN productivity_cap_brl DECIMAL(12,2) NULL,
    ADD INDEX idx_shift_instances_modality (institution_id, modality)',
  IF(
    @csr_modality_index_count = 0,
    'CREATE INDEX idx_shift_instances_modality
      ON shift_instances (institution_id, modality)',
    'SELECT 1'
  )
);
PREPARE csr_modality_stmt FROM @csr_modality_ddl;
EXECUTE csr_modality_stmt;
DEALLOCATE PREPARE csr_modality_stmt;

CREATE TABLE IF NOT EXISTS institution_config (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  edit_window_days INT NOT NULL DEFAULT 3,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY institution_config_institution_id_unique (institution_id),
  KEY idx_institution_config_institution_id (institution_id, id),
  CONSTRAINT fk_institution_config_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

SET @csr_postflight_contract_matches := (
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shift_instances'
     AND COLUMN_NAME IN (
       'modality', 'coverage_type', 'payment_model', 'productivity_cap_brl'
     )) = 4
  AND
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shift_instances'
     AND INDEX_NAME = 'idx_shift_instances_modality') = 2
  AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'institution_config') = 5
  AND
  (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'institution_config'
     AND COLUMN_NAME = 'institution_id'
     AND REFERENCED_TABLE_NAME = 'institutions'
     AND REFERENCED_COLUMN_NAME = 'id') = 1
);

SET @csr_postflight_sql := IF(
  @csr_postflight_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM core_schema_reproducibility_postflight_failed WHERE 1 = 0'
);
PREPARE csr_postflight_stmt FROM @csr_postflight_sql;
EXECUTE csr_postflight_stmt;
DEALLOCATE PREPARE csr_postflight_stmt;
