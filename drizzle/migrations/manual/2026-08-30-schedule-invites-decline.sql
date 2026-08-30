-- 2026-08-30 — recusa explícita de convite nominal pelo profissional convidado.
-- Aditiva e rerodável. Não reutiliza revoked_at.

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND COLUMN_NAME = 'declined_at'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE schedule_invites ADD COLUMN declined_at TIMESTAMP NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND COLUMN_NAME = 'declined_by_user_id'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE schedule_invites ADD COLUMN declined_by_user_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND CONSTRAINT_NAME = 'fk_schedule_invites_declined_by_user'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE schedule_invites ADD CONSTRAINT fk_schedule_invites_declined_by_user FOREIGN KEY (declined_by_user_id) REFERENCES users(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
