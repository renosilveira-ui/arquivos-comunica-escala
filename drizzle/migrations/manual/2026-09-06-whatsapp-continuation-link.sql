-- 2026-09-06 — vínculo de continuação WhatsApp (inbound child → pending).
-- Aditiva, nullable, sem backfill, rerodável.
-- NÃO aplicar no staging nesta PR. Após revisão independente, o owner
-- decide se existe STAGING_MIGRATION_REQUIRED_BEFORE_PROMOTION.
-- O deploy NÃO aplica migration.
--
-- Contrato:
--   whatsapp_inbound_messages.continuation_pending_id INT NULL
--     INDEX idx_whatsapp_inbound_continuation_pending
--     FK fk_whatsapp_inbound_continuation_pending
--       → whatsapp_pending_intents.id ON DELETE SET NULL
--   whatsapp_inbound_messages.continuation_outcome ENUM('APPLIED','NOOP') NULL
--     (sem índice novo)
--   whatsapp_pending_intents.confirmation_disposition ENUM('AFFIRMED') NULL
--     (sem índice novo)
--
-- Existing DB: ADD columns → ADD index → ADD FK.
-- Fresh CREATE 2026-09-04 já nasce com as colunas; este arquivo adiciona
-- a FK circular-safe depois de as duas tabelas existirem.
-- Homônimo/contrato incompatível → fail-closed (JSON_EXTRACT de sentinela).

-- ---------------------------------------------------------------------------
-- continuation_pending_id
-- ---------------------------------------------------------------------------
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_inbound_messages'
    AND COLUMN_NAME = 'continuation_pending_id'
);
SET @col_contract := (
  SELECT COUNT(*) = 1
     AND SUM(DATA_TYPE = 'int' AND IS_NULLABLE = 'YES' AND COLUMN_KEY <> 'PRI') = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_inbound_messages'
    AND COLUMN_NAME = 'continuation_pending_id'
);
SET @preflight := IF(
  @col_exists = 0 OR @col_contract = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_CONTINUATION_PENDING_ID_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE wa_cont_stmt FROM @preflight;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE whatsapp_inbound_messages ADD COLUMN continuation_pending_id INT NULL DEFAULT NULL',
  'SELECT 1'
);
PREPARE wa_cont_stmt FROM @ddl;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

-- ---------------------------------------------------------------------------
-- continuation_outcome
-- ---------------------------------------------------------------------------
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_inbound_messages'
    AND COLUMN_NAME = 'continuation_outcome'
);
SET @col_contract := (
  SELECT COUNT(*) = 1
     AND SUM(
       DATA_TYPE = 'enum'
       AND IS_NULLABLE = 'YES'
       AND COLUMN_TYPE = 'enum(''APPLIED'',''NOOP'')'
     ) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_inbound_messages'
    AND COLUMN_NAME = 'continuation_outcome'
);
SET @preflight := IF(
  @col_exists = 0 OR @col_contract = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_CONTINUATION_OUTCOME_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE wa_cont_stmt FROM @preflight;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE whatsapp_inbound_messages ADD COLUMN continuation_outcome ENUM(''APPLIED'',''NOOP'') NULL DEFAULT NULL',
  'SELECT 1'
);
PREPARE wa_cont_stmt FROM @ddl;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

-- ---------------------------------------------------------------------------
-- confirmation_disposition
-- ---------------------------------------------------------------------------
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_pending_intents'
    AND COLUMN_NAME = 'confirmation_disposition'
);
SET @col_contract := (
  SELECT COUNT(*) = 1
     AND SUM(
       DATA_TYPE = 'enum'
       AND IS_NULLABLE = 'YES'
       AND COLUMN_TYPE = 'enum(''AFFIRMED'')'
     ) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_pending_intents'
    AND COLUMN_NAME = 'confirmation_disposition'
);
SET @preflight := IF(
  @col_exists = 0 OR @col_contract = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_CONFIRMATION_DISPOSITION_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE wa_cont_stmt FROM @preflight;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE whatsapp_pending_intents ADD COLUMN confirmation_disposition ENUM(''AFFIRMED'') NULL DEFAULT NULL',
  'SELECT 1'
);
PREPARE wa_cont_stmt FROM @ddl;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

-- ---------------------------------------------------------------------------
-- INDEX idx_whatsapp_inbound_continuation_pending
-- ---------------------------------------------------------------------------
SET @index_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_inbound_messages'
    AND INDEX_NAME = 'idx_whatsapp_inbound_continuation_pending'
);
SET @index_contract := (
  SELECT COUNT(*) = 1 AND SUM(
    SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'continuation_pending_id' AND NON_UNIQUE = 1
  ) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_inbound_messages'
    AND INDEX_NAME = 'idx_whatsapp_inbound_continuation_pending'
);
SET @preflight := IF(
  @index_exists = 0 OR @index_contract = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_CONTINUATION_INDEX_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE wa_cont_stmt FROM @preflight;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

SET @ddl := IF(
  @index_exists = 0,
  'ALTER TABLE whatsapp_inbound_messages ADD INDEX idx_whatsapp_inbound_continuation_pending (continuation_pending_id)',
  'SELECT 1'
);
PREPARE wa_cont_stmt FROM @ddl;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

-- ---------------------------------------------------------------------------
-- FK fk_whatsapp_inbound_continuation_pending
-- ---------------------------------------------------------------------------
SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND CONSTRAINT_NAME = 'fk_whatsapp_inbound_continuation_pending'
    AND TABLE_NAME = 'whatsapp_inbound_messages'
);
SET @fk_contract := (
  SELECT COUNT(*) = 1
     AND SUM(
       rc.DELETE_RULE = 'SET NULL'
       AND rc.UPDATE_RULE IN ('NO ACTION', 'RESTRICT')
       AND rc.REFERENCED_TABLE_NAME = 'whatsapp_pending_intents'
       AND kcu.COLUMN_NAME = 'continuation_pending_id'
       AND kcu.REFERENCED_COLUMN_NAME = 'id'
     ) = 1
  FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
  INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
    ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
   AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
   AND kcu.TABLE_NAME = rc.TABLE_NAME
  WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
    AND rc.CONSTRAINT_NAME = 'fk_whatsapp_inbound_continuation_pending'
    AND rc.TABLE_NAME = 'whatsapp_inbound_messages'
);
SET @preflight := IF(
  @fk_exists = 0 OR @fk_contract = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_CONTINUATION_FK_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE wa_cont_stmt FROM @preflight;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;

SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE whatsapp_inbound_messages ADD CONSTRAINT fk_whatsapp_inbound_continuation_pending FOREIGN KEY (continuation_pending_id) REFERENCES whatsapp_pending_intents(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE wa_cont_stmt FROM @ddl;
EXECUTE wa_cont_stmt;
DEALLOCATE PREPARE wa_cont_stmt;
