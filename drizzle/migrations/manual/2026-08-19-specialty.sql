-- Separação por serviço/especialidade (feat/especialidades)
-- Executada no staging DigitalOcean em 2026-08-19.
ALTER TABLE professionals ADD COLUMN specialty VARCHAR(100) NULL;
ALTER TABLE shift_instances ADD COLUMN specialty VARCHAR(100) NULL;
-- Backfill: anestesistas do São Carlos + escala de agosto
-- (UPDATEs executados via script, registrados aqui por completude)
