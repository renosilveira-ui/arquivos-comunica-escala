-- 2026-09-04 — conversa/intenção WhatsApp pendente (Incremento B1).
-- Aditiva e rerodável (CREATE TABLE IF NOT EXISTS).
-- NÃO aplicar no staging nesta PR. Após revisão, aplicar no staging
-- ANTES do merge. O deploy NÃO aplica migration.
--
-- Invariantes:
--   * pending NÃO é autoridade de acesso, elegibilidade ou swap;
--   * UNIQUE (source_inbound_message_id) — uma mensagem → no máximo um pending;
--   * UNIQUE (user_id, open_slot) — no máximo um OPEN por usuário;
--   * institution_id nullable; nunca nasce de texto/webhook;
--   * parsed_payload só slots semânticos (sem IDs internos / telefone / Body);
--   * sem token público; ownership é user_id.
--
-- status (ciclo de vida) × stage (progresso):
--   OPEN | CANCELLED | EXPIRED | CONSUMED
--   PARSE | CLARIFICATION | CONFIRMATION | EXECUTION
-- CONFIRMED não é status: confirmação continua a mesma conversa OPEN.

CREATE TABLE IF NOT EXISTS whatsapp_pending_intents (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  source_inbound_message_id INT NOT NULL,
  institution_id INT NULL DEFAULT NULL,
  status ENUM('OPEN', 'CANCELLED', 'EXPIRED', 'CONSUMED') NOT NULL,
  stage ENUM('PARSE', 'CLARIFICATION', 'CONFIRMATION', 'EXECUTION') NOT NULL,
  intent_kind ENUM('SWAP', 'CESSAO') NULL DEFAULT NULL,
  parsed_payload JSON NULL DEFAULT NULL,
  resolved_payload JSON NULL DEFAULT NULL,
  clarification_payload JSON NULL DEFAULT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP NULL DEFAULT NULL,
  payload_cleared_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  open_slot TINYINT GENERATED ALWAYS AS (
    IF(`status` = 'OPEN', 1, NULL)
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_whatsapp_pending_source (source_inbound_message_id),
  UNIQUE KEY uniq_whatsapp_pending_open_user (user_id, open_slot),
  KEY idx_whatsapp_pending_user (user_id),
  KEY idx_whatsapp_pending_expires (expires_at),
  CONSTRAINT fk_whatsapp_pending_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_whatsapp_pending_source
    FOREIGN KEY (source_inbound_message_id) REFERENCES whatsapp_inbound_messages(id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_whatsapp_pending_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
