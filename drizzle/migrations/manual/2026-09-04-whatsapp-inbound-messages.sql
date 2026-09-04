-- 2026-09-04 — inbound técnico WhatsApp (idempotência + auditoria mínima).
-- Aditiva e rerodável. Aplicar no staging ANTES do merge, após revisão
-- do schema e autorização operacional. O deploy NÃO aplica migration.
--
-- Invariantes:
--   * UNIQUE (provider, provider_message_id) é a chave de replay (Twilio MessageSid);
--   * user_id nullable — IDENTITY_NOT_FOUND não inventa usuário;
--   * sem Body, telefone, signature, Authorization ou payload Twilio cru;
--   * sem tabela whatsapp_pending_intents (contrato JSON ainda não travado).

CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
  id INT NOT NULL AUTO_INCREMENT,
  provider ENUM('TWILIO') NOT NULL,
  provider_message_id VARCHAR(64) NOT NULL,
  user_id INT NULL DEFAULT NULL,
  content_kind ENUM('TEXT', 'AUDIO', 'UNSUPPORTED_MEDIA') NOT NULL,
  forwarded TINYINT(1) NOT NULL DEFAULT 0,
  processing_status ENUM(
    'RECEIVED',
    'IDENTIFIED',
    'IDENTITY_NOT_FOUND',
    'IDENTITY_CONFLICT',
    'UNSUPPORTED',
    'READY_FOR_NL',
    'READY_FOR_TRANSCRIPTION',
    'FAILED'
  ) NOT NULL,
  error_code VARCHAR(64) NULL DEFAULT NULL,
  sender_address_hash CHAR(16) NULL DEFAULT NULL,
  received_at TIMESTAMP NOT NULL,
  processed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_whatsapp_inbound_provider_message (provider, provider_message_id),
  KEY idx_whatsapp_inbound_user (user_id),
  KEY idx_whatsapp_inbound_received (received_at),
  CONSTRAINT fk_whatsapp_inbound_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL
);
