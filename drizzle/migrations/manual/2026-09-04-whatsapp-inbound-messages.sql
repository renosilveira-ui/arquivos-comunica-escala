-- 2026-09-04 — inbound técnico WhatsApp (fila assíncrona + payload operacional).
-- Aditiva e rerodável (CREATE TABLE IF NOT EXISTS). Aplicar no staging
-- ANTES do merge. O deploy NÃO aplica migration.
--
-- Invariantes:
--   * UNIQUE (provider, provider_message_id) é a chave de replay (Twilio MessageSid);
--   * user_id nullable — IDENTITY_NOT_FOUND não inventa usuário;
--   * READY_FOR_* = material operacional suficiente para o próximo estágio;
--   * payload operacional é temporário (TTL + limpeza após consumo);
--   * sem dump Twilio, signature, Authorization, Auth Token ou telefone;
--   * sem tabela whatsapp_pending_intents (contrato JSON ainda não travado).
--
-- Estados:
--   incompletos / retomáveis: RECEIVED, IDENTIFIED, RETRYABLE
--   terminais: IDENTITY_NOT_FOUND, IDENTITY_CONFLICT, UNSUPPORTED,
--              READY_FOR_NL, READY_FOR_TRANSCRIPTION

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
    'RETRYABLE',
    'IDENTITY_NOT_FOUND',
    'IDENTITY_CONFLICT',
    'UNSUPPORTED',
    'READY_FOR_NL',
    'READY_FOR_TRANSCRIPTION'
  ) NOT NULL,
  error_code VARCHAR(64) NULL DEFAULT NULL,
  sender_address_hash CHAR(16) NULL DEFAULT NULL,
  operational_text TEXT NULL DEFAULT NULL,
  media_url VARCHAR(768) NULL DEFAULT NULL,
  media_mime VARCHAR(64) NULL DEFAULT NULL,
  payload_expires_at TIMESTAMP NULL DEFAULT NULL,
  payload_cleared_at TIMESTAMP NULL DEFAULT NULL,
  received_at TIMESTAMP NOT NULL,
  processed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_whatsapp_inbound_provider_message (provider, provider_message_id),
  KEY idx_whatsapp_inbound_user (user_id),
  KEY idx_whatsapp_inbound_received (received_at),
  KEY idx_whatsapp_inbound_payload_expires (payload_expires_at),
  CONSTRAINT fk_whatsapp_inbound_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL
);
