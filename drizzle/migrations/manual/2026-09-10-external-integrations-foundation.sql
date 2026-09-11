-- 2026-09-10 — fundação das integrações externas e do fuso por instituição.
--
-- Somente estrutura. Esta migration NÃO liga Google Calendar, Places, Routes,
-- WeatherKit nem aviso de saída; não grava credencial, não cria job e não
-- altera nenhuma escala existente.
--
-- O que ela instala:
--   1. institutions.time_zone  — fuso IANA, NOT NULL com default seguro.
--   2. hospitals.*             — fuso opcional e destino canônico do trajeto.
--   3. user_external_credentials — vínculo account-wide com provedor externo.
--   4. user_travel_origins       — origem de deslocamento do usuário, selada.
--
-- Compatibilidade temporal: o default 'America/Sao_Paulo' faz toda
-- instituição existente e futura nascer no mesmo fuso que o domínio legado
-- de offset fixo -03:00 (server/local-time.ts) já assume. Nenhum cálculo de
-- escala muda de resultado com esta migration.
--
-- Reaplicação é segura: cada passo confere o catálogo antes de agir. Um
-- estado parcial das duas tabelas novas falha fechado antes de qualquer DDL.
--
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela que não
-- existe. O MySQL ecoa o nome na mensagem de erro, então quem aplica lê qual
-- guarda disparou. (`SELECT JSON_EXTRACT('MOTIVO','$')` também aborta, mas
-- responde só "Invalid JSON text" e engole o motivo.)
--
-- O postflight compara nome e TIPO de coluna e a presença das chaves. Não é
-- hash do texto do DDL: o INFORMATION_SCHEMA reescreve predicado, caixa de
-- ENUM e regra de FK, e a serialização varia entre patches do MySQL — um
-- manifesto textual passa a recusar o próprio schema que ele instalou.

-- ---------------------------------------------------------------------------
-- Preflight: meia instalação é pior que nenhuma.
-- ---------------------------------------------------------------------------

SET @ei_expected_table_count := 2;
SET @ei_existing_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE = 'BASE TABLE'
    AND TABLE_NAME IN ('user_external_credentials', 'user_travel_origins')
);

SET @ddl := IF(
  @ei_existing_table_count IN (0, @ei_expected_table_count),
  'SELECT 1',
  'SELECT 1 FROM `__external_integrations_partial_schema__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A fundação depende de `users`. Sem ela, as FKs abaixo falhariam no meio.
SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME IN ('users', 'institutions', 'hospitals')
  ) = 3,
  'SELECT 1',
  'SELECT 1 FROM `__external_integrations_base_schema_missing__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 1. Fuso da instituição
-- ---------------------------------------------------------------------------

SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'institutions'
      AND COLUMN_NAME = 'time_zone'
  ) = 0,
  'ALTER TABLE institutions ADD COLUMN time_zone VARCHAR(64) NOT NULL DEFAULT ''America/Sao_Paulo'' AFTER is_active',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill explícito. O DEFAULT cobre as linhas existentes no ADD COLUMN,
-- mas uma instalação anterior pode ter deixado a coluna nula ou vazia.
UPDATE institutions
SET time_zone = 'America/Sao_Paulo'
WHERE time_zone IS NULL OR TRIM(time_zone) = '';

-- ---------------------------------------------------------------------------
-- 2. Destino canônico e fuso do hospital
-- ---------------------------------------------------------------------------

SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hospitals'
      AND COLUMN_NAME = 'time_zone'
  ) = 0,
  'ALTER TABLE hospitals ADD COLUMN time_zone VARCHAR(64) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hospitals'
      AND COLUMN_NAME = 'google_place_id'
  ) = 0,
  'ALTER TABLE hospitals ADD COLUMN google_place_id VARCHAR(255) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hospitals'
      AND COLUMN_NAME = 'latitude'
  ) = 0,
  'ALTER TABLE hospitals ADD COLUMN latitude DECIMAL(10,7) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hospitals'
      AND COLUMN_NAME = 'longitude'
  ) = 0,
  'ALTER TABLE hospitals ADD COLUMN longitude DECIMAL(10,7) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hospitals'
      AND COLUMN_NAME = 'location_updated_at'
  ) = 0,
  'ALTER TABLE hospitals ADD COLUMN location_updated_at TIMESTAMP NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hospitals'
      AND COLUMN_NAME = 'location_updated_by_user_id'
  ) = 0,
  'ALTER TABLE hospitals ADD COLUMN location_updated_by_user_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- SET NULL: a saída de um gestor não pode apagar a localização do hospital
-- nem bloquear a exclusão da conta dele.
SET @ddl := IF(
  (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hospitals'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'fk_hospitals_location_updated_by'
  ) = 0,
  'ALTER TABLE hospitals ADD CONSTRAINT fk_hospitals_location_updated_by FOREIGN KEY (location_updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3. Vínculo da conta com provedor externo
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_external_credentials (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  link_state ENUM('CONNECTED','DEGRADED','REAUTH_REQUIRED','DISCONNECTED')
    NOT NULL DEFAULT 'DISCONNECTED',
  sealed_refresh_token TEXT NULL,
  sealed_account_label TEXT NULL,
  encryption_kid VARCHAR(32) NULL,
  granted_scopes TEXT NULL,
  external_calendar_id VARCHAR(255) NULL,
  sync_cursor VARCHAR(512) NULL,
  last_synced_at TIMESTAMP NULL,
  last_failure_reason VARCHAR(32) NULL,
  consecutive_failure_count INT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1,
  connected_at TIMESTAMP NULL,
  disconnected_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_external_credential_provider (user_id, provider),
  KEY idx_user_external_credential_sweep (link_state, last_synced_at),
  KEY idx_user_external_credential_kid (encryption_kid),
  CONSTRAINT fk_user_external_credential_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  -- Segredo sem chave declarada é envelope que ninguém consegue abrir nem
  -- rotacionar. O banco recusa esse estado em vez de deixá-lo apodrecer.
  CONSTRAINT chk_user_external_credential_kid CHECK (
    (sealed_refresh_token IS NULL AND sealed_account_label IS NULL)
    OR encryption_kid IS NOT NULL
  ),
  -- Vínculo ativo sem credencial selada seria um "conectado" que não
  -- consegue renovar nada.
  CONSTRAINT chk_user_external_credential_state CHECK (
    link_state = 'DISCONNECTED' OR sealed_refresh_token IS NOT NULL
  ),
  CONSTRAINT chk_user_external_credential_failures CHECK (
    consecutive_failure_count >= 0
  ),
  CONSTRAINT chk_user_external_credential_version CHECK (version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Origem de deslocamento do usuário
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_travel_origins (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  label VARCHAR(60) NOT NULL,
  sealed_location TEXT NOT NULL,
  encryption_kid VARCHAR(32) NOT NULL,
  consent_granted_at TIMESTAMP NOT NULL,
  consent_version VARCHAR(32) NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  -- Coluna gerada + UNIQUE: uma única origem padrão por conta, garantida
  -- pelo banco. Um writer distraído não consegue criar a segunda.
  default_slot TINYINT GENERATED ALWAYS AS (IF(is_default = 1, 1, NULL)) STORED,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_travel_origin_label (user_id, label),
  UNIQUE KEY uniq_user_travel_origin_default (user_id, default_slot),
  KEY idx_user_travel_origin_kid (encryption_kid),
  CONSTRAINT fk_user_travel_origin_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_user_travel_origin_label CHECK (CHAR_LENGTH(TRIM(label)) > 0),
  CONSTRAINT chk_user_travel_origin_version CHECK (version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Postflight estrutural
--
-- Confere presença e tipo de cada coluna e a existência das chaves que
-- sustentam as invariantes (unicidade do vínculo, unicidade do padrão,
-- cascata na exclusão da conta). Não é hash de contrato: detecta ausência e
-- divergência de tipo, não toda mudança concebível de definição.
-- ---------------------------------------------------------------------------

SET @ei_missing := (
  SELECT COUNT(*)
  FROM (
    SELECT 'institutions' AS t, 'time_zone' AS c, 'varchar' AS dt
    UNION ALL SELECT 'hospitals', 'time_zone', 'varchar'
    UNION ALL SELECT 'hospitals', 'google_place_id', 'varchar'
    UNION ALL SELECT 'hospitals', 'latitude', 'decimal'
    UNION ALL SELECT 'hospitals', 'longitude', 'decimal'
    UNION ALL SELECT 'hospitals', 'location_updated_at', 'timestamp'
    UNION ALL SELECT 'hospitals', 'location_updated_by_user_id', 'int'
    UNION ALL SELECT 'user_external_credentials', 'user_id', 'int'
    UNION ALL SELECT 'user_external_credentials', 'provider', 'varchar'
    UNION ALL SELECT 'user_external_credentials', 'link_state', 'enum'
    UNION ALL SELECT 'user_external_credentials', 'sealed_refresh_token', 'text'
    UNION ALL SELECT 'user_external_credentials', 'sealed_account_label', 'text'
    UNION ALL SELECT 'user_external_credentials', 'encryption_kid', 'varchar'
    UNION ALL SELECT 'user_external_credentials', 'version', 'int'
    UNION ALL SELECT 'user_travel_origins', 'user_id', 'int'
    UNION ALL SELECT 'user_travel_origins', 'label', 'varchar'
    UNION ALL SELECT 'user_travel_origins', 'sealed_location', 'text'
    UNION ALL SELECT 'user_travel_origins', 'encryption_kid', 'varchar'
    UNION ALL SELECT 'user_travel_origins', 'consent_granted_at', 'timestamp'
    UNION ALL SELECT 'user_travel_origins', 'consent_version', 'varchar'
    UNION ALL SELECT 'user_travel_origins', 'default_slot', 'tinyint'
  ) AS expected
  LEFT JOIN INFORMATION_SCHEMA.COLUMNS AS actual
    ON actual.TABLE_SCHEMA = DATABASE()
    AND actual.TABLE_NAME = expected.t
    AND actual.COLUMN_NAME = expected.c
    AND actual.DATA_TYPE = expected.dt
  WHERE actual.COLUMN_NAME IS NULL
);

SET @ddl := IF(
  @ei_missing = 0,
  'SELECT 1',
  'SELECT 1 FROM `__external_integrations_column_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ei_missing_keys := (
  SELECT COUNT(*)
  FROM (
    SELECT 'user_external_credentials' AS t,
           'uniq_user_external_credential_provider' AS n
    UNION ALL SELECT 'user_external_credentials', 'fk_user_external_credential_user'
    UNION ALL SELECT 'user_travel_origins', 'uniq_user_travel_origin_label'
    UNION ALL SELECT 'user_travel_origins', 'uniq_user_travel_origin_default'
    UNION ALL SELECT 'user_travel_origins', 'fk_user_travel_origin_user'
    UNION ALL SELECT 'hospitals', 'fk_hospitals_location_updated_by'
  ) AS expected
  LEFT JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS actual
    ON actual.CONSTRAINT_SCHEMA = DATABASE()
    AND actual.TABLE_NAME = expected.t
    AND actual.CONSTRAINT_NAME = expected.n
  WHERE actual.CONSTRAINT_NAME IS NULL
);

SET @ddl := IF(
  @ei_missing_keys = 0,
  'SELECT 1',
  'SELECT 1 FROM `__external_integrations_key_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Nenhuma instituição pode terminar sem fuso: é o que mantém o domínio
-- temporal legado e o novo apontando para o mesmo relógio.
SET @ei_institutions_without_tz := (
  SELECT COUNT(*)
  FROM institutions
  WHERE time_zone IS NULL OR TRIM(time_zone) = ''
);

SET @ddl := IF(
  @ei_institutions_without_tz = 0,
  'SELECT 1',
  'SELECT 1 FROM `__external_integrations_timezone_backfill_incomplete__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
