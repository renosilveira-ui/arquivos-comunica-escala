-- Auto-cadastro com aprovação (branch feat/self-signup)
-- Staging DigitalOcean, banco `escalas`:
ALTER TABLE users
  ADD COLUMN approval_status ENUM('PENDING','APPROVED') NOT NULL DEFAULT 'APPROVED';
