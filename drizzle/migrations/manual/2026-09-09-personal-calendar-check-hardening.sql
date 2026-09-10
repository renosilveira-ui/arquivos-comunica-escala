-- 2026-09-09 — fecha bypasses de NULL nos CHECKs do calendário pessoal.
--
-- MySQL considera CHECK satisfeito quando a expressão resulta TRUE ou UNKNOWN.
-- As versões iniciais de cinco regras usavam comparações com colunas nullable
-- sem exigir IS NOT NULL; pares parciais e recorrências incompletas podiam,
-- portanto, ser aceitos como UNKNOWN. Esta migration não corrige nem apaga
-- dados: ela falha antes do DDL caso encontre uma linha incompatível.

SET @pc_check_tables_match := (
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'personal_calendar_items'
     AND UPPER(ENGINE) = 'INNODB') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'personal_calendar_recurrences'
     AND UPPER(ENGINE) = 'INNODB') = 1
);

SET @pc_check_constraints_match := (
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'personal_calendar_items'
     AND CONSTRAINT_TYPE = 'CHECK'
     AND CONSTRAINT_NAME IN (
       'chk_pc_item_location',
       'chk_pc_item_location_binding',
       'chk_pc_item_shape'
     )) = 3
  AND
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'personal_calendar_recurrences'
     AND CONSTRAINT_TYPE = 'CHECK'
     AND CONSTRAINT_NAME IN (
       'chk_pc_recurrence_weekdays',
       'chk_pc_recurrence_termination'
     )) = 2
);

SET @pc_check_invalid_item_rows := (
  SELECT COUNT(*)
  FROM personal_calendar_items
  WHERE (latitude IS NULL) <> (longitude IS NULL)
    OR (location_provider IS NULL) <> (location_external_id IS NULL)
    OR (
      kind = 'BIRTHDAY'
      AND (birthday_month IS NULL OR birthday_day IS NULL)
    )
);

SET @pc_check_invalid_recurrence_rows := (
  SELECT COUNT(*)
  FROM personal_calendar_recurrences
  WHERE (frequency = 'WEEKLY' AND weekdays_mask IS NULL)
    OR (termination = 'COUNT' AND occurrence_count IS NULL)
);

SET @pc_check_preflight_matches := (
  @pc_check_tables_match = 1
  AND @pc_check_constraints_match = 1
  AND @pc_check_invalid_item_rows = 0
  AND @pc_check_invalid_recurrence_rows = 0
);

SET @pc_check_guard_sql := IF(
  @pc_check_preflight_matches = 1,
  'SELECT 1',
  'SELECT * FROM personal_calendar_check_hardening_preflight_failed WHERE 1 = 0'
);
PREPARE pc_check_guard_stmt FROM @pc_check_guard_sql;
EXECUTE pc_check_guard_stmt;
DEALLOCATE PREPARE pc_check_guard_stmt;

SET @pc_item_checks_hardened := (
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_item_location'
     AND LOWER(CHECK_CLAUSE) LIKE '%latitude%is not null%'
     AND LOWER(CHECK_CLAUSE) LIKE '%longitude%is not null%') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_item_location_binding'
     AND LOWER(CHECK_CLAUSE) LIKE '%location_provider%is not null%'
     AND LOWER(CHECK_CLAUSE) LIKE '%location_external_id%is not null%') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_item_shape'
     AND LOWER(CHECK_CLAUSE) LIKE '%birthday_month%is not null%'
     AND LOWER(CHECK_CLAUSE) LIKE '%birthday_day%is not null%') = 1
);

SET @pc_item_check_ddl := IF(
  @pc_item_checks_hardened = 1,
  'SELECT 1',
  'ALTER TABLE personal_calendar_items
    DROP CHECK chk_pc_item_location,
    DROP CHECK chk_pc_item_location_binding,
    DROP CHECK chk_pc_item_shape,
    ADD CONSTRAINT chk_pc_item_location CHECK (
      (latitude IS NULL AND longitude IS NULL)
      OR (
        latitude IS NOT NULL AND longitude IS NOT NULL
        AND latitude BETWEEN -90 AND 90
        AND longitude BETWEEN -180 AND 180
      )
    ),
    ADD CONSTRAINT chk_pc_item_location_binding CHECK (
      (location_provider IS NULL AND location_external_id IS NULL)
      OR (
        location_provider IS NOT NULL AND location_external_id IS NOT NULL
        AND CHAR_LENGTH(TRIM(location_provider)) BETWEEN 1 AND 32
        AND CHAR_LENGTH(TRIM(location_external_id)) BETWEEN 1 AND 191
      )
    ),
    ADD CONSTRAINT chk_pc_item_shape CHECK (
      (
        kind = ''APPOINTMENT''
        AND start_local_date IS NOT NULL
        AND end_local_date IS NOT NULL
        AND birthday_month IS NULL
        AND birthday_day IS NULL
        AND birthday_year IS NULL
        AND (
          (
            all_day = 1
            AND start_local_time IS NULL
            AND end_local_time IS NULL
            AND end_local_date > start_local_date
          )
          OR
          (
            all_day = 0
            AND start_local_time IS NOT NULL
            AND end_local_time IS NOT NULL
            AND TIMESTAMP(end_local_date, end_local_time)
              > TIMESTAMP(start_local_date, start_local_time)
          )
        )
      )
      OR
      (
        kind = ''REMINDER''
        AND start_local_date IS NOT NULL
        AND end_local_date IS NULL
        AND end_local_time IS NULL
        AND birthday_month IS NULL
        AND birthday_day IS NULL
        AND birthday_year IS NULL
        AND (
          (all_day = 1 AND start_local_time IS NULL)
          OR
          (all_day = 0 AND start_local_time IS NOT NULL)
        )
      )
      OR
      (
        kind = ''BIRTHDAY''
        AND all_day = 1
        AND start_local_date IS NULL
        AND start_local_time IS NULL
        AND end_local_date IS NULL
        AND end_local_time IS NULL
        AND birthday_month IS NOT NULL
        AND birthday_day IS NOT NULL
        AND birthday_month BETWEEN 1 AND 12
        AND birthday_day BETWEEN 1 AND
          CASE birthday_month
            WHEN 2 THEN 29
            WHEN 4 THEN 30
            WHEN 6 THEN 30
            WHEN 9 THEN 30
            WHEN 11 THEN 30
            ELSE 31
          END
        AND (birthday_year IS NULL OR birthday_year BETWEEN 1800 AND 2200)
      )
    )'
);
PREPARE pc_item_check_stmt FROM @pc_item_check_ddl;
EXECUTE pc_item_check_stmt;
DEALLOCATE PREPARE pc_item_check_stmt;

SET @pc_recurrence_checks_hardened := (
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_recurrence_weekdays'
     AND LOWER(CHECK_CLAUSE) LIKE '%weekdays_mask%is not null%') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_recurrence_termination'
     AND LOWER(CHECK_CLAUSE) LIKE '%occurrence_count%is not null%') = 1
);

SET @pc_recurrence_check_ddl := IF(
  @pc_recurrence_checks_hardened = 1,
  'SELECT 1',
  'ALTER TABLE personal_calendar_recurrences
    DROP CHECK chk_pc_recurrence_weekdays,
    DROP CHECK chk_pc_recurrence_termination,
    ADD CONSTRAINT chk_pc_recurrence_weekdays CHECK (
      (
        frequency = ''WEEKLY''
        AND weekdays_mask IS NOT NULL
        AND weekdays_mask BETWEEN 1 AND 127
      )
      OR
      (frequency <> ''WEEKLY'' AND weekdays_mask IS NULL)
    ),
    ADD CONSTRAINT chk_pc_recurrence_termination CHECK (
      (
        termination = ''NEVER''
        AND until_local_date IS NULL
        AND occurrence_count IS NULL
      )
      OR
      (
        termination = ''UNTIL''
        AND until_local_date IS NOT NULL
        AND occurrence_count IS NULL
      )
      OR
      (
        termination = ''COUNT''
        AND until_local_date IS NULL
        AND occurrence_count IS NOT NULL
        AND occurrence_count BETWEEN 1 AND 10000
      )
    )'
);
PREPARE pc_recurrence_check_stmt FROM @pc_recurrence_check_ddl;
EXECUTE pc_recurrence_check_stmt;
DEALLOCATE PREPARE pc_recurrence_check_stmt;

SET @pc_check_postflight_matches := (
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_item_location'
     AND LOWER(CHECK_CLAUSE) LIKE '%latitude%is not null%'
     AND LOWER(CHECK_CLAUSE) LIKE '%longitude%is not null%') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_item_location_binding'
     AND LOWER(CHECK_CLAUSE) LIKE '%location_provider%is not null%'
     AND LOWER(CHECK_CLAUSE) LIKE '%location_external_id%is not null%') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_item_shape'
     AND LOWER(CHECK_CLAUSE) LIKE '%birthday_month%is not null%'
     AND LOWER(CHECK_CLAUSE) LIKE '%birthday_day%is not null%') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_recurrence_weekdays'
     AND LOWER(CHECK_CLAUSE) LIKE '%weekdays_mask%is not null%') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND CONSTRAINT_NAME = 'chk_pc_recurrence_termination'
     AND LOWER(CHECK_CLAUSE) LIKE '%occurrence_count%is not null%') = 1
);

SET @pc_check_postflight_sql := IF(
  @pc_check_postflight_matches = 1,
  'SELECT 1',
  'SELECT * FROM personal_calendar_check_hardening_postflight_failed WHERE 1 = 0'
);
PREPARE pc_check_postflight_stmt FROM @pc_check_postflight_sql;
EXECUTE pc_check_postflight_stmt;
DEALLOCATE PREPARE pc_check_postflight_stmt;
