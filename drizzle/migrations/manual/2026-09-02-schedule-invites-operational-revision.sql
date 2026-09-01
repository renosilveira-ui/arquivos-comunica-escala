-- 2026-09-02 — revisão monotônica para fatos operacionais de convite.
--
-- Aditiva e rerodável. Não emite eventos, não cria entregas e não altera
-- convite algum além do default físico necessário para linhas legadas.
-- Uma coluna homônima divergente é bloqueadora: esta migration nunca tenta
-- reinterpretar ou sobrescrever uma revisão que não reconhece.

SET @schedule_invites_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
);

SET @schedule_invites_precondition := IF(
  @schedule_invites_exists = 1,
  'SELECT 1',
  'SELECT * FROM schedule_invites_operational_revision_requires_schedule_invites WHERE 1 = 0'
);
PREPARE schedule_invites_precondition_stmt FROM @schedule_invites_precondition;
EXECUTE schedule_invites_precondition_stmt;
DEALLOCATE PREPARE schedule_invites_precondition_stmt;

SET @operational_revision_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND COLUMN_NAME = 'operational_revision'
);

SET @operational_revision_contract_matches := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND COLUMN_NAME = 'operational_revision'
    AND COLUMN_TYPE = 'int'
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT = '0'
);
SET @operational_revision_contract_precondition := IF(
  @operational_revision_exists = 0
    OR @operational_revision_contract_matches = 1,
  'SELECT 1',
  'SELECT * FROM schedule_invites_operational_revision_contract_mismatch WHERE 1 = 0'
);
PREPARE operational_revision_contract_stmt FROM @operational_revision_contract_precondition;
EXECUTE operational_revision_contract_stmt;
DEALLOCATE PREPARE operational_revision_contract_stmt;

SET @ddl := IF(
  @operational_revision_exists = 0,
  'ALTER TABLE schedule_invites ADD COLUMN operational_revision INT NOT NULL DEFAULT 0 AFTER redeemed_count',
  'SELECT 1'
);
PREPARE operational_revision_stmt FROM @ddl;
EXECUTE operational_revision_stmt;
DEALLOCATE PREPARE operational_revision_stmt;
