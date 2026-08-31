-- 2026-09-01 — modo imutável de emissão do ledger operacional.
--
-- Pré-requisito: 2026-08-31-operational-events-foundation.sql já aplicado.
-- A data posterior torna a dependência explícita para executores que ordenam
-- migrations lexicograficamente. Aditiva e rerodável: não remove,
-- sobrescreve ou reclassifica fatos existentes. Linhas legadas, se houver,
-- recebem somente o default seguro SHADOW no momento em que a coluna é criada.

SET @operational_events_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
);

-- Não trate pré-requisito ausente como sucesso/no-op: um executor que marque
-- esta migration sem a tabela-base deixaria o writer incompatível em runtime.
-- A leitura deliberada da tabela inexistente interrompe a transação/runner sem
-- alterar dados; com a fundação presente ela é um SELECT inofensivo.
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

SET @ddl := IF(
  @emission_mode_exists = 0,
  'ALTER TABLE operational_events ADD COLUMN emission_mode ENUM(''SHADOW'', ''ACTIVE'') NOT NULL DEFAULT ''SHADOW'' AFTER event_type',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
