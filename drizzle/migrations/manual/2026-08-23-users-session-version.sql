-- 2026-08-23 — versão de sessão por usuário (auditoria 22/08, achado B3).
-- O JWT de sessão passa a carregar `sv`; trocar/redefinir a senha incrementa
-- users.session_version e todas as sessões anteriores são rejeitadas.
--
-- Aplicar no staging ANTES do merge do PR (o deploy não roda migrações):
--   DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" node ~/Downloads/aplicar-migracao-escala.js
--
-- Idempotente: só adiciona a coluna se ela não existir.
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'session_version'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE users ADD COLUMN session_version INT NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
