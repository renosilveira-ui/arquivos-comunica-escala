-- Frente A3: redefinir senha (admin), "esqueci minha senha" e exclusão de conta.
-- Staging DigitalOcean, banco `escalas` — aplicar manualmente.

ALTER TABLE users
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL;

CREATE TABLE password_resets (
  id INT AUTO_INCREMENT NOT NULL,
  user_id INT NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT password_resets_id PRIMARY KEY (id),
  CONSTRAINT password_resets_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_password_resets_token_hash ON password_resets (token_hash);
