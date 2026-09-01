-- 2026-09-02 — trilha atômica de requeue de entregas operacionais.
--
-- Pré-requisito: foundation de eventos + emission_mode. A mudança é somente
-- aditiva: não cria emissor, provider, cron ou envio. O registro guarda IDs
-- e contadores, nunca destinatário, e-mail, token, corpo ou PHI.

SET @operational_events_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
);
SET @notification_deliveries_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'notification_deliveries'
);

-- Falha explicitamente se a foundation não estiver presente; não marca uma
-- migration incompleta como concluída.
SET @foundation_precondition := IF(
  @operational_events_exists = 1 AND @notification_deliveries_exists = 1,
  'SELECT 1',
  IF(
    @operational_events_exists = 0,
    'SELECT * FROM operational_events WHERE 1 = 0',
    'SELECT * FROM notification_deliveries WHERE 1 = 0'
  )
);
PREPARE foundation_precondition_stmt FROM @foundation_precondition;
EXECUTE foundation_precondition_stmt;
DEALLOCATE PREPARE foundation_precondition_stmt;

-- Uma tabela homônima não prova o contrato. Antes do CREATE IF NOT EXISTS,
-- confirme coluna, enum, nulabilidade, chaves e FK mínima; divergência é
-- parada, nunca correção implícita de estrutura já existente.
SET @requeue_audit_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_delivery_requeue_audits'
);
SET @requeue_audit_engine_matches := (
  SELECT COUNT(*) = 1
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_delivery_requeue_audits'
    AND UPPER(ENGINE) = 'INNODB'
);
SET @requeue_audit_column_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_delivery_requeue_audits'
);
SET @requeue_audit_columns_match := (
  SELECT COUNT(*) = 8
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_delivery_requeue_audits'
    AND (
      (COLUMN_NAME = 'id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND EXTRA LIKE '%auto_increment%'
        AND COLUMN_DEFAULT IS NULL)
      OR
      (COLUMN_NAME = 'notification_delivery_id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL)
      OR
      (COLUMN_NAME = 'operational_event_id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL)
      OR
      (COLUMN_NAME = 'institution_id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL)
      OR
      (COLUMN_NAME = 'actor_user_id'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL)
      OR
      (COLUMN_NAME = 'actor_role'
        AND COLUMN_TYPE = 'enum(''GESTOR_MEDICO'',''GESTOR_PLUS'',''GLOBAL_ADMIN'')'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL)
      OR
      (COLUMN_NAME = 'previous_attempt_count'
        AND DATA_TYPE = 'int'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL)
      OR
      (COLUMN_NAME = 'created_at'
        AND DATA_TYPE = 'datetime'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IS NULL)
    )
);
SET @requeue_audit_primary_key_matches := (
  SELECT COUNT(*) = 1
  FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'operational_delivery_requeue_audits'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME, NON_UNIQUE
    HAVING NON_UNIQUE = 0
      AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'id'
  ) AS matching_primary_key
);
SET @requeue_audit_indexes_match := (
  SELECT COUNT(*) = 2
  FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'operational_delivery_requeue_audits'
      AND INDEX_NAME IN (
        'idx_operational_delivery_requeue_audit_delivery',
        'idx_operational_delivery_requeue_audit_institution'
      )
    GROUP BY INDEX_NAME, NON_UNIQUE
    HAVING (
      INDEX_NAME = 'idx_operational_delivery_requeue_audit_delivery'
      AND NON_UNIQUE = 1
      AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'notification_delivery_id,id'
    ) OR (
      INDEX_NAME = 'idx_operational_delivery_requeue_audit_institution'
      AND NON_UNIQUE = 1
      AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'institution_id,id'
    )
  ) AS matching_indexes
);
SET @requeue_audit_total_index_count := (
  SELECT COUNT(DISTINCT INDEX_NAME)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_delivery_requeue_audits'
);
SET @requeue_audit_foreign_key_matches := (
  SELECT COUNT(*) = 1
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_delivery_requeue_audits'
    AND CONSTRAINT_NAME = 'fk_operational_delivery_requeue_audit_institution'
    AND COLUMN_NAME = 'institution_id'
    AND REFERENCED_TABLE_NAME = 'institutions'
    AND REFERENCED_COLUMN_NAME = 'id'
);
SET @requeue_audit_total_foreign_key_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_delivery_requeue_audits'
    AND REFERENCED_TABLE_NAME IS NOT NULL
);
SET @requeue_audit_contract_matches := (
  @requeue_audit_engine_matches = 1
  AND @requeue_audit_column_count = 8
  AND @requeue_audit_columns_match = 1
  AND @requeue_audit_primary_key_matches = 1
  AND @requeue_audit_indexes_match = 1
  AND @requeue_audit_total_index_count = 3
  AND @requeue_audit_foreign_key_matches = 1
  AND @requeue_audit_total_foreign_key_count = 1
);
SET @requeue_audit_contract_precondition := IF(
  @requeue_audit_exists = 0 OR @requeue_audit_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM operational_delivery_requeue_audit_contract_mismatch WHERE 1 = 0'
);
PREPARE requeue_audit_contract_stmt FROM @requeue_audit_contract_precondition;
EXECUTE requeue_audit_contract_stmt;
DEALLOCATE PREPARE requeue_audit_contract_stmt;

CREATE TABLE IF NOT EXISTS operational_delivery_requeue_audits (
  id INT NOT NULL AUTO_INCREMENT,
  notification_delivery_id INT NOT NULL,
  operational_event_id INT NOT NULL,
  institution_id INT NOT NULL,
  actor_user_id INT NOT NULL,
  actor_role ENUM('GESTOR_MEDICO', 'GESTOR_PLUS', 'GLOBAL_ADMIN') NOT NULL,
  previous_attempt_count INT NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_operational_delivery_requeue_audit_delivery (notification_delivery_id, id),
  KEY idx_operational_delivery_requeue_audit_institution (institution_id, id),
  CONSTRAINT fk_operational_delivery_requeue_audit_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id)
) ENGINE=InnoDB;

-- Não há FK para delivery/event/user: a trilha precisa sobreviver à cascata
-- legítima de limpeza do ledger e a conta pode sofrer soft-delete.
