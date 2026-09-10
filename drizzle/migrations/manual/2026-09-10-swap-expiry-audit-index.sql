-- Expiração automática de ofertas precisa de evento próprio e de acesso
-- indexado ao localizar ciclos vencidos antes de uma reoferta.
--
-- Esta migration é deliberadamente fail-closed: aceita somente o contrato
-- físico imediatamente anterior (fresh ou sequência histórica) ou o contrato
-- sucessor único já migrado. Qualquer
-- enum adicional, ordem distinta, collation ou índice homônimo divergente
-- aborta antes do primeiro DDL.
--
-- Risco operacional: ALTER TABLE em ENUM e criação de índice podem adquirir
-- metadata lock e reconstruir a tabela, conforme versão/configuração MySQL.
-- Executar somente em janela coordenada, após comprovar ausência de transações
-- longas. Converter o baseline fresh reordena ENUM e pode reconstruir a tabela;
-- no baseline histórico, os três valores são apenas anexados ao final. DDL
-- MySQL faz commit implícito; se a segunda etapa falhar, a reaplicação
-- segura completa somente o índice ausente.
--
-- Rollback: DROP INDEX idx_swap_expiry_reoffer ON swap_requests. Remover os
-- três valores do ENUM só é seguro depois de provar zero audit_trail rows com
-- actions SWAP_EXPIRED, TRANSFER_EXPIRED e CESSAO_EXPIRED; caso contrário o
-- rollback é proibido para não corromper a trilha.

SET @swap_expiry_action_fresh_before := 'enum(''SHIFT_CREATED'',''SHIFT_UPDATED'',''SHIFT_DELETED'',''ASSIGNMENT_CREATED'',''ASSIGNMENT_REMOVED'',''ASSIGNMENT_ASSUMED_VACANCY'',''ASSIGNMENT_APPROVED'',''ASSIGNMENT_REJECTED'',''SWAP_REQUESTED'',''SWAP_ACCEPTED'',''SWAP_REJECTED'',''SWAP_APPROVED_BY_MANAGER'',''SWAP_APPROVED_BY_OWNER'',''SWAP_CANCELLED'',''TRANSFER_OFFERED'',''TRANSFER_ACCEPTED'',''TRANSFER_REJECTED'',''TRANSFER_APPROVED_BY_MANAGER'',''TRANSFER_APPROVED_BY_OWNER'',''TRANSFER_CANCELLED'',''CESSAO_OFFERED'',''CESSAO_ACCEPTED'',''CESSAO_REJECTED'',''CESSAO_APPROVED_BY_OWNER'',''CESSAO_CANCELLED'',''ROSTER_PUBLISHED'',''ROSTER_LOCKED'',''USER_CREATED'',''USER_UPDATED'',''USER_ROLE_CHANGED'',''INSTITUTION_FEATURE_UPDATED'',''SECTOR_SERVICE_SPECIALTIES_UPDATED'',''SSO_JIT_LINK_CREATED'',''PUSH_DISPATCHED'',''CONFLICT_DETECTED'',''CONFLICT_OVERRIDDEN'')';
SET @swap_expiry_action_upgraded_before := 'enum(''SHIFT_CREATED'',''SHIFT_UPDATED'',''SHIFT_DELETED'',''ASSIGNMENT_CREATED'',''ASSIGNMENT_REMOVED'',''ASSIGNMENT_ASSUMED_VACANCY'',''ASSIGNMENT_APPROVED'',''ASSIGNMENT_REJECTED'',''SWAP_REQUESTED'',''SWAP_ACCEPTED'',''SWAP_REJECTED'',''SWAP_APPROVED_BY_MANAGER'',''SWAP_APPROVED_BY_OWNER'',''SWAP_CANCELLED'',''TRANSFER_OFFERED'',''TRANSFER_ACCEPTED'',''TRANSFER_REJECTED'',''TRANSFER_APPROVED_BY_MANAGER'',''TRANSFER_APPROVED_BY_OWNER'',''TRANSFER_CANCELLED'',''CESSAO_OFFERED'',''CESSAO_ACCEPTED'',''CESSAO_REJECTED'',''CESSAO_APPROVED_BY_OWNER'',''CESSAO_CANCELLED'',''ROSTER_PUBLISHED'',''ROSTER_LOCKED'',''USER_CREATED'',''USER_UPDATED'',''USER_ROLE_CHANGED'',''SSO_JIT_LINK_CREATED'',''PUSH_DISPATCHED'',''CONFLICT_DETECTED'',''CONFLICT_OVERRIDDEN'',''SECTOR_SERVICE_SPECIALTIES_UPDATED'',''INSTITUTION_FEATURE_UPDATED'')';
SET @swap_expiry_action_after := 'enum(''SHIFT_CREATED'',''SHIFT_UPDATED'',''SHIFT_DELETED'',''ASSIGNMENT_CREATED'',''ASSIGNMENT_REMOVED'',''ASSIGNMENT_ASSUMED_VACANCY'',''ASSIGNMENT_APPROVED'',''ASSIGNMENT_REJECTED'',''SWAP_REQUESTED'',''SWAP_ACCEPTED'',''SWAP_REJECTED'',''SWAP_APPROVED_BY_MANAGER'',''SWAP_APPROVED_BY_OWNER'',''SWAP_CANCELLED'',''TRANSFER_OFFERED'',''TRANSFER_ACCEPTED'',''TRANSFER_REJECTED'',''TRANSFER_APPROVED_BY_MANAGER'',''TRANSFER_APPROVED_BY_OWNER'',''TRANSFER_CANCELLED'',''CESSAO_OFFERED'',''CESSAO_ACCEPTED'',''CESSAO_REJECTED'',''CESSAO_APPROVED_BY_OWNER'',''CESSAO_CANCELLED'',''ROSTER_PUBLISHED'',''ROSTER_LOCKED'',''USER_CREATED'',''USER_UPDATED'',''USER_ROLE_CHANGED'',''SSO_JIT_LINK_CREATED'',''PUSH_DISPATCHED'',''CONFLICT_DETECTED'',''CONFLICT_OVERRIDDEN'',''SECTOR_SERVICE_SPECIALTIES_UPDATED'',''INSTITUTION_FEATURE_UPDATED'',''SWAP_EXPIRED'',''TRANSFER_EXPIRED'',''CESSAO_EXPIRED'')';

SET @swap_expiry_audit_contract_matches := (
  SELECT COUNT(*) = 1
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
    AND DATA_TYPE = 'enum'
    AND COLUMN_TYPE IN (
      @swap_expiry_action_fresh_before,
      @swap_expiry_action_upgraded_before,
      @swap_expiry_action_after
    )
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT IS NULL
    AND CHARACTER_SET_NAME = 'utf8mb4'
    AND COLLATION_NAME = 'utf8mb4_0900_ai_ci'
    AND COALESCE(EXTRA, '') = ''
    AND COALESCE(GENERATION_EXPRESSION, '') = ''
    AND COLUMN_COMMENT = ''
);

SET @swap_expiry_table_contract_matches := (
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'swap_requests'
     AND UPPER(ENGINE) = 'INNODB') = 1
  AND
  (SELECT COUNT(*) = 5 AND SUM(CASE
    WHEN COLUMN_NAME = 'institution_id'
      AND DATA_TYPE = 'int' AND COLUMN_TYPE = 'int'
      AND IS_NULLABLE = 'NO' THEN 1
    WHEN COLUMN_NAME = 'from_assignment_id'
      AND DATA_TYPE = 'int' AND COLUMN_TYPE = 'int'
      AND IS_NULLABLE = 'NO' THEN 1
    WHEN COLUMN_NAME = 'status'
      AND DATA_TYPE = 'enum'
      AND COLUMN_TYPE = 'enum(''PENDING'',''ACCEPTED'',''APPROVED'',''REJECTED_BY_PEER'',''REJECTED_BY_MANAGER'',''CANCELLED'',''EXPIRED'')'
      AND IS_NULLABLE = 'NO' THEN 1
    WHEN COLUMN_NAME = 'expires_at'
      AND DATA_TYPE = 'datetime' AND COLUMN_TYPE = 'datetime'
      AND IS_NULLABLE = 'YES' THEN 1
    WHEN COLUMN_NAME = 'id'
      AND DATA_TYPE = 'int' AND COLUMN_TYPE = 'int'
      AND IS_NULLABLE = 'NO' THEN 1
    ELSE 0 END) = 5
   FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'swap_requests'
     AND COLUMN_NAME IN (
       'institution_id', 'from_assignment_id', 'status', 'expires_at', 'id'
     ))
  AND
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'swap_requests'
     AND INDEX_NAME = 'PRIMARY'
     AND NON_UNIQUE = 0
     AND SEQ_IN_INDEX = 1
     AND COLUMN_NAME = 'id') = 1
);

SET @swap_expiry_index_rows := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'swap_requests'
    AND INDEX_NAME = 'idx_swap_expiry_reoffer'
);
SET @swap_expiry_index_contract_matches := (
  @swap_expiry_index_rows = 0
  OR (
    @swap_expiry_index_rows = 5
    AND (SELECT SUM(CASE
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id'
        AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
        AND IS_VISIBLE = 'YES' THEN 1
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'from_assignment_id'
        AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
        AND IS_VISIBLE = 'YES' THEN 1
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'status'
        AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
        AND IS_VISIBLE = 'YES' THEN 1
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'expires_at'
        AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
        AND IS_VISIBLE = 'YES' THEN 1
      WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'id'
        AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
        AND IS_VISIBLE = 'YES' THEN 1
      ELSE 0 END)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'swap_requests'
      AND INDEX_NAME = 'idx_swap_expiry_reoffer') = 5
  )
);

SET @swap_expiry_preflight_matches := (
  @swap_expiry_audit_contract_matches = 1
  AND @swap_expiry_table_contract_matches = 1
  AND @swap_expiry_index_contract_matches = 1
);
SET @swap_expiry_preflight_guard := IF(
  @swap_expiry_preflight_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''[]'', ''$['')'
);
PREPARE swap_expiry_preflight_guard_stmt FROM @swap_expiry_preflight_guard;
EXECUTE swap_expiry_preflight_guard_stmt;
DEALLOCATE PREPARE swap_expiry_preflight_guard_stmt;

SET @swap_expiry_action_current := (
  SELECT COLUMN_TYPE
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
  LIMIT 1
);
SET @swap_expiry_action_ddl := IF(
  @swap_expiry_action_current <> @swap_expiry_action_after,
  'ALTER TABLE audit_trail MODIFY COLUMN action ENUM(''SHIFT_CREATED'',''SHIFT_UPDATED'',''SHIFT_DELETED'',''ASSIGNMENT_CREATED'',''ASSIGNMENT_REMOVED'',''ASSIGNMENT_ASSUMED_VACANCY'',''ASSIGNMENT_APPROVED'',''ASSIGNMENT_REJECTED'',''SWAP_REQUESTED'',''SWAP_ACCEPTED'',''SWAP_REJECTED'',''SWAP_APPROVED_BY_MANAGER'',''SWAP_APPROVED_BY_OWNER'',''SWAP_CANCELLED'',''TRANSFER_OFFERED'',''TRANSFER_ACCEPTED'',''TRANSFER_REJECTED'',''TRANSFER_APPROVED_BY_MANAGER'',''TRANSFER_APPROVED_BY_OWNER'',''TRANSFER_CANCELLED'',''CESSAO_OFFERED'',''CESSAO_ACCEPTED'',''CESSAO_REJECTED'',''CESSAO_APPROVED_BY_OWNER'',''CESSAO_CANCELLED'',''ROSTER_PUBLISHED'',''ROSTER_LOCKED'',''USER_CREATED'',''USER_UPDATED'',''USER_ROLE_CHANGED'',''SSO_JIT_LINK_CREATED'',''PUSH_DISPATCHED'',''CONFLICT_DETECTED'',''CONFLICT_OVERRIDDEN'',''SECTOR_SERVICE_SPECIALTIES_UPDATED'',''INSTITUTION_FEATURE_UPDATED'',''SWAP_EXPIRED'',''TRANSFER_EXPIRED'',''CESSAO_EXPIRED'') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL',
  'SELECT 1'
);
PREPARE swap_expiry_action_ddl_stmt FROM @swap_expiry_action_ddl;
EXECUTE swap_expiry_action_ddl_stmt;
DEALLOCATE PREPARE swap_expiry_action_ddl_stmt;

SET @swap_expiry_index_ddl := IF(
  @swap_expiry_index_rows = 0,
  'ALTER TABLE swap_requests ADD INDEX idx_swap_expiry_reoffer (institution_id, from_assignment_id, status, expires_at, id)',
  'SELECT 1'
);
PREPARE swap_expiry_index_ddl_stmt FROM @swap_expiry_index_ddl;
EXECUTE swap_expiry_index_ddl_stmt;
DEALLOCATE PREPARE swap_expiry_index_ddl_stmt;

SET @swap_expiry_postflight_matches := (
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'audit_trail'
     AND COLUMN_NAME = 'action'
     AND COLUMN_TYPE = @swap_expiry_action_after
     AND IS_NULLABLE = 'NO'
     AND COLUMN_DEFAULT IS NULL
     AND CHARACTER_SET_NAME = 'utf8mb4'
     AND COLLATION_NAME = 'utf8mb4_0900_ai_ci'
     AND COALESCE(EXTRA, '') = ''
     AND COALESCE(GENERATION_EXPRESSION, '') = ''
     AND COLUMN_COMMENT = '') = 1
  AND
  (SELECT COUNT(*) = 5 AND SUM(CASE
    WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id'
      AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
      AND IS_VISIBLE = 'YES' THEN 1
    WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'from_assignment_id'
      AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
      AND IS_VISIBLE = 'YES' THEN 1
    WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'status'
      AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
      AND IS_VISIBLE = 'YES' THEN 1
    WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'expires_at'
      AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
      AND IS_VISIBLE = 'YES' THEN 1
    WHEN NON_UNIQUE = 1 AND SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'id'
      AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE'
      AND IS_VISIBLE = 'YES' THEN 1
    ELSE 0 END) = 5
   FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'swap_requests'
     AND INDEX_NAME = 'idx_swap_expiry_reoffer')
);
SET @swap_expiry_postflight_guard := IF(
  @swap_expiry_postflight_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''[]'', ''$['')'
);
PREPARE swap_expiry_postflight_guard_stmt FROM @swap_expiry_postflight_guard;
EXECUTE swap_expiry_postflight_guard_stmt;
DEALLOCATE PREPARE swap_expiry_postflight_guard_stmt;
