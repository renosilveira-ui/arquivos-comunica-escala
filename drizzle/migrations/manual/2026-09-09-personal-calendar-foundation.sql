-- 2026-09-09 — fundação account-wide da Agenda de Compromissos.
--
-- Somente estrutura. Esta migration NÃO ativa CRUD, recorrência, notificações,
-- WeatherKit, feriados, Google Calendar nem qualquer writer.
--
-- Autoridade: owner_user_id vem da sessão. Não existe institution_id,
-- professional_id, hospital_id ou sector_id neste domínio privado.
--
-- Reaplicação é segura. Um estado parcial ou uma tabela homônima incompatível
-- falha fechado antes de criar qualquer outra tabela.

SET @pc_contract_previous_group_concat_max_len := @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 65535;

CREATE TEMPORARY TABLE _personal_calendar_contract_expected (
  table_name VARCHAR(64) NOT NULL,
  contract_hash CHAR(64) NOT NULL,
  PRIMARY KEY (table_name)
) ENGINE=MEMORY;

INSERT INTO _personal_calendar_contract_expected (table_name, contract_hash) VALUES
  ('personal_calendar_alert_rules', '44d17140775069cad145849f6888e21ef158b981e41e3386f2769f14623eafb8'),
  ('personal_calendar_items', '9ed5c39b35e26d6cbd9253f481c8f85528dfd85fb720663360ec64774a31cd05'),
  ('personal_calendar_occurrence_exceptions', '227d19c08817e2578cd08588121ff344729fbfd643d57cd1a8c45ff2f890a41f'),
  ('personal_calendar_occurrences', '53d7cbc2c2c1ecc66aca3598632a4ec84bd1e77226d22f4b911072da81a36955'),
  ('personal_calendar_recurrences', '378d2d203c9c37dd3c424fcad13d7bbabe063aeb5f1387a4a445b9a22dc11fa5');

SET @pc_expected_table_count := 5;
SET @pc_existing_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE = 'BASE TABLE'
    AND TABLE_NAME IN (
      'personal_calendar_items',
      'personal_calendar_alert_rules',
      'personal_calendar_recurrences',
      'personal_calendar_occurrences',
      'personal_calendar_occurrence_exceptions'
    )
);

SET @ddl := IF(
  @pc_existing_table_count IN (0, @pc_expected_table_count),
  'SELECT 1',
  'SELECT JSON_EXTRACT(''PERSONAL_CALENDAR_PARTIAL_SCHEMA'', ''$'')'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS personal_calendar_items (
  id INT NOT NULL AUTO_INCREMENT,
  owner_user_id INT NOT NULL,
  client_mutation_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  kind ENUM('APPOINTMENT','REMINDER','BIRTHDAY') NOT NULL,
  title VARCHAR(160) NOT NULL,
  location_label VARCHAR(255) NULL,
  location_provider VARCHAR(32) NULL,
  location_external_id VARCHAR(191) NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  notes TEXT NULL,
  start_local_date DATE NULL,
  start_local_time TIME NULL,
  end_local_date DATE NULL,
  end_local_time TIME NULL,
  birthday_month TINYINT UNSIGNED NULL,
  birthday_day TINYINT UNSIGNED NULL,
  birthday_year INT NULL,
  all_day TINYINT(1) NOT NULL DEFAULT 0,
  availability VARCHAR(4) NOT NULL,
  time_zone VARCHAR(64) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  deleted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_pc_item_owner_mutation (owner_user_id, client_mutation_id),
  UNIQUE KEY uniq_pc_item_id_owner (id, owner_user_id),
  KEY idx_pc_item_owner_range (owner_user_id, deleted_at, start_local_date, id),
  CONSTRAINT fk_pc_item_owner FOREIGN KEY (owner_user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_pc_item_title
    CHECK (CHAR_LENGTH(TRIM(title)) BETWEEN 1 AND 160),
  CONSTRAINT chk_pc_item_mutation_id
    CHECK (CHAR_LENGTH(client_mutation_id) BETWEEN 1 AND 64),
  CONSTRAINT chk_pc_item_timezone
    CHECK (CHAR_LENGTH(TRIM(time_zone)) BETWEEN 1 AND 64),
  CONSTRAINT chk_pc_item_location CHECK (
    (latitude IS NULL AND longitude IS NULL)
    OR
    (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
  ),
  CONSTRAINT chk_pc_item_location_binding CHECK (
    (location_provider IS NULL AND location_external_id IS NULL)
    OR
    (
      CHAR_LENGTH(TRIM(location_provider)) BETWEEN 1 AND 32
      AND CHAR_LENGTH(TRIM(location_external_id)) BETWEEN 1 AND 191
    )
  ),
  CONSTRAINT chk_pc_item_availability
    CHECK (
      availability IN ('BUSY','FREE')
      AND (kind = 'APPOINTMENT' OR availability = 'FREE')
    ),
  CONSTRAINT chk_pc_item_version CHECK (version >= 1),
  CONSTRAINT chk_pc_item_shape CHECK (
    (
      kind = 'APPOINTMENT'
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
      kind = 'REMINDER'
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
      kind = 'BIRTHDAY'
      AND all_day = 1
      AND start_local_date IS NULL
      AND start_local_time IS NULL
      AND end_local_date IS NULL
      AND end_local_time IS NULL
      AND birthday_month BETWEEN 1 AND 12
      AND birthday_day BETWEEN 1 AND CASE birthday_month
        WHEN 2 THEN 29
        WHEN 4 THEN 30
        WHEN 6 THEN 30
        WHEN 9 THEN 30
        WHEN 11 THEN 30
        ELSE 31
      END
      AND (birthday_year IS NULL OR birthday_year BETWEEN 1800 AND 2200)
    )
  )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_calendar_alert_rules (
  id INT NOT NULL AUTO_INCREMENT,
  item_id INT NOT NULL,
  owner_user_id INT NOT NULL,
  minutes_before INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_pc_alert_item_offset (item_id, minutes_before),
  KEY idx_pc_alert_owner (owner_user_id, item_id),
  CONSTRAINT fk_pc_alert_item_owner FOREIGN KEY (item_id, owner_user_id)
    REFERENCES personal_calendar_items (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT chk_pc_alert_offset CHECK (minutes_before BETWEEN 0 AND 525600)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_calendar_recurrences (
  id INT NOT NULL AUTO_INCREMENT,
  item_id INT NOT NULL,
  owner_user_id INT NOT NULL,
  frequency ENUM('DAILY','WEEKLY','MONTHLY','YEARLY') NOT NULL,
  interval_count INT NOT NULL DEFAULT 1,
  weekdays_mask TINYINT UNSIGNED NULL,
  invalid_date_policy ENUM('SKIP','CLAMP_LAST_DAY') NOT NULL DEFAULT 'SKIP',
  termination ENUM('NEVER','UNTIL','COUNT') NOT NULL DEFAULT 'NEVER',
  until_local_date DATE NULL,
  occurrence_count INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_pc_recurrence_item (item_id),
  KEY idx_pc_recurrence_owner (owner_user_id, item_id),
  CONSTRAINT fk_pc_recurrence_item_owner FOREIGN KEY (item_id, owner_user_id)
    REFERENCES personal_calendar_items (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT chk_pc_recurrence_interval
    CHECK (interval_count BETWEEN 1 AND 100),
  CONSTRAINT chk_pc_recurrence_weekdays CHECK (
    (frequency = 'WEEKLY' AND weekdays_mask BETWEEN 1 AND 127)
    OR
    (frequency <> 'WEEKLY' AND weekdays_mask IS NULL)
  ),
  CONSTRAINT chk_pc_recurrence_termination CHECK (
    (
      termination = 'NEVER'
      AND until_local_date IS NULL
      AND occurrence_count IS NULL
    )
    OR
    (
      termination = 'UNTIL'
      AND until_local_date IS NOT NULL
      AND occurrence_count IS NULL
    )
    OR
    (
      termination = 'COUNT'
      AND until_local_date IS NULL
      AND occurrence_count BETWEEN 1 AND 10000
    )
  )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_calendar_occurrences (
  id INT NOT NULL AUTO_INCREMENT,
  item_id INT NOT NULL,
  owner_user_id INT NOT NULL,
  occurrence_key VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  original_local_date DATE NOT NULL,
  original_local_time TIME NULL,
  starts_at_utc DATETIME NOT NULL,
  ends_at_utc DATETIME NOT NULL,
  state ENUM('ACTIVE','CANCELLED','REPLACED') NOT NULL DEFAULT 'ACTIVE',
  source_version INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_pc_occurrence_item_key (item_id, occurrence_key),
  KEY idx_pc_occurrence_owner_range
    (owner_user_id, state, starts_at_utc, ends_at_utc),
  CONSTRAINT fk_pc_occurrence_item_owner FOREIGN KEY (item_id, owner_user_id)
    REFERENCES personal_calendar_items (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT chk_pc_occurrence_key
    CHECK (CHAR_LENGTH(occurrence_key) BETWEEN 1 AND 64),
  CONSTRAINT chk_pc_occurrence_range CHECK (ends_at_utc > starts_at_utc),
  CONSTRAINT chk_pc_occurrence_version CHECK (source_version >= 1)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS personal_calendar_occurrence_exceptions (
  id INT NOT NULL AUTO_INCREMENT,
  series_item_id INT NOT NULL,
  owner_user_id INT NOT NULL,
  occurrence_key VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  action ENUM('CANCELLED','REPLACED') NOT NULL,
  replacement_item_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_pc_exception_series_key (series_item_id, occurrence_key),
  KEY idx_pc_exception_replacement (owner_user_id, replacement_item_id),
  CONSTRAINT fk_pc_exception_series_owner
    FOREIGN KEY (series_item_id, owner_user_id)
    REFERENCES personal_calendar_items (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT fk_pc_exception_replacement_owner
    FOREIGN KEY (replacement_item_id, owner_user_id)
    REFERENCES personal_calendar_items (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT chk_pc_exception_key
    CHECK (CHAR_LENGTH(occurrence_key) BETWEEN 1 AND 64),
  CONSTRAINT chk_pc_exception_action CHECK (
    (action = 'CANCELLED' AND replacement_item_id IS NULL)
    OR
    (
      action = 'REPLACED'
      AND replacement_item_id IS NOT NULL
      AND replacement_item_id <> series_item_id
    )
  )
) ENGINE=InnoDB;

-- Fingerprint exato do contrato instalado/reaplicado. Ele cobre engine,
-- colunas ordenadas, índices, FKs com ações e cláusulas CHECK normalizadas.
SET @pc_contract_postflight_mismatches := (
  SELECT COUNT(*)
  FROM _personal_calendar_contract_expected AS expected_contract
  LEFT JOIN (
    SELECT
      tables.TABLE_NAME AS table_name,
      SHA2(
        CONCAT_WS(
          '|',
          tables.TABLE_TYPE,
          COALESCE(tables.ENGINE, ''),
          CASE
            WHEN tables.TABLE_COLLATION = (
              SELECT schema_defaults.DEFAULT_COLLATION_NAME
              FROM INFORMATION_SCHEMA.SCHEMATA AS schema_defaults
              WHERE schema_defaults.SCHEMA_NAME = tables.TABLE_SCHEMA
            ) THEN '<DATABASE_DEFAULT>'
            ELSE COALESCE(tables.TABLE_COLLATION, '<NULL>')
          END,
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                columns.ORDINAL_POSITION,
                columns.COLUMN_NAME,
                LOWER(columns.COLUMN_TYPE),
                columns.IS_NULLABLE,
                CASE
                  WHEN UPPER(COALESCE(columns.COLUMN_DEFAULT, '')) IN ('NOW()', 'CURRENT_TIMESTAMP()') THEN 'CURRENT_TIMESTAMP'
                  ELSE COALESCE(UPPER(columns.COLUMN_DEFAULT), '<NULL>')
                END,
                LOWER(COALESCE(columns.EXTRA, '')),
                CASE
                  WHEN columns.CHARACTER_SET_NAME IS NULL THEN '<NULL>'
                  WHEN columns.COLLATION_NAME = tables.TABLE_COLLATION THEN '<TABLE_DEFAULT>'
                  ELSE CONCAT(columns.CHARACTER_SET_NAME, '/', columns.COLLATION_NAME)
                END,
                COALESCE(columns.GENERATION_EXPRESSION, '')
              )
              ORDER BY columns.ORDINAL_POSITION
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.COLUMNS AS columns
            WHERE columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
              AND columns.TABLE_NAME = tables.TABLE_NAME
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                indexes.INDEX_NAME,
                indexes.NON_UNIQUE,
                indexes.SEQ_IN_INDEX,
                indexes.COLUMN_NAME,
                COALESCE(indexes.COLLATION, '<NULL>'),
                COALESCE(indexes.SUB_PART, '<NULL>'),
                indexes.INDEX_TYPE,
                COALESCE(indexes.IS_VISIBLE, '<NULL>')
              )
              ORDER BY indexes.INDEX_NAME, indexes.SEQ_IN_INDEX
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.STATISTICS AS indexes
            WHERE indexes.TABLE_SCHEMA = tables.TABLE_SCHEMA
              AND indexes.TABLE_NAME = tables.TABLE_NAME
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                key_columns.CONSTRAINT_NAME,
                key_columns.ORDINAL_POSITION,
                key_columns.COLUMN_NAME,
                CASE
                  WHEN key_columns.REFERENCED_TABLE_SCHEMA = tables.TABLE_SCHEMA THEN '<CURRENT_SCHEMA>'
                  ELSE key_columns.REFERENCED_TABLE_SCHEMA
                END,
                key_columns.REFERENCED_TABLE_NAME,
                key_columns.REFERENCED_COLUMN_NAME,
                referential_constraints.MATCH_OPTION,
                referential_constraints.UPDATE_RULE,
                referential_constraints.DELETE_RULE
              )
              ORDER BY key_columns.CONSTRAINT_NAME, key_columns.ORDINAL_POSITION
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS key_columns
            INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS referential_constraints
              ON referential_constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
              AND referential_constraints.TABLE_NAME = key_columns.TABLE_NAME
              AND referential_constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
            WHERE key_columns.CONSTRAINT_SCHEMA = tables.TABLE_SCHEMA
              AND key_columns.TABLE_NAME = tables.TABLE_NAME
              AND key_columns.REFERENCED_TABLE_NAME IS NOT NULL
          ), ''),
          COALESCE((
            SELECT GROUP_CONCAT(
              CONCAT_WS(
                ':',
                table_constraints.CONSTRAINT_NAME,
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(
                        REPLACE(UPPER(check_constraints.CHECK_CLAUSE), CHAR(96), ''),
                        '_UTF8MB4',
                        ''
                      ),
                      ' ',
                      ''
                    ),
                    CHAR(10),
                    ''
                  ),
                  CHAR(13),
                  ''
                )
              )
              ORDER BY table_constraints.CONSTRAINT_NAME
              SEPARATOR '|'
            )
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS table_constraints
            INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS check_constraints
              ON check_constraints.CONSTRAINT_SCHEMA = table_constraints.CONSTRAINT_SCHEMA
              AND check_constraints.CONSTRAINT_NAME = table_constraints.CONSTRAINT_NAME
            WHERE table_constraints.CONSTRAINT_SCHEMA = tables.TABLE_SCHEMA
              AND table_constraints.TABLE_NAME = tables.TABLE_NAME
              AND table_constraints.CONSTRAINT_TYPE = 'CHECK'
          ), '')
        ),
        256
      ) AS contract_hash
    FROM INFORMATION_SCHEMA.TABLES AS tables
    WHERE tables.TABLE_SCHEMA = DATABASE()
      AND tables.TABLE_NAME IN (
        'personal_calendar_alert_rules',
        'personal_calendar_items',
        'personal_calendar_occurrence_exceptions',
        'personal_calendar_occurrences',
        'personal_calendar_recurrences'
      )
  ) AS actual_contract
    ON actual_contract.table_name = expected_contract.table_name
  WHERE actual_contract.table_name IS NULL
    OR actual_contract.contract_hash <> expected_contract.contract_hash
);

SET @ddl := IF(
  @pc_contract_postflight_mismatches = 0,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''PERSONAL_CALENDAR_SCHEMA_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @pc_restore_group_concat_sql := CONCAT(
  'SET SESSION group_concat_max_len = ',
  @pc_contract_previous_group_concat_max_len
);
PREPARE stmt FROM @pc_restore_group_concat_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

DROP TEMPORARY TABLE _personal_calendar_contract_expected;
