-- Migração faltante detectada pelo smoke de trocas (2026-08-19):
-- o código usa type='CESSAO' (PR #59) mas o enum do staging só tinha
-- SWAP/TRANSFER — toda oferta de cessão falhava no INSERT.
-- Executada no staging DigitalOcean em 2026-08-19.
ALTER TABLE swap_requests MODIFY `type` ENUM('SWAP','TRANSFER','CESSAO') NOT NULL;
