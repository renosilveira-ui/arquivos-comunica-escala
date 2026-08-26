-- 2026-08-26 — convite nominal (usuário + e-mail, 24 h, uso único).
-- Aditiva e rerodável. Encerra convites compartilhados ainda abertos.
-- Não apaga histórico.

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND COLUMN_NAME = 'invited_user_id'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE schedule_invites ADD COLUMN invited_user_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND COLUMN_NAME = 'invited_email'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE schedule_invites ADD COLUMN invited_email VARCHAR(320) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE schedule_invites
  ALTER COLUMN max_redemptions SET DEFAULT 1;

UPDATE schedule_invites
SET revoked_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL
  AND invited_user_id IS NULL;

SET @fk_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND CONSTRAINT_NAME = 'fk_schedule_invite_invited_user'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE schedule_invites ADD CONSTRAINT fk_schedule_invite_invited_user FOREIGN KEY (invited_user_id) REFERENCES users(id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND INDEX_NAME = 'idx_schedule_invite_named'
);
SET @ddl := IF(
  @idx_exists = 0,
  'CREATE INDEX idx_schedule_invite_named ON schedule_invites (institution_id, hospital_id, sector_id, invited_user_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
