-- 2026-09-02 — uma única escala operacional ativa por setor.
-- Aditiva e rerodável. O UNIQUE falha fechado se ainda houver duplicidades:
-- primeiro execute o provisionador corporativo correspondente e valide o
-- readiness; nunca escolha um contexto arbitrário durante esta migration.

SET @active_slot_exists := (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_contexts'
     AND COLUMN_NAME = 'active_sector_slot'
);
SET @ddl := IF(
  @active_slot_exists = 0,
  'ALTER TABLE schedule_contexts ADD COLUMN active_sector_slot TINYINT GENERATED ALWAYS AS (IF(`active` = 1, 1, NULL)) STORED',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @active_sector_unique_exists := (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_contexts'
     AND INDEX_NAME = 'uniq_schedule_context_active_sector'
);
SET @ddl := IF(
  @active_sector_unique_exists = 0,
  'ALTER TABLE schedule_contexts ADD UNIQUE KEY uniq_schedule_context_active_sector (institution_id, hospital_id, sector_id, active_sector_slot)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
