-- 2026-09-12 — confirmações de plantão: estado terminal e política do aviso ao gestor.
--
-- Decisão do PO (12/09/2026), item 5 do plano de bancos:
--   - plantão não confirmado continua sendo avisado ao gestor da escala, MAS
--     cada instituição (o grupo de trabalho) pode desligar esse aviso: "nós
--     oferecemos a ferramenta, apenas";
--   - confirmação que não se resolveu até o fim do plantão encerra num estado
--     terminal, em vez de ficar PENDING para sempre (no staging: 83 pendentes,
--     79 de plantões já terminados, a mais antiga de 26/08);
--   - as pendências antigas de hoje são descartadas por esse mesmo caminho.
--
-- Quatro mudanças, todas aditivas e guardadas:
--   1. institutions.notify_manager_on_unconfirmed TINYINT(1) NOT NULL DEFAULT 1
--      (ligado por padrão: o comportamento de hoje);
--   2. duty_confirmations.status ganha 'EXPIRED';
--   3. duty_confirmations.expired_at TIMESTAMP NULL (quando encerrou);
--   4. duty_confirmations.escalation_suppressed_at TIMESTAMP NULL (o aviso
--      teria ido ao gestor, mas a instituição desligou — a descoberta do cron
--      trata como escalada, sem re-armar).
--
-- Fora do hash da cerca de prontidão: a cobertura de institutions é
-- (id, is_active) e duty_confirmations não é coberta.
-- ANSI_QUOTES: só aspas simples. Rerodável.
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela inexistente.

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------

SET @cx_tables := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE = 'BASE TABLE'
    AND TABLE_NAME IN ('institutions', 'duty_confirmations')
);
SET @ddl := IF(
  @cx_tables = 2,
  'SELECT 1',
  'SELECT 1 FROM `__confirmation_policy_foundation_missing__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Manifesto do enum lido do catálogo: nenhum valor atual fora da lista nova.
SET @cx_rest := (
  SELECT COLUMN_TYPE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'duty_confirmations'
    AND COLUMN_NAME = 'status'
);
SET @cx_rest := REPLACE(@cx_rest, '''PENDING''', '');
SET @cx_rest := REPLACE(@cx_rest, '''CONFIRMED''', '');
SET @cx_rest := REPLACE(@cx_rest, '''DECLINED''', '');
SET @cx_rest := REPLACE(@cx_rest, '''NOMINATED''', '');
SET @cx_rest := REPLACE(@cx_rest, '''REPLACEMENT_CONFIRMED''', '');
SET @cx_rest := REPLACE(@cx_rest, '''REPLACEMENT_DECLINED''', '');
SET @cx_rest := REPLACE(@cx_rest, '''AUTO_CONFIRMED''', '');
SET @cx_rest := REPLACE(@cx_rest, '''EXPIRED''', '');
SET @cx_rest := REPLACE(REPLACE(REPLACE(@cx_rest, 'enum(', ''), ')', ''), ',', '');
SET @ddl := IF(
  @cx_rest = '',
  'SELECT 1',
  'SELECT 1 FROM `__duty_confirmations_status_unknown_value__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 1. institutions.notify_manager_on_unconfirmed
-- ---------------------------------------------------------------------------

SET @cx_flag := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'institutions'
    AND COLUMN_NAME = 'notify_manager_on_unconfirmed'
);
SET @ddl := IF(
  @cx_flag = 0,
  'ALTER TABLE institutions ADD COLUMN notify_manager_on_unconfirmed TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. duty_confirmations.status + EXPIRED (na ordem do schema)
-- ---------------------------------------------------------------------------

SET @cx_has_expired := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'duty_confirmations'
    AND COLUMN_NAME = 'status'
    AND COLUMN_TYPE LIKE '%''EXPIRED''%'
);
SET @ddl := IF(
  @cx_has_expired = 0,
  'ALTER TABLE duty_confirmations MODIFY COLUMN status ENUM(''PENDING'',''CONFIRMED'',''DECLINED'',''NOMINATED'',''REPLACEMENT_CONFIRMED'',''REPLACEMENT_DECLINED'',''AUTO_CONFIRMED'',''EXPIRED'') NOT NULL DEFAULT ''PENDING''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3. duty_confirmations.expired_at
-- ---------------------------------------------------------------------------

SET @cx_expired_at := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'duty_confirmations'
    AND COLUMN_NAME = 'expired_at'
);
SET @ddl := IF(
  @cx_expired_at = 0,
  'ALTER TABLE duty_confirmations ADD COLUMN expired_at TIMESTAMP NULL AFTER manager_notified',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 4. duty_confirmations.escalation_suppressed_at
-- ---------------------------------------------------------------------------

SET @cx_suppressed := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'duty_confirmations'
    AND COLUMN_NAME = 'escalation_suppressed_at'
);
SET @ddl := IF(
  @cx_suppressed = 0,
  'ALTER TABLE duty_confirmations ADD COLUMN escalation_suppressed_at TIMESTAMP NULL AFTER expired_at',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------

SET @cx_after := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND (
      (TABLE_NAME = 'institutions' AND COLUMN_NAME = 'notify_manager_on_unconfirmed' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = '1')
      OR (TABLE_NAME = 'duty_confirmations' AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%''EXPIRED''%')
      OR (TABLE_NAME = 'duty_confirmations' AND COLUMN_NAME = 'expired_at' AND IS_NULLABLE = 'YES')
      OR (TABLE_NAME = 'duty_confirmations' AND COLUMN_NAME = 'escalation_suppressed_at' AND IS_NULLABLE = 'YES')
    )
);
SET @ddl := IF(
  @cx_after = 4,
  'SELECT 1',
  'SELECT 1 FROM `__confirmation_policy_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
