-- Frente: extender audit_trail.action enum com os valores de cessão e
-- aprovação por dono (PRs #59, #72) que estavam apenas no tipo TS, não
-- no schema do DB. Sem isso, recordAudit() lançava
-- ER_DATA_TRUNCATED no INSERT pra qualquer evento CESSAO_* ou
-- *_BY_OWNER e a falha era silenciada pelo try/catch — o trail dos
-- eventos de cessão ficava vazio.
--
-- ENUM widening é não-destrutivo (mesmo padrão de
-- 0004_modalidade_estruturada.sql): MODIFY COLUMN preserva os
-- índices internos dos valores já existentes e anexa os novos no
-- final, sem reescrita de linhas.

ALTER TABLE `audit_trail` MODIFY COLUMN `action` enum(
  'SHIFT_CREATED','SHIFT_UPDATED','SHIFT_DELETED',
  'ASSIGNMENT_CREATED','ASSIGNMENT_REMOVED','ASSIGNMENT_ASSUMED_VACANCY','ASSIGNMENT_APPROVED','ASSIGNMENT_REJECTED',
  'SWAP_REQUESTED','SWAP_ACCEPTED','SWAP_REJECTED','SWAP_APPROVED_BY_MANAGER','SWAP_APPROVED_BY_OWNER','SWAP_CANCELLED',
  'TRANSFER_OFFERED','TRANSFER_ACCEPTED','TRANSFER_REJECTED','TRANSFER_APPROVED_BY_MANAGER','TRANSFER_APPROVED_BY_OWNER','TRANSFER_CANCELLED',
  'CESSAO_OFFERED','CESSAO_ACCEPTED','CESSAO_REJECTED','CESSAO_APPROVED_BY_OWNER','CESSAO_CANCELLED',
  'ROSTER_PUBLISHED','ROSTER_LOCKED',
  'USER_CREATED','USER_UPDATED','USER_ROLE_CHANGED','SSO_JIT_LINK_CREATED','PUSH_DISPATCHED',
  'CONFLICT_DETECTED','CONFLICT_OVERRIDDEN'
) NOT NULL;
