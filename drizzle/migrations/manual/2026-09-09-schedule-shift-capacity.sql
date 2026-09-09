-- Prospective only. No historical row is backfilled or consolidated.
-- A partial or homonymous installation must fail before this migration changes
-- any object. Runtime code depends on this exact physical contract.

SET @ssc_base_columns_contract_matches := (
  SELECT COUNT(*) = 6
    AND SUM(CASE
      WHEN COLUMN_NAME IN ('institution_id', 'hospital_id', 'sector_id')
        AND DATA_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1
      WHEN COLUMN_NAME = 'schedule_context_id'
        AND DATA_TYPE = 'int' AND IS_NULLABLE = 'YES' THEN 1
      WHEN COLUMN_NAME IN ('start_at', 'end_at')
        AND DATA_TYPE = 'timestamp' AND IS_NULLABLE = 'NO' THEN 1
      ELSE 0 END) = 6
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME IN (
      'institution_id', 'hospital_id', 'sector_id',
      'schedule_context_id', 'start_at', 'end_at'
    )
);
SET @ssc_base_tables_contract_matches := (
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shift_instances'
     AND UPPER(ENGINE) = 'INNODB') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_contexts'
     AND UPPER(ENGINE) = 'INNODB') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_contexts'
     AND COLUMN_NAME = 'id'
     AND DATA_TYPE = 'int'
     AND COLUMN_TYPE = 'int'
     AND IS_NULLABLE = 'NO') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_contexts'
     AND INDEX_NAME = 'PRIMARY'
     AND NON_UNIQUE = 0
     AND SEQ_IN_INDEX = 1
     AND COLUMN_NAME = 'id') = 1
);

SET @ssc_has_required_capacity := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'required_capacity'
);
SET @ssc_required_capacity_contract_matches := (
  @ssc_has_required_capacity = 0
  OR (
    @ssc_has_required_capacity = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME = 'required_capacity'
        AND DATA_TYPE = 'int'
        AND COLUMN_TYPE = 'int'
        AND IS_NULLABLE = 'YES'
        AND (COLUMN_DEFAULT IS NULL OR COLUMN_DEFAULT IN ('1', 1))
        AND COALESCE(EXTRA, '') = ''
        AND COALESCE(GENERATION_EXPRESSION, '') = '') = 1
  )
);

SET @ssc_has_capacity_context := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'capacity_context_id'
);
SET @ssc_capacity_context_contract_matches := (
  @ssc_has_capacity_context = 0
  OR (
    @ssc_has_capacity_context = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME = 'capacity_context_id'
        AND DATA_TYPE = 'int'
        AND COLUMN_TYPE = 'int'
        AND IS_NULLABLE = 'YES'
        AND COLUMN_DEFAULT IS NULL
        AND UPPER(COALESCE(EXTRA, '')) = 'STORED GENERATED'
        AND LOWER(REPLACE(REPLACE(COALESCE(GENERATION_EXPRESSION, ''), '`', ''), ' ', ''))
          = 'if((required_capacityisnull),null,schedule_context_id)') = 1
  )
);

SET @ssc_has_slot_unique := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND INDEX_NAME = 'uniq_shift_capacity_slot'
);
SET @ssc_slot_unique_contract_matches := (
  @ssc_has_slot_unique = 0
  OR (
    @ssc_has_slot_unique = 6
    AND (SELECT SUM(CASE
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id' THEN 1
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id' THEN 1
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'sector_id' THEN 1
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'capacity_context_id' THEN 1
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'start_at' THEN 1
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 6 AND COLUMN_NAME = 'end_at' THEN 1
      ELSE 0 END)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'shift_instances'
      AND INDEX_NAME = 'uniq_shift_capacity_slot') = 6
  )
);

SET @ssc_has_shift_check := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND CONSTRAINT_NAME = 'chk_shift_capacity'
);
SET @ssc_shift_check_contract_matches := (
  @ssc_has_shift_check = 0
  OR (
    @ssc_has_shift_check = 1
    AND (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND CONSTRAINT_NAME = 'chk_shift_capacity'
        AND LOWER(CHECK_CLAUSE) LIKE '%required_capacity%is null%'
        AND LOWER(CHECK_CLAUSE) LIKE '%required_capacity%between 1 and 1000%') = 1
  )
);

SET @ssc_rules_table_exists := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_capacity_rules'
);
SET @ssc_rules_columns_contract_matches := (
  @ssc_rules_table_exists = 0
  OR (
    @ssc_rules_table_exists = 1
    AND (SELECT COUNT(*) = 6 AND SUM(CASE
      WHEN COLUMN_NAME = 'id' AND DATA_TYPE = 'int' AND COLUMN_TYPE = 'int'
        AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
        AND LOWER(COALESCE(EXTRA, '')) LIKE '%auto_increment%' THEN 1
      WHEN COLUMN_NAME = 'schedule_context_id' AND DATA_TYPE = 'int'
        AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL THEN 1
      WHEN COLUMN_NAME IN ('start_time', 'end_time') AND DATA_TYPE = 'time'
        AND COLUMN_TYPE = 'time' AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL THEN 1
      WHEN COLUMN_NAME = 'weekday' AND DATA_TYPE = 'tinyint'
        AND COLUMN_TYPE = 'tinyint' AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL THEN 1
      WHEN COLUMN_NAME = 'required_capacity' AND DATA_TYPE = 'int'
        AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL THEN 1
      ELSE 0 END) = 6
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'schedule_capacity_rules')
  )
);
SET @ssc_rules_engine_contract_matches := (
  @ssc_rules_table_exists = 0
  OR (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_capacity_rules'
        AND UPPER(ENGINE) = 'INNODB') = 1
);
SET @ssc_rules_primary_contract_matches := (
  @ssc_rules_table_exists = 0
  OR (SELECT COUNT(*) = 1 AND SUM(CASE
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'id'
      THEN 1 ELSE 0 END) = 1
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'schedule_capacity_rules'
      AND INDEX_NAME = 'PRIMARY')
);
SET @ssc_rules_unique_contract_matches := (
  @ssc_rules_table_exists = 0
  OR (SELECT COUNT(*) = 4 AND SUM(CASE
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'schedule_context_id' THEN 1
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'start_time' THEN 1
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'end_time' THEN 1
      WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'weekday' THEN 1
      ELSE 0 END) = 4
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'schedule_capacity_rules'
      AND INDEX_NAME = 'uniq_schedule_capacity_rule')
);
SET @ssc_rules_fk_contract_matches := (
  @ssc_rules_table_exists = 0
  OR (
    (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_capacity_rules'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1
    AND
    (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_capacity_rules'
       AND CONSTRAINT_NAME = 'fk_capacity_rule_context'
       AND COLUMN_NAME = 'schedule_context_id'
       AND REFERENCED_TABLE_NAME = 'schedule_contexts'
       AND REFERENCED_COLUMN_NAME = 'id') = 1
    AND
    (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_capacity_rules'
       AND CONSTRAINT_NAME = 'fk_capacity_rule_context'
       AND UPDATE_RULE IN ('RESTRICT', 'NO ACTION')
       AND DELETE_RULE IN ('RESTRICT', 'NO ACTION')) = 1
  )
);
SET @ssc_rules_checks_contract_matches := (
  @ssc_rules_table_exists = 0
  OR (
    (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_capacity_rules'
       AND CONSTRAINT_TYPE = 'CHECK') = 2
    AND
    (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND CONSTRAINT_NAME = 'chk_capacity_rule_weekday'
       AND LOWER(CHECK_CLAUSE) LIKE '%weekday%between 0 and 6%') = 1
    AND
    (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND CONSTRAINT_NAME = 'chk_capacity_rule_value'
       AND LOWER(CHECK_CLAUSE) LIKE '%required_capacity%between 1 and 1000%') = 1
  )
);

SET @ssc_preflight_contract_matches := (
  @ssc_base_columns_contract_matches = 1
  AND @ssc_base_tables_contract_matches = 1
  AND @ssc_required_capacity_contract_matches = 1
  AND @ssc_capacity_context_contract_matches = 1
  AND @ssc_slot_unique_contract_matches = 1
  AND @ssc_shift_check_contract_matches = 1
  AND @ssc_rules_columns_contract_matches = 1
  AND @ssc_rules_engine_contract_matches = 1
  AND @ssc_rules_primary_contract_matches = 1
  AND @ssc_rules_unique_contract_matches = 1
  AND @ssc_rules_fk_contract_matches = 1
  AND @ssc_rules_checks_contract_matches = 1
);
SET @ssc_guard_sql := IF(
  @ssc_preflight_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM schedule_shift_capacity_contract_mismatch WHERE 1 = 0'
);
PREPARE ssc_guard_stmt FROM @ssc_guard_sql;
EXECUTE ssc_guard_stmt;
DEALLOCATE PREPARE ssc_guard_stmt;

-- Validate existing prospective rows before creating constraints or defaults.
SET @ssc_capacity_values_valid := 1;
SET @ssc_data_sql := IF(
  @ssc_has_required_capacity = 1,
  'SELECT COUNT(*) = 0 INTO @ssc_capacity_values_valid FROM shift_instances WHERE required_capacity IS NOT NULL AND (required_capacity < 1 OR required_capacity > 1000)',
  'SELECT 1'
);
PREPARE ssc_data_stmt FROM @ssc_data_sql;
EXECUTE ssc_data_stmt;
DEALLOCATE PREPARE ssc_data_stmt;

SET @ssc_slot_values_unique := 1;
SET @ssc_duplicates_sql := IF(
  @ssc_has_required_capacity = 1,
  'SELECT COUNT(*) = 0 INTO @ssc_slot_values_unique FROM (SELECT 1 FROM shift_instances WHERE required_capacity IS NOT NULL GROUP BY institution_id,hospital_id,sector_id,schedule_context_id,start_at,end_at HAVING COUNT(*) > 1) duplicated_capacity_slots',
  'SELECT 1'
);
PREPARE ssc_duplicates_stmt FROM @ssc_duplicates_sql;
EXECUTE ssc_duplicates_stmt;
DEALLOCATE PREPARE ssc_duplicates_stmt;

SET @ssc_data_guard_sql := IF(
  @ssc_capacity_values_valid = 1 AND @ssc_slot_values_unique = 1,
  'SELECT 1',
  'SELECT * FROM schedule_shift_capacity_data_mismatch WHERE 1 = 0'
);
PREPARE ssc_data_guard_stmt FROM @ssc_data_guard_sql;
EXECUTE ssc_data_guard_stmt;
DEALLOCATE PREPARE ssc_data_guard_stmt;

SET @ssc_ddl := IF(
  @ssc_has_required_capacity = 0,
  'ALTER TABLE shift_instances ADD COLUMN required_capacity INT NULL DEFAULT NULL',
  'SELECT 1'
);
PREPARE ssc_stmt FROM @ssc_ddl;
EXECUTE ssc_stmt;
DEALLOCATE PREPARE ssc_stmt;
ALTER TABLE shift_instances ALTER COLUMN required_capacity SET DEFAULT 1;

SET @ssc_ddl := IF(
  @ssc_has_capacity_context = 0,
  'ALTER TABLE shift_instances ADD COLUMN capacity_context_id INT GENERATED ALWAYS AS (IF(required_capacity IS NULL, NULL, schedule_context_id)) STORED',
  'SELECT 1'
);
PREPARE ssc_stmt FROM @ssc_ddl;
EXECUTE ssc_stmt;
DEALLOCATE PREPARE ssc_stmt;

SET @ssc_ddl := IF(
  @ssc_has_slot_unique = 0,
  'ALTER TABLE shift_instances ADD UNIQUE KEY uniq_shift_capacity_slot (institution_id, hospital_id, sector_id, capacity_context_id, start_at, end_at)',
  'SELECT 1'
);
PREPARE ssc_stmt FROM @ssc_ddl;
EXECUTE ssc_stmt;
DEALLOCATE PREPARE ssc_stmt;

SET @ssc_ddl := IF(
  @ssc_has_shift_check = 0,
  'ALTER TABLE shift_instances ADD CONSTRAINT chk_shift_capacity CHECK (required_capacity IS NULL OR required_capacity BETWEEN 1 AND 1000)',
  'SELECT 1'
);
PREPARE ssc_stmt FROM @ssc_ddl;
EXECUTE ssc_stmt;
DEALLOCATE PREPARE ssc_stmt;

CREATE TABLE IF NOT EXISTS schedule_capacity_rules (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  schedule_context_id INT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  weekday TINYINT NOT NULL,
  required_capacity INT NOT NULL,
  CONSTRAINT fk_capacity_rule_context
    FOREIGN KEY (schedule_context_id) REFERENCES schedule_contexts(id),
  UNIQUE KEY uniq_schedule_capacity_rule
    (schedule_context_id, start_time, end_time, weekday),
  CONSTRAINT chk_capacity_rule_weekday CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT chk_capacity_rule_value
    CHECK (required_capacity BETWEEN 1 AND 1000)
) ENGINE=InnoDB;

-- Postflight proves that every object now has the runtime contract.
SET @ssc_post_required_capacity := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'required_capacity'
    AND DATA_TYPE = 'int'
    AND COLUMN_TYPE = 'int'
    AND IS_NULLABLE = 'YES'
    AND COLUMN_DEFAULT IN ('1', 1)
    AND COALESCE(EXTRA, '') = ''
    AND COALESCE(GENERATION_EXPRESSION, '') = ''
);
SET @ssc_post_capacity_context := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'capacity_context_id'
    AND DATA_TYPE = 'int'
    AND COLUMN_TYPE = 'int'
    AND IS_NULLABLE = 'YES'
    AND COLUMN_DEFAULT IS NULL
    AND UPPER(COALESCE(EXTRA, '')) = 'STORED GENERATED'
    AND LOWER(REPLACE(REPLACE(COALESCE(GENERATION_EXPRESSION, ''), '`', ''), ' ', ''))
      = 'if((required_capacityisnull),null,schedule_context_id)'
);
SET @ssc_post_slot_unique := (
  SELECT COUNT(*) = 6 AND SUM(CASE
    WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id' THEN 1
    WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id' THEN 1
    WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'sector_id' THEN 1
    WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'capacity_context_id' THEN 1
    WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'start_at' THEN 1
    WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 6 AND COLUMN_NAME = 'end_at' THEN 1
    ELSE 0 END) = 6
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND INDEX_NAME = 'uniq_shift_capacity_slot'
);
SET @ssc_post_shift_check := (
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shift_instances'
     AND CONSTRAINT_NAME = 'chk_shift_capacity'
     AND CONSTRAINT_TYPE = 'CHECK') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_shift_capacity'
     AND LOWER(CHECK_CLAUSE) LIKE '%required_capacity%is null%'
     AND LOWER(CHECK_CLAUSE) LIKE '%required_capacity%between 1 and 1000%') = 1
);
SET @ssc_post_rules_columns := (
  SELECT COUNT(*) = 6 AND SUM(CASE
    WHEN COLUMN_NAME = 'id' AND DATA_TYPE = 'int' AND COLUMN_TYPE = 'int'
      AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
      AND LOWER(COALESCE(EXTRA, '')) LIKE '%auto_increment%' THEN 1
    WHEN COLUMN_NAME = 'schedule_context_id' AND DATA_TYPE = 'int'
      AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO'
      AND COLUMN_DEFAULT IS NULL THEN 1
    WHEN COLUMN_NAME IN ('start_time', 'end_time') AND DATA_TYPE = 'time'
      AND COLUMN_TYPE = 'time' AND IS_NULLABLE = 'NO'
      AND COLUMN_DEFAULT IS NULL THEN 1
    WHEN COLUMN_NAME = 'weekday' AND DATA_TYPE = 'tinyint'
      AND COLUMN_TYPE = 'tinyint' AND IS_NULLABLE = 'NO'
      AND COLUMN_DEFAULT IS NULL THEN 1
    WHEN COLUMN_NAME = 'required_capacity' AND DATA_TYPE = 'int'
      AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO'
      AND COLUMN_DEFAULT IS NULL THEN 1
    ELSE 0 END) = 6
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_capacity_rules'
);
SET @ssc_post_rules_engine := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_capacity_rules'
    AND UPPER(ENGINE) = 'INNODB'
);
SET @ssc_post_rules_indexes := (
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_capacity_rules'
     AND INDEX_NAME = 'PRIMARY'
     AND NON_UNIQUE = 0
     AND SEQ_IN_INDEX = 1
     AND COLUMN_NAME = 'id') = 1
  AND
  (SELECT COUNT(*) = 4 AND SUM(CASE
     WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'schedule_context_id' THEN 1
     WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'start_time' THEN 1
     WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'end_time' THEN 1
     WHEN NON_UNIQUE = 0 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'weekday' THEN 1
     ELSE 0 END) = 4
   FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_capacity_rules'
     AND INDEX_NAME = 'uniq_schedule_capacity_rule')
);
SET @ssc_post_rules_constraints := (
  (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_capacity_rules'
     AND CONSTRAINT_NAME = 'fk_capacity_rule_context'
     AND COLUMN_NAME = 'schedule_context_id'
     AND REFERENCED_TABLE_NAME = 'schedule_contexts'
     AND REFERENCED_COLUMN_NAME = 'id') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_capacity_rules'
     AND CONSTRAINT_NAME = 'fk_capacity_rule_context'
     AND UPDATE_RULE IN ('RESTRICT', 'NO ACTION')
     AND DELETE_RULE IN ('RESTRICT', 'NO ACTION')) = 1
  AND
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_capacity_rules'
     AND CONSTRAINT_TYPE = 'CHECK') = 2
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_capacity_rule_weekday'
     AND LOWER(CHECK_CLAUSE) LIKE '%weekday%between 0 and 6%') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_capacity_rule_value'
     AND LOWER(CHECK_CLAUSE) LIKE '%required_capacity%between 1 and 1000%') = 1
);
SET @ssc_postflight_contract_matches := (
  @ssc_post_required_capacity = 1
  AND @ssc_post_capacity_context = 1
  AND @ssc_post_slot_unique = 1
  AND @ssc_post_shift_check = 1
  AND @ssc_post_rules_columns = 1
  AND @ssc_post_rules_engine = 1
  AND @ssc_post_rules_indexes = 1
  AND @ssc_post_rules_constraints = 1
);
SET @ssc_postflight_guard_sql := IF(
  @ssc_postflight_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM schedule_shift_capacity_postflight_mismatch WHERE 1 = 0'
);
PREPARE ssc_postflight_guard_stmt FROM @ssc_postflight_guard_sql;
EXECUTE ssc_postflight_guard_stmt;
DEALLOCATE PREPARE ssc_postflight_guard_stmt;
