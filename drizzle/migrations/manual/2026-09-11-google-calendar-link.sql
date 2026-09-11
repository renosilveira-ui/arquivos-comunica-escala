-- 2026-09-11 — vínculo com o Google Agenda: estado OAuth e espelho de eventos.
--
-- Depende de drizzle/migrations/manual/2026-09-10-external-integrations-foundation.sql
-- (que cria user_external_credentials). Aplicar naquela ordem.
--
-- Somente estrutura. Não habilita a integração: sem GOOGLE_OAUTH_* no
-- ambiente, o provedor fica NOT_CONFIGURED e nenhuma linha é escrita aqui.
--
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela que não existe.
-- O MySQL ecoa o nome na mensagem, então quem aplica lê qual guarda disparou.
--
-- Reaplicação é segura: estado parcial das duas tabelas falha fechado antes
-- de qualquer DDL.

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------

SET @gc_expected_table_count := 2;
SET @gc_existing_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE = 'BASE TABLE'
    AND TABLE_NAME IN ('google_oauth_states', 'external_calendar_event_links')
);

SET @ddl := IF(
  @gc_existing_table_count IN (0, @gc_expected_table_count),
  'SELECT 1',
  'SELECT 1 FROM `__google_calendar_partial_schema__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A fundação precisa estar instalada: sem user_external_credentials não há
-- onde guardar o refresh token que estas tabelas pressupõem.
SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME IN ('users', 'user_external_credentials')
  ) = 2,
  'SELECT 1',
  'SELECT 1 FROM `__google_calendar_foundation_missing__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 1. Estado de autorização OAuth em andamento
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS google_oauth_states (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  -- SHA-256 do state. Guardar o hash e não o valor: quem lesse a tabela não
  -- conseguiria forjar um callback.
  state_hash CHAR(64) NOT NULL,
  -- PKCE. Selado: sem ele, quem lesse a tabela completaria a troca de código
  -- no lugar do usuário.
  sealed_code_verifier TEXT NOT NULL,
  encryption_kid VARCHAR(32) NOT NULL,
  -- Rótulo de destino, nunca URL. Impede redirecionador aberto no callback.
  return_target VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Unicidade do state é o que torna o consumo de uso único possível.
  UNIQUE KEY uniq_google_oauth_state (state_hash),
  KEY idx_google_oauth_state_sweep (expires_at),
  KEY idx_google_oauth_state_user (user_id, consumed_at),
  CONSTRAINT fk_google_oauth_state_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_google_oauth_state_target CHECK (
    return_target IN ('WEB', 'MOBILE')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Espelho dos eventos que mantemos no calendário externo
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS external_calendar_event_links (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  external_calendar_id VARCHAR(255) NOT NULL,
  external_event_id VARCHAR(255) NOT NULL,
  source_kind ENUM('PERSONAL_ITEM','DUTY_ASSIGNMENT') NOT NULL,
  source_id INT NOT NULL,
  occurrence_key VARCHAR(64) NULL,
  -- UNIQUE com NULL não restringe nada: o MySQL trata cada NULL como
  -- distinto, então dois plantões (occurrence_key NULL) da mesma origem
  -- passariam pela chave abaixo e virariam DOIS eventos no Google. A coluna
  -- gerada colapsa NULL num sentinela para que a unicidade valha de fato.
  occurrence_slot VARCHAR(64) GENERATED ALWAYS AS (COALESCE(occurrence_key, '')) STORED,
  external_etag VARCHAR(255) NULL,
  content_fingerprint CHAR(64) NULL,
  last_pushed_at TIMESTAMP NULL,
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Um evento externo pertence a um vínculo só.
  UNIQUE KEY uniq_external_calendar_event (
    user_id, provider, external_calendar_id, external_event_id
  ),
  -- E uma origem produz um evento só: sem esta chave, um ciclo interrompido
  -- no meio criaria um segundo evento para o mesmo plantão.
  UNIQUE KEY uniq_external_calendar_source (
    user_id, provider, source_kind, source_id, occurrence_slot
  ),
  KEY idx_external_calendar_user_sweep (user_id, provider, deleted_at),
  CONSTRAINT fk_external_calendar_event_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Postflight estrutural
-- ---------------------------------------------------------------------------

SET @gc_missing := (
  SELECT COUNT(*)
  FROM (
    SELECT 'google_oauth_states' AS t, 'state_hash' AS c, 'char' AS dt
    UNION ALL SELECT 'google_oauth_states', 'sealed_code_verifier', 'text'
    UNION ALL SELECT 'google_oauth_states', 'encryption_kid', 'varchar'
    UNION ALL SELECT 'google_oauth_states', 'return_target', 'varchar'
    UNION ALL SELECT 'google_oauth_states', 'expires_at', 'timestamp'
    UNION ALL SELECT 'google_oauth_states', 'consumed_at', 'timestamp'
    UNION ALL SELECT 'external_calendar_event_links', 'external_event_id', 'varchar'
    UNION ALL SELECT 'external_calendar_event_links', 'source_kind', 'enum'
    UNION ALL SELECT 'external_calendar_event_links', 'source_id', 'int'
    UNION ALL SELECT 'external_calendar_event_links', 'occurrence_key', 'varchar'
    UNION ALL SELECT 'external_calendar_event_links', 'occurrence_slot', 'varchar'
    UNION ALL SELECT 'external_calendar_event_links', 'external_etag', 'varchar'
    UNION ALL SELECT 'external_calendar_event_links', 'content_fingerprint', 'char'
    UNION ALL SELECT 'external_calendar_event_links', 'deleted_at', 'timestamp'
  ) AS expected
  LEFT JOIN INFORMATION_SCHEMA.COLUMNS AS actual
    ON actual.TABLE_SCHEMA = DATABASE()
    AND actual.TABLE_NAME = expected.t
    AND actual.COLUMN_NAME = expected.c
    AND actual.DATA_TYPE = expected.dt
  WHERE actual.COLUMN_NAME IS NULL
);

SET @ddl := IF(
  @gc_missing = 0,
  'SELECT 1',
  'SELECT 1 FROM `__google_calendar_column_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @gc_missing_keys := (
  SELECT COUNT(*)
  FROM (
    SELECT 'google_oauth_states' AS t, 'uniq_google_oauth_state' AS n
    UNION ALL SELECT 'google_oauth_states', 'fk_google_oauth_state_user'
    UNION ALL SELECT 'external_calendar_event_links', 'uniq_external_calendar_event'
    UNION ALL SELECT 'external_calendar_event_links', 'uniq_external_calendar_source'
    UNION ALL SELECT 'external_calendar_event_links', 'fk_external_calendar_event_user'
  ) AS expected
  LEFT JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS actual
    ON actual.CONSTRAINT_SCHEMA = DATABASE()
    AND actual.TABLE_NAME = expected.t
    AND actual.CONSTRAINT_NAME = expected.n
  WHERE actual.CONSTRAINT_NAME IS NULL
);

SET @ddl := IF(
  @gc_missing_keys = 0,
  'SELECT 1',
  'SELECT 1 FROM `__google_calendar_key_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
