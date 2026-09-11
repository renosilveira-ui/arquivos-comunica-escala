-- 2026-09-12 — audit_trail.action: os 7 valores que o código grava e o banco recusa.
--
-- Diagnóstico (parecer de bancos, 12/09/2026): o schema Drizzle tem 36 ações;
-- o banco real tem 29. Faltam CESSAO_OFFERED, CESSAO_ACCEPTED, CESSAO_REJECTED,
-- CESSAO_APPROVED_BY_OWNER, CESSAO_CANCELLED, SWAP_APPROVED_BY_OWNER e
-- TRANSFER_APPROVED_BY_OWNER. `server/swap-domain.ts` grava todos eles, o
-- banco roda em STRICT_ALL_TABLES (valor fora do enum é ERRO, não aviso) e a
-- auditoria é transacional (`recordAudit` não tem modo best-effort). Efeito:
-- toda cessão e toda aprovação "pelo dono" de troca ou repasse falha inteira,
-- com rollback. Há um repasse ACEITO esperando exatamente essa aprovação.
--
-- Por que nunca apareceu: a CI monta o banco de teste a partir do schema
-- Drizzle (`drizzle-kit push`), que já tem os 36. Nenhum teste enxerga o banco
-- real. Esta migração fecha o buraco; o ledger de migrações e a checagem de
-- drift (itens 3 e 8 do plano) evitam a repetição.
--
-- A definição nova é a do schema, na ordem do schema, para o catálogo e o
-- Drizzle dizerem a mesma coisa. Reordenar membros de ENUM é seguro: o MySQL
-- converte pelo VALOR (texto), não pela posição.
--
-- ANSI_QUOTES está no sql_mode global do banco real: aspas duplas viram
-- identificador. Este arquivo usa só aspas simples.
--
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela inexistente —
-- o MySQL ecoa o nome e quem aplica lê qual guarda disparou.

-- ---------------------------------------------------------------------------
-- Preflight 1: a tabela e a coluna existem, e a coluna é ENUM
-- ---------------------------------------------------------------------------

SET @ate_present := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
    AND DATA_TYPE = 'enum'
);
SET @ddl := IF(
  @ate_present = 1,
  'SELECT 1',
  'SELECT 1 FROM `__audit_trail_action_enum_missing__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Preflight 2: manifesto lido do catálogo — nenhum valor ATUAL fora da lista
-- nova. Um valor desconhecido no banco seria perdido pelo MODIFY. Melhor
-- recusar antes de tocar em qualquer coisa.
-- ---------------------------------------------------------------------------

SET @ate_rest := (
  SELECT COLUMN_TYPE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
);
SET @ate_rest := REPLACE(@ate_rest, '''SHIFT_CREATED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SHIFT_UPDATED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SHIFT_DELETED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''ASSIGNMENT_CREATED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''ASSIGNMENT_REMOVED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''ASSIGNMENT_ASSUMED_VACANCY''', '');
SET @ate_rest := REPLACE(@ate_rest, '''ASSIGNMENT_APPROVED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''ASSIGNMENT_REJECTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SWAP_REQUESTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SWAP_ACCEPTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SWAP_REJECTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SWAP_APPROVED_BY_MANAGER''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SWAP_APPROVED_BY_OWNER''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SWAP_CANCELLED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''TRANSFER_OFFERED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''TRANSFER_ACCEPTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''TRANSFER_REJECTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''TRANSFER_APPROVED_BY_MANAGER''', '');
SET @ate_rest := REPLACE(@ate_rest, '''TRANSFER_APPROVED_BY_OWNER''', '');
SET @ate_rest := REPLACE(@ate_rest, '''TRANSFER_CANCELLED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''CESSAO_OFFERED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''CESSAO_ACCEPTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''CESSAO_REJECTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''CESSAO_APPROVED_BY_OWNER''', '');
SET @ate_rest := REPLACE(@ate_rest, '''CESSAO_CANCELLED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''ROSTER_PUBLISHED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''ROSTER_LOCKED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''USER_CREATED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''USER_UPDATED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''USER_ROLE_CHANGED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''INSTITUTION_FEATURE_UPDATED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SECTOR_SERVICE_SPECIALTIES_UPDATED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''SSO_JIT_LINK_CREATED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''PUSH_DISPATCHED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''CONFLICT_DETECTED''', '');
SET @ate_rest := REPLACE(@ate_rest, '''CONFLICT_OVERRIDDEN''', '');
SET @ate_rest := REPLACE(REPLACE(REPLACE(@ate_rest, 'enum(', ''), ')', ''), ',', '');
SET @ddl := IF(
  @ate_rest = '',
  'SELECT 1',
  'SELECT 1 FROM `__audit_trail_action_enum_unknown_value__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- A mudança
-- ---------------------------------------------------------------------------

ALTER TABLE audit_trail
  MODIFY COLUMN action ENUM('SHIFT_CREATED','SHIFT_UPDATED','SHIFT_DELETED','ASSIGNMENT_CREATED','ASSIGNMENT_REMOVED','ASSIGNMENT_ASSUMED_VACANCY','ASSIGNMENT_APPROVED','ASSIGNMENT_REJECTED','SWAP_REQUESTED','SWAP_ACCEPTED','SWAP_REJECTED','SWAP_APPROVED_BY_MANAGER','SWAP_APPROVED_BY_OWNER','SWAP_CANCELLED','TRANSFER_OFFERED','TRANSFER_ACCEPTED','TRANSFER_REJECTED','TRANSFER_APPROVED_BY_MANAGER','TRANSFER_APPROVED_BY_OWNER','TRANSFER_CANCELLED','CESSAO_OFFERED','CESSAO_ACCEPTED','CESSAO_REJECTED','CESSAO_APPROVED_BY_OWNER','CESSAO_CANCELLED','ROSTER_PUBLISHED','ROSTER_LOCKED','USER_CREATED','USER_UPDATED','USER_ROLE_CHANGED','INSTITUTION_FEATURE_UPDATED','SECTOR_SERVICE_SPECIALTIES_UPDATED','SSO_JIT_LINK_CREATED','PUSH_DISPATCHED','CONFLICT_DETECTED','CONFLICT_OVERRIDDEN') NOT NULL;

-- ---------------------------------------------------------------------------
-- Postflight: a definição no catálogo é exatamente a do schema
-- ---------------------------------------------------------------------------

SET @ate_after := (
  SELECT COLUMN_TYPE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'audit_trail'
    AND COLUMN_NAME = 'action'
);
SET @ddl := IF(
  @ate_after = 'enum(''SHIFT_CREATED'',''SHIFT_UPDATED'',''SHIFT_DELETED'',''ASSIGNMENT_CREATED'',''ASSIGNMENT_REMOVED'',''ASSIGNMENT_ASSUMED_VACANCY'',''ASSIGNMENT_APPROVED'',''ASSIGNMENT_REJECTED'',''SWAP_REQUESTED'',''SWAP_ACCEPTED'',''SWAP_REJECTED'',''SWAP_APPROVED_BY_MANAGER'',''SWAP_APPROVED_BY_OWNER'',''SWAP_CANCELLED'',''TRANSFER_OFFERED'',''TRANSFER_ACCEPTED'',''TRANSFER_REJECTED'',''TRANSFER_APPROVED_BY_MANAGER'',''TRANSFER_APPROVED_BY_OWNER'',''TRANSFER_CANCELLED'',''CESSAO_OFFERED'',''CESSAO_ACCEPTED'',''CESSAO_REJECTED'',''CESSAO_APPROVED_BY_OWNER'',''CESSAO_CANCELLED'',''ROSTER_PUBLISHED'',''ROSTER_LOCKED'',''USER_CREATED'',''USER_UPDATED'',''USER_ROLE_CHANGED'',''INSTITUTION_FEATURE_UPDATED'',''SECTOR_SERVICE_SPECIALTIES_UPDATED'',''SSO_JIT_LINK_CREATED'',''PUSH_DISPATCHED'',''CONFLICT_DETECTED'',''CONFLICT_OVERRIDDEN'')',
  'SELECT 1',
  'SELECT 1 FROM `__audit_trail_action_enum_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
