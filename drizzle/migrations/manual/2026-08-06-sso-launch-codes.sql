-- Migração manual — staging DigitalOcean (banco `escalas`)
-- Frente: auto-login Comunica+ de ponta a ponta (PR feat/sso-auto-login-e2e)
--
-- Executar via node/mysql2 como as anteriores (mysql CLI não instalado):
--   DATABASE_URL='...' DATABASE_SSL=insecure pnpm tsx -e "<ver docs>"
-- ou colar os statements no console SQL do painel DigitalOcean.

-- 1. Dedupe do push de início de plantão
ALTER TABLE duty_confirmations
  ADD COLUMN start_push_sent_at TIMESTAMP NULL DEFAULT NULL;

-- 2. Códigos one-time do fluxo de launch SSO (mobile)
CREATE TABLE IF NOT EXISTS sso_launch_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(128) NOT NULL,
  user_id INT NOT NULL,
  institution_id INT NOT NULL,
  client_nonce VARCHAR(191) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY sso_launch_codes_code_unique (code),
  KEY idx_sso_launch_expires (expires_at),
  CONSTRAINT sso_launch_codes_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT sso_launch_codes_institution_id_institutions_id_fk
    FOREIGN KEY (institution_id) REFERENCES institutions (id)
);
