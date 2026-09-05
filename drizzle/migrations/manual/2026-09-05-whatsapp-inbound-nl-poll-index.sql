-- 2026-09-05 — índice composto para o poll READY_FOR_NL (B2-D).
-- Aditivo e rerodável. Não altera dados, status, error_code nem payload.
-- CREATE TABLE IF NOT EXISTS da migration 2026-09-04 não aplica KEY nova
-- em tabela já existente; este ALTER cobre DBs live.
--
-- Contrato: (provider, processing_status, content_kind, payload_cleared_at,
-- received_at, id). Write-cost: 1 INSERT inbound / mensagem.
-- Rollback: ALTER TABLE whatsapp_inbound_messages DROP INDEX idx_whatsapp_inbound_nl_poll;

SET @index_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_inbound_messages'
    AND INDEX_NAME = 'idx_whatsapp_inbound_nl_poll'
);
SET @index_contract_matches := (
  SELECT COUNT(*) = 6 AND SUM(CASE WHEN NON_UNIQUE = 1 AND (
    (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'provider') OR
    (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'processing_status') OR
    (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'content_kind') OR
    (SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'payload_cleared_at') OR
    (SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'received_at') OR
    (SEQ_IN_INDEX = 6 AND COLUMN_NAME = 'id')
  ) THEN 1 ELSE 0 END) = 6
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'whatsapp_inbound_messages'
    AND INDEX_NAME = 'idx_whatsapp_inbound_nl_poll'
);

SET @preflight := IF(
  @index_exists = 0 OR @index_contract_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_INBOUND_NL_POLL_INDEX_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE nl_poll_idx_stmt FROM @preflight;
EXECUTE nl_poll_idx_stmt;
DEALLOCATE PREPARE nl_poll_idx_stmt;

SET @ddl := IF(
  @index_exists = 0,
  'ALTER TABLE whatsapp_inbound_messages ADD INDEX idx_whatsapp_inbound_nl_poll (provider, processing_status, content_kind, payload_cleared_at, received_at, id)',
  'SELECT 1'
);
PREPARE nl_poll_idx_stmt FROM @ddl;
EXECUTE nl_poll_idx_stmt;
DEALLOCATE PREPARE nl_poll_idx_stmt;

SET @postflight := IF(
  (
    SELECT COUNT(*) = 6
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'whatsapp_inbound_messages'
      AND INDEX_NAME = 'idx_whatsapp_inbound_nl_poll'
  ),
  'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_INBOUND_NL_POLL_INDEX_POSTFLIGHT_MISMATCH'', ''$'')'
);
PREPARE nl_poll_idx_stmt FROM @postflight;
EXECUTE nl_poll_idx_stmt;
DEALLOCATE PREPARE nl_poll_idx_stmt;
