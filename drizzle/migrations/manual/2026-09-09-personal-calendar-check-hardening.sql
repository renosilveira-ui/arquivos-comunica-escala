-- 2026-09-09 — fecha bypasses de NULL nos CHECKs do calendário pessoal.
-- MySQL aceita TRUE ou UNKNOWN em CHECK. O contrato exige TRUE nos cinco
-- invariantes, sem corrigir/apagar dados existentes. Nomes/tabelas ausentes e
-- linhas incompatíveis abortam antes de qualquer DDL.
--
-- Cada hash fixa TODO o CHECK_CLAUSE serializado pelo MySQL 8/utf8mb4:
-- agrupamentos, operadores e literais são preservados, sem LIKE ou remoção
-- de parênteses. Serialização desconhecida falha fechada no postflight.
-- CHECK divergente, parcial ou NOT ENFORCED é reinstalado após o preflight;
-- apenas contrato integralmente igual e ENFORCED permite o no-op do rerun.

SET @pc_item_location_expression := '(latitude IS NULL AND longitude IS NULL)
      OR (
        latitude IS NOT NULL AND longitude IS NOT NULL
        AND latitude BETWEEN -90 AND 90
        AND longitude BETWEEN -180 AND 180
      )';
SET @pc_item_location_hash := 'a239ce6e4c45bf09f114680b1613f896f4daa47c09d5d87ce699bc7cbff6e035';

SET @pc_item_location_binding_expression := '(location_provider IS NULL AND location_external_id IS NULL)
      OR (
        location_provider IS NOT NULL AND location_external_id IS NOT NULL
        AND CHAR_LENGTH(TRIM(location_provider)) BETWEEN 1 AND 32
        AND CHAR_LENGTH(TRIM(location_external_id)) BETWEEN 1 AND 191
      )';
SET @pc_item_location_binding_hash := '14c5f5c368be2307644859a654b024051d277460fb74daed522d514a6b41e428';

SET @pc_item_shape_expression := '(
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
      )';
SET @pc_item_shape_hash := 'c18b09d3ece929f1ba6e2a49f87336f86d92117eea6a33a07226e8e17c4d39c6';

SET @pc_recurrence_termination_expression := '(
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
      )';
SET @pc_recurrence_termination_hash := 'a1a1e7eb573714242ae54a0f3d7d1f2843f168a14b32c00b02bec8a5912d506a';

SET @pc_recurrence_weekdays_expression := '(
        frequency = ''WEEKLY''
        AND weekdays_mask IS NOT NULL
        AND weekdays_mask BETWEEN 1 AND 127
      )
      OR
      (frequency <> ''WEEKLY'' AND weekdays_mask IS NULL)';
SET @pc_recurrence_weekdays_hash := 'ba05bc5c8081dec382148e370c1ae611a0f5edfc18fe152337ee3e53794e1487';

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

SET @pc_target_sql := IF(
  @pc_check_tables_match = 1 AND @pc_check_constraints_match = 1,
  'SELECT 1',
  'SELECT * FROM personal_calendar_check_hardening_preflight_failed WHERE 1 = 0'
);
PREPARE pc_target_stmt FROM @pc_target_sql;
EXECUTE pc_target_stmt;
DEALLOCATE PREPARE pc_target_stmt;

SET @pc_catalog_sql := 'SELECT
  COALESCE(SUM(CASE WHEN
      (tc.TABLE_NAME = ''personal_calendar_items''
        AND tc.CONSTRAINT_NAME = ''chk_pc_item_location''
        AND tc.ENFORCED = ''YES''
        AND SHA2(cc.CHECK_CLAUSE, 256) = @pc_item_location_hash)
      OR (tc.TABLE_NAME = ''personal_calendar_items''
        AND tc.CONSTRAINT_NAME = ''chk_pc_item_location_binding''
        AND tc.ENFORCED = ''YES''
        AND SHA2(cc.CHECK_CLAUSE, 256) = @pc_item_location_binding_hash)
      OR (tc.TABLE_NAME = ''personal_calendar_items''
        AND tc.CONSTRAINT_NAME = ''chk_pc_item_shape''
        AND tc.ENFORCED = ''YES''
        AND SHA2(cc.CHECK_CLAUSE, 256) = @pc_item_shape_hash)
    THEN 1 ELSE 0 END), 0) = 3,
  COALESCE(SUM(CASE WHEN
      (tc.TABLE_NAME = ''personal_calendar_recurrences''
        AND tc.CONSTRAINT_NAME = ''chk_pc_recurrence_termination''
        AND tc.ENFORCED = ''YES''
        AND SHA2(cc.CHECK_CLAUSE, 256) = @pc_recurrence_termination_hash)
      OR (tc.TABLE_NAME = ''personal_calendar_recurrences''
        AND tc.CONSTRAINT_NAME = ''chk_pc_recurrence_weekdays''
        AND tc.ENFORCED = ''YES''
        AND SHA2(cc.CHECK_CLAUSE, 256) = @pc_recurrence_weekdays_hash)
    THEN 1 ELSE 0 END), 0) = 2
INTO @pc_item_checks_hardened, @pc_recurrence_checks_hardened
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.CHECK_CONSTRAINTS cc
  ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
  AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
  AND tc.CONSTRAINT_TYPE = ''CHECK''
  AND tc.TABLE_NAME IN (''personal_calendar_items'', ''personal_calendar_recurrences'')';
PREPARE pc_catalog_stmt FROM @pc_catalog_sql;
EXECUTE pc_catalog_stmt;
DEALLOCATE PREPARE pc_catalog_stmt;

SET @pc_item_rows_sql := CONCAT(
  'SELECT COUNT(*) INTO @pc_invalid_item_rows FROM personal_calendar_items WHERE ((',
  @pc_item_location_expression, ') AND (',
  @pc_item_location_binding_expression, ') AND (',
  @pc_item_shape_expression,
  ')) IS NOT TRUE'
);
PREPARE pc_item_rows_stmt FROM @pc_item_rows_sql;
EXECUTE pc_item_rows_stmt;
DEALLOCATE PREPARE pc_item_rows_stmt;

SET @pc_recurrence_rows_sql := CONCAT(
  'SELECT COUNT(*) INTO @pc_invalid_recurrence_rows FROM personal_calendar_recurrences WHERE ((',
  @pc_recurrence_termination_expression, ') AND (',
  @pc_recurrence_weekdays_expression,
  ')) IS NOT TRUE'
);
PREPARE pc_recurrence_rows_stmt FROM @pc_recurrence_rows_sql;
EXECUTE pc_recurrence_rows_stmt;
DEALLOCATE PREPARE pc_recurrence_rows_stmt;

SET @pc_preflight_sql := IF(
  @pc_invalid_item_rows = 0 AND @pc_invalid_recurrence_rows = 0,
  'SELECT 1',
  'SELECT * FROM personal_calendar_check_hardening_preflight_failed WHERE 1 = 0'
);
PREPARE pc_preflight_stmt FROM @pc_preflight_sql;
EXECUTE pc_preflight_stmt;
DEALLOCATE PREPARE pc_preflight_stmt;

SET @pc_item_ddl := IF(
  @pc_item_checks_hardened = 1,
  'SELECT 1',
  CONCAT(
    'ALTER TABLE personal_calendar_items DROP CHECK chk_pc_item_location, DROP CHECK chk_pc_item_location_binding, DROP CHECK chk_pc_item_shape, ',
    'ADD CONSTRAINT chk_pc_item_location CHECK (', @pc_item_location_expression, ') ENFORCED', ', ',
    'ADD CONSTRAINT chk_pc_item_location_binding CHECK (', @pc_item_location_binding_expression, ') ENFORCED', ', ',
    'ADD CONSTRAINT chk_pc_item_shape CHECK (', @pc_item_shape_expression, ') ENFORCED'
  )
);
PREPARE pc_item_ddl_stmt FROM @pc_item_ddl;
EXECUTE pc_item_ddl_stmt;
DEALLOCATE PREPARE pc_item_ddl_stmt;

SET @pc_recurrence_ddl := IF(
  @pc_recurrence_checks_hardened = 1,
  'SELECT 1',
  CONCAT(
    'ALTER TABLE personal_calendar_recurrences DROP CHECK chk_pc_recurrence_termination, DROP CHECK chk_pc_recurrence_weekdays, ',
    'ADD CONSTRAINT chk_pc_recurrence_termination CHECK (', @pc_recurrence_termination_expression, ') ENFORCED', ', ',
    'ADD CONSTRAINT chk_pc_recurrence_weekdays CHECK (', @pc_recurrence_weekdays_expression, ') ENFORCED'
  )
);
PREPARE pc_recurrence_ddl_stmt FROM @pc_recurrence_ddl;
EXECUTE pc_recurrence_ddl_stmt;
DEALLOCATE PREPARE pc_recurrence_ddl_stmt;

PREPARE pc_catalog_stmt FROM @pc_catalog_sql;
EXECUTE pc_catalog_stmt;
DEALLOCATE PREPARE pc_catalog_stmt;

SET @pc_postflight_sql := IF(
  @pc_item_checks_hardened = 1 AND @pc_recurrence_checks_hardened = 1,
  'SELECT 1',
  'SELECT * FROM personal_calendar_check_hardening_postflight_failed WHERE 1 = 0'
);
PREPARE pc_postflight_stmt FROM @pc_postflight_sql;
EXECUTE pc_postflight_stmt;
DEALLOCATE PREPARE pc_postflight_stmt;
