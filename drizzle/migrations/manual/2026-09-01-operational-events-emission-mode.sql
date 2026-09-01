-- 2026-09-01 — modo imutável de emissão do ledger operacional.
--
-- Pré-requisito: 2026-08-31-operational-events-foundation.sql já aplicado.
-- Aditiva e rerodável: fatos legados recebem apenas o default seguro SHADOW.

SET @operational_events_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
);

-- Pré-requisito ausente interrompe o executor, sem marcar sucesso falso.
SET @foundation_precondition := IF(
  @operational_events_exists = 1,
  'SELECT 1',
  'SELECT * FROM operational_events WHERE 1 = 0'
);
PREPARE foundation_precondition_stmt FROM @foundation_precondition;
EXECUTE foundation_precondition_stmt;
DEALLOCATE PREPARE foundation_precondition_stmt;

SET @emission_mode_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
    AND COLUMN_NAME = 'emission_mode'
);

-- Uma coluna homônima não prova o contrato. Se já existir, a migration só
-- segue quando enum, nulabilidade e default correspondem exatamente ao fato
-- imutável esperado; ela nunca tenta corrigir/reescrever uma divergência.
SET @emission_mode_contract_matches := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
    AND COLUMN_NAME = 'emission_mode'
    AND COLUMN_TYPE = 'enum(''SHADOW'',''ACTIVE'')'
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT = 'SHADOW'
);
SET @emission_mode_contract_precondition := IF(
  @emission_mode_exists = 0 OR @emission_mode_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM operational_events_emission_mode_contract_mismatch WHERE 1 = 0'
);
PREPARE emission_mode_contract_stmt FROM @emission_mode_contract_precondition;
EXECUTE emission_mode_contract_stmt;
DEALLOCATE PREPARE emission_mode_contract_stmt;

SET @ddl := IF(
  @emission_mode_exists = 0,
  'ALTER TABLE operational_events ADD COLUMN emission_mode ENUM(''SHADOW'', ''ACTIVE'') NOT NULL DEFAULT ''SHADOW'' AFTER event_type',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
