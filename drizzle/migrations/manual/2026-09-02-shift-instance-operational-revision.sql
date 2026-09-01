-- 2026-09-02 — versão operacional canônica de shift_instances.
--
-- Aditiva e reexecutável. Não reescreve turnos existentes: o DEFAULT do ALTER
-- inicializa o contador em 0 e qualquer contrato homônimo divergente falha
-- fechado antes de executar DDL.

SET @shift_instances_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
);

SET @shift_instances_precondition := IF(
  @shift_instances_exists = 1,
  'SELECT 1',
  'SELECT * FROM shift_instances WHERE 1 = 0'
);
PREPARE shift_instances_precondition_stmt FROM @shift_instances_precondition;
EXECUTE shift_instances_precondition_stmt;
DEALLOCATE PREPARE shift_instances_precondition_stmt;

SET @operational_revision_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'operational_revision'
);

-- Uma coluna homônima só é aceita se já representar o contador seguro.
-- A migration não tenta corrigir, converter ou sobrescrever um contrato
-- divergente, pois isso poderia inventar uma versão para eventos futuros.
SET @operational_revision_contract_matches := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'operational_revision'
    AND DATA_TYPE = 'int'
    AND IS_NULLABLE = 'NO'
    AND CAST(COLUMN_DEFAULT AS CHAR) = '0'
    AND EXTRA = ''
);
SET @operational_revision_contract_precondition := IF(
  @operational_revision_exists = 0
    OR @operational_revision_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM shift_instances_operational_revision_contract_mismatch WHERE 1 = 0'
);
PREPARE operational_revision_contract_stmt FROM @operational_revision_contract_precondition;
EXECUTE operational_revision_contract_stmt;
DEALLOCATE PREPARE operational_revision_contract_stmt;

SET @ddl := IF(
  @operational_revision_exists = 0,
  'ALTER TABLE shift_instances ADD COLUMN operational_revision INT NOT NULL DEFAULT 0 AFTER status',
  'SELECT 1'
);
PREPARE shift_instance_operational_revision_stmt FROM @ddl;
EXECUTE shift_instance_operational_revision_stmt;
DEALLOCATE PREPARE shift_instance_operational_revision_stmt;
