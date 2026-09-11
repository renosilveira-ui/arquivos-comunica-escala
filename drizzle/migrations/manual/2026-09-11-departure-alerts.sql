-- 2026-09-11 — aviso de "hora de sair": preferências e fila de planos.
--
-- Depende de 2026-09-10-external-integrations-foundation.sql
-- (user_travel_origins). Aplicar naquela ordem.
--
-- Somente estrutura. Não liga nada: sem linha em user_departure_preferences
-- com enabled = 1, nenhum plano é criado e nenhum push é enviado.
--
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela inexistente —
-- o MySQL ecoa o nome e quem aplica lê qual guarda disparou.

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------

SET @da_expected_table_count := 2;
SET @da_existing_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE = 'BASE TABLE'
    AND TABLE_NAME IN ('user_departure_preferences', 'departure_plans')
);

SET @ddl := IF(
  @da_existing_table_count IN (0, @da_expected_table_count),
  'SELECT 1',
  'SELECT 1 FROM `__departure_partial_schema__`'
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
      AND TABLE_NAME IN ('users', 'institutions', 'user_travel_origins')
  ) = 3,
  'SELECT 1',
  'SELECT 1 FROM `__departure_foundation_missing__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 1. Preferências (opt-in explícito)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_departure_preferences (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  -- Desligado por padrão. Conveniência que ninguém pediu vira ruído, e ruído
  -- em app de plantão treina o médico a ignorar notificação.
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  travel_origin_id INT NULL,
  travel_mode ENUM('DRIVING','WALKING','TRANSIT') NOT NULL DEFAULT 'DRIVING',
  arrival_margin_minutes INT NOT NULL DEFAULT 15,
  -- Tempo assumido quando a rota não pôde ser calculada: a ausência do
  -- Google não pode virar ausência de aviso.
  fallback_travel_minutes INT NOT NULL DEFAULT 40,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_departure_preference_user (user_id),
  CONSTRAINT fk_departure_preference_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_departure_preference_origin
    FOREIGN KEY (travel_origin_id) REFERENCES user_travel_origins(id)
    ON DELETE SET NULL,
  CONSTRAINT chk_departure_margin CHECK (
    arrival_margin_minutes BETWEEN 0 AND 240
  ),
  CONSTRAINT chk_departure_fallback CHECK (
    fallback_travel_minutes BETWEEN 5 AND 480
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Fila de planos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS departure_plans (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  institution_id INT NOT NULL,
  assignment_id INT NOT NULL,
  shift_instance_id INT NOT NULL,
  travel_origin_id INT NULL,
  status ENUM('PENDING','SCHEDULED','SENT','CANCELLED','UNAVAILABLE')
    NOT NULL DEFAULT 'PENDING',
  desired_arrival_at TIMESTAMP NOT NULL,
  estimated_duration_seconds INT NULL,
  estimated_distance_meters INT NULL,
  estimate_quality ENUM('LIVE_TRAFFIC','TYPICAL','FALLBACK') NULL,
  depart_at TIMESTAMP NULL,
  next_recompute_at TIMESTAMP NULL,
  computed_at TIMESTAMP NULL,
  sent_at TIMESTAMP NULL,
  -- De que MUNDO o cálculo saiu. Se o plantão mudou de horário ou o usuário
  -- trocou a origem, a assinatura deixa de bater e o plano é recalculado —
  -- em vez de disparar um aviso baseado num mundo que não existe mais.
  shift_signature CHAR(64) NULL,
  origin_signature CHAR(64) NULL,
  weather_summary VARCHAR(120) NULL,
  -- Identidade do aviso. Duas execuções do worker disputam a mesma chave e
  -- só uma envia.
  dedup_key VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  last_failure_reason VARCHAR(32) NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_departure_plan_dedup (dedup_key),
  UNIQUE KEY uniq_departure_plan_assignment (user_id, assignment_id),
  KEY idx_departure_plan_due (status, next_recompute_at),
  KEY idx_departure_plan_send (status, depart_at),
  CONSTRAINT fk_departure_plan_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_departure_plan_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_departure_plan_origin
    FOREIGN KEY (travel_origin_id) REFERENCES user_travel_origins(id)
    ON DELETE SET NULL,
  CONSTRAINT chk_departure_plan_attempts CHECK (attempt_count >= 0),
  -- Um plano ENVIADO precisa ter de fato horário calculado. Sem esta trava,
  -- um bug marcaria como enviado algo que nunca teve hora — e o médico
  -- receberia um aviso sem horário.
  CONSTRAINT chk_departure_plan_sent CHECK (
    (status <> 'SENT') OR (depart_at IS NOT NULL AND sent_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Postflight estrutural
-- ---------------------------------------------------------------------------

SET @da_missing := (
  SELECT COUNT(*)
  FROM (
    SELECT 'user_departure_preferences' AS t, 'enabled' AS c, 'tinyint' AS dt
    UNION ALL SELECT 'user_departure_preferences', 'travel_mode', 'enum'
    UNION ALL SELECT 'user_departure_preferences', 'arrival_margin_minutes', 'int'
    UNION ALL SELECT 'user_departure_preferences', 'fallback_travel_minutes', 'int'
    UNION ALL SELECT 'departure_plans', 'assignment_id', 'int'
    UNION ALL SELECT 'departure_plans', 'status', 'enum'
    UNION ALL SELECT 'departure_plans', 'desired_arrival_at', 'timestamp'
    UNION ALL SELECT 'departure_plans', 'depart_at', 'timestamp'
    UNION ALL SELECT 'departure_plans', 'next_recompute_at', 'timestamp'
    UNION ALL SELECT 'departure_plans', 'estimate_quality', 'enum'
    UNION ALL SELECT 'departure_plans', 'shift_signature', 'char'
    UNION ALL SELECT 'departure_plans', 'origin_signature', 'char'
    UNION ALL SELECT 'departure_plans', 'dedup_key', 'varchar'
  ) AS expected
  LEFT JOIN INFORMATION_SCHEMA.COLUMNS AS actual
    ON actual.TABLE_SCHEMA = DATABASE()
    AND actual.TABLE_NAME = expected.t
    AND actual.COLUMN_NAME = expected.c
    AND actual.DATA_TYPE = expected.dt
  WHERE actual.COLUMN_NAME IS NULL
);

SET @ddl := IF(
  @da_missing = 0,
  'SELECT 1',
  'SELECT 1 FROM `__departure_column_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @da_missing_keys := (
  SELECT COUNT(*)
  FROM (
    SELECT 'user_departure_preferences' AS t, 'uniq_departure_preference_user' AS n
    UNION ALL SELECT 'user_departure_preferences', 'fk_departure_preference_user'
    UNION ALL SELECT 'user_departure_preferences', 'chk_departure_margin'
    UNION ALL SELECT 'departure_plans', 'uniq_departure_plan_dedup'
    UNION ALL SELECT 'departure_plans', 'uniq_departure_plan_assignment'
    UNION ALL SELECT 'departure_plans', 'fk_departure_plan_user'
    UNION ALL SELECT 'departure_plans', 'chk_departure_plan_sent'
  ) AS expected
  LEFT JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS actual
    ON actual.CONSTRAINT_SCHEMA = DATABASE()
    AND actual.TABLE_NAME = expected.t
    AND actual.CONSTRAINT_NAME = expected.n
  WHERE actual.CONSTRAINT_NAME IS NULL
);

SET @ddl := IF(
  @da_missing_keys = 0,
  'SELECT 1',
  'SELECT 1 FROM `__departure_key_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
