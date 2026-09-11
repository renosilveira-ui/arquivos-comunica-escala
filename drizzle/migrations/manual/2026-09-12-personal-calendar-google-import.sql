-- 2026-09-12 — importação do Google Agenda para a Agenda de Compromissos.
--
-- Depende de 2026-09-09-personal-calendar-foundation.sql (personal_calendar_items)
-- e de 2026-09-10-external-integrations-foundation.sql (user_external_credentials).
--
-- Duas tabelas NOVAS, de propósito. A fundação da agenda confere um hash
-- estrutural das suas cinco tabelas toda vez que roda: acrescentar colunas em
-- personal_calendar_items faria aquela migração passar a recusar. A
-- procedência do Google vive ao lado, ligada por FK — o mesmo padrão que a
-- exportação já usa (external_calendar_event_links).
--
-- Somente estrutura. Não importa nada: sem vínculo Google, nenhuma linha.
--
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela inexistente —
-- o MySQL ecoa o nome e quem aplica lê qual guarda disparou.

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------

SET @pci_expected_table_count := 2;
SET @pci_existing_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE = 'BASE TABLE'
    AND TABLE_NAME IN ('personal_calendar_external_links', 'personal_calendar_import_cursors')
);

SET @ddl := IF(
  @pci_existing_table_count IN (0, @pci_expected_table_count),
  'SELECT 1',
  'SELECT 1 FROM `__personal_calendar_import_partial_schema__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME IN ('users', 'personal_calendar_items', 'user_external_credentials')
  ) = 3,
  'SELECT 1',
  'SELECT 1 FROM `__personal_calendar_import_foundation_missing__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 1. Procedência: qual evento do Google originou qual compromisso
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS personal_calendar_external_links (
  id INT NOT NULL AUTO_INCREMENT,
  owner_user_id INT NOT NULL,
  item_id INT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  external_calendar_id VARCHAR(255) NOT NULL,
  external_event_id VARCHAR(255) NOT NULL,
  -- Controle de concorrência do provedor: só reimporta o que mudou.
  external_etag VARCHAR(255) NULL,
  imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Evento cancelado no Google: o compromisso some do app, o vínculo fica
  -- para que uma recriação lá não vire duplicata aqui.
  deleted_at TIMESTAMP NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Um evento do Google origina no máximo um compromisso por conta.
  UNIQUE KEY uniq_pc_external_link_event (owner_user_id, provider, external_calendar_id, external_event_id),
  -- Um compromisso tem no máximo uma origem externa.
  UNIQUE KEY uniq_pc_external_link_item (item_id),
  CONSTRAINT fk_pc_external_link_owner
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_pc_external_link_item
    FOREIGN KEY (item_id) REFERENCES personal_calendar_items(id) ON DELETE CASCADE,
  CONSTRAINT chk_pc_external_link_provider CHECK (CHAR_LENGTH(TRIM(provider)) > 0),
  CONSTRAINT chk_pc_external_link_event CHECK (CHAR_LENGTH(TRIM(external_event_id)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Cursor incremental por calendário lido
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS personal_calendar_import_cursors (
  id INT NOT NULL AUTO_INCREMENT,
  owner_user_id INT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  external_calendar_id VARCHAR(255) NOT NULL,
  -- Sync token do provedor. NULL força leitura completa da janela.
  sync_cursor VARCHAR(512) NULL,
  last_imported_at TIMESTAMP NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_pc_import_cursor (owner_user_id, provider, external_calendar_id),
  CONSTRAINT fk_pc_import_cursor_owner
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Postflight estrutural
-- ---------------------------------------------------------------------------

SET @pci_missing := (
  SELECT COUNT(*)
  FROM (
    SELECT 'personal_calendar_external_links' AS t, 'item_id' AS c, 'int' AS dt
    UNION ALL SELECT 'personal_calendar_external_links', 'external_event_id', 'varchar'
    UNION ALL SELECT 'personal_calendar_external_links', 'external_etag', 'varchar'
    UNION ALL SELECT 'personal_calendar_external_links', 'deleted_at', 'timestamp'
    UNION ALL SELECT 'personal_calendar_import_cursors', 'sync_cursor', 'varchar'
    UNION ALL SELECT 'personal_calendar_import_cursors', 'last_imported_at', 'timestamp'
  ) AS expected
  LEFT JOIN INFORMATION_SCHEMA.COLUMNS AS actual
    ON actual.TABLE_SCHEMA = DATABASE()
    AND actual.TABLE_NAME = expected.t
    AND actual.COLUMN_NAME = expected.c
    AND actual.DATA_TYPE = expected.dt
  WHERE actual.COLUMN_NAME IS NULL
);

SET @ddl := IF(
  @pci_missing = 0,
  'SELECT 1',
  'SELECT 1 FROM `__personal_calendar_import_column_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @pci_missing_keys := (
  SELECT COUNT(*)
  FROM (
    SELECT 'personal_calendar_external_links' AS t, 'uniq_pc_external_link_event' AS n
    UNION ALL SELECT 'personal_calendar_external_links', 'uniq_pc_external_link_item'
    UNION ALL SELECT 'personal_calendar_external_links', 'fk_pc_external_link_item'
    UNION ALL SELECT 'personal_calendar_import_cursors', 'uniq_pc_import_cursor'
  ) AS expected
  LEFT JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS actual
    ON actual.CONSTRAINT_SCHEMA = DATABASE()
    AND actual.TABLE_NAME = expected.t
    AND actual.CONSTRAINT_NAME = expected.n
  WHERE actual.CONSTRAINT_NAME IS NULL
);

SET @ddl := IF(
  @pci_missing_keys = 0,
  'SELECT 1',
  'SELECT 1 FROM `__personal_calendar_import_key_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
