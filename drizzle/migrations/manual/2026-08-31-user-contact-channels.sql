-- 2026-08-31 — canais de contato do usuário (WhatsApp E.164 canônico).
-- Aditiva e rerodável. Aplicar no staging ANTES do merge.
--
-- Invariantes:
--   * um canal WHATSAPP por usuário (UNIQUE user_id + channel);
--   * E.164 ativo não pode pertencer a dois usuários
--     (coluna gerada active_normalized_address + UNIQUE);
--   * alteração de número limpa verified_at no domínio (não no DDL);
--   * sem OTP próprio — verificação futura via Twilio Verify.

CREATE TABLE IF NOT EXISTS user_contact_channels (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  channel ENUM('WHATSAPP') NOT NULL,
  address VARCHAR(32) NOT NULL,
  normalized_address VARCHAR(20) NOT NULL,
  verified_at TIMESTAMP NULL DEFAULT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  active_normalized_address VARCHAR(20)
    GENERATED ALWAYS AS (
      IF(`active` = 1, `normalized_address`, NULL)
    ) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_contact_channel (user_id, channel),
  UNIQUE KEY uniq_contact_channel_active_address (channel, active_normalized_address),
  KEY idx_user_contact_channels_user (user_id),
  CONSTRAINT fk_user_contact_channels_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
);
