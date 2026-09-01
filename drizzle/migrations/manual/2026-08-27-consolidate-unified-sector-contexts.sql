-- 2026-08-27 — retirada de uso: esta migração não pode mais consolidar
-- contextos por SQL genérico.
--
-- A versão original escolhia MIN(id) como destino e atualizava/desativava
-- contextos sem provar que havia uma única escala ativa, allowlist coerente
-- ou que todos os turnos permaneceriam estruturalmente válidos. Isso pode
-- apontar um plantão para a escala errada.
--
-- Use o provisionador transacional e idempotente:
--   HSC_PROVISION_CONFIRM=SAO_CARLOS_MULTISETOR \
--     pnpm provision:sao-carlos -- --apply
--
-- Ele recusa topologia ambígua, exige uma escala unificada ativa e verifica
-- seus metadados antes de remapear plantões. A falha abaixo é intencional para
-- impedir a execução acidental deste arquivo legado.

SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'MIGRACAO_SCHEDULE_CONTEXT_LEGADA_BLOQUEADA: use provision:sao-carlos transacional';
