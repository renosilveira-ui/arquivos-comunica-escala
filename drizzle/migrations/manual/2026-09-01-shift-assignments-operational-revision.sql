-- 2026-09-01 — revisão monotônica para fatos operacionais de assignment.
--
-- Aditiva e rerodável. Linhas legadas começam em 0; o primeiro writer que
-- emitir um fato avança a revisão dentro da mesma transação da mutação.

SET @shift_assignments_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_assignments_v2'
);

SET @shift_assignments_precondition := IF(
  @shift_assignments_exists = 1,
  'SELECT 1',
  'SELECT * FROM shift_assignments_v2 WHERE 1 = 0'
);
PREPARE shift_assignments_precondition_stmt FROM @shift_assignments_precondition;
EXECUTE shift_assignments_precondition_stmt;
DEALLOCATE PREPARE shift_assignments_precondition_stmt;

SET @operational_revision_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_assignments_v2'
    AND COLUMN_NAME = 'operational_revision'
);

-- Uma coluna homônima não comprova a semântica de revisão. Divergência não é
-- corrigida in-place: falha antes de qualquer ALTER para evitar reescrever
-- uma linha já usada por outro contrato operacional.
SET @operational_revision_contract_matches := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_assignments_v2'
    AND COLUMN_NAME = 'operational_revision'
    AND COLUMN_TYPE = 'int'
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT = '0'
);
SET @operational_revision_contract_precondition := IF(
  @operational_revision_exists = 0 OR @operational_revision_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM shift_assignments_operational_revision_contract_mismatch WHERE 1 = 0'
);
PREPARE operational_revision_contract_stmt FROM @operational_revision_contract_precondition;
EXECUTE operational_revision_contract_stmt;
DEALLOCATE PREPARE operational_revision_contract_stmt;

SET @ddl := IF(
  @operational_revision_exists = 0,
  'ALTER TABLE shift_assignments_v2 ADD COLUMN operational_revision INT NOT NULL DEFAULT 0 AFTER is_active',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
