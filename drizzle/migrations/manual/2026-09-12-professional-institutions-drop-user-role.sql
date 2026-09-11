-- 2026-09-12 — remove a coluna morta professional_institutions.user_role.
--
-- Parecer de bancos (12/09/2026): a coluna existe no banco real e não existe
-- no schema Drizzle. Foi substituída por `role_in_institution` em 27/08
-- (2026-08-27-professional-institutions-role.sql) e nada no servidor a lê —
-- o Drizzle nem a conhece. Em 6 de 70 vínculos as duas dizem coisas
-- diferentes. Hoje é lixo; amanhã é armadilha para quem consultar o banco
-- na mão e escolher a coluna errada. A canônica é `role_in_institution`
-- (fonte de autorização institucional desde a Frente 1); as 6 divergências
-- são histórico da coluna antiga, não dado a reconciliar.
--
-- Fora do hash da cerca de prontidão: a cobertura de professional_institutions
-- lista colunas nomeadas (id, institution_id, professional_id, user_id,
-- role_in_institution, active) — `user_role` não está nela. Os triggers da
-- cerca sobre esta tabela não a referenciam (conferido no catálogo real; o
-- preflight abaixo reconfere). O nome desses triggers não aparece aqui de
-- propósito: o executor genérico recusa qualquer arquivo que o cite.
--
-- ANSI_QUOTES: só aspas simples. Rerodável: sem a coluna, não faz nada.
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela inexistente.

-- ---------------------------------------------------------------------------
-- Preflight: a canônica precisa existir antes de a antiga sair
-- ---------------------------------------------------------------------------

SET @pi_canonical := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_institutions'
    AND COLUMN_NAME = 'role_in_institution'
);
SET @ddl := IF(
  @pi_canonical = 1,
  'SELECT 1',
  'SELECT 1 FROM `__professional_institutions_role_in_institution_missing__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Nenhum trigger ou view pode depender da coluna que vai sair.
SET @pi_dependents := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND ACTION_STATEMENT LIKE '%user_role%'
    AND EVENT_OBJECT_TABLE = 'professional_institutions'
) + (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.VIEWS
  WHERE TABLE_SCHEMA = DATABASE()
    AND VIEW_DEFINITION LIKE '%user_role%'
);
SET @ddl := IF(
  @pi_dependents = 0,
  'SELECT 1',
  'SELECT 1 FROM `__professional_institutions_user_role_still_referenced__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- A mudança (só se a coluna ainda existir)
-- ---------------------------------------------------------------------------

SET @pi_legacy := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_institutions'
    AND COLUMN_NAME = 'user_role'
);
SET @ddl := IF(
  @pi_legacy = 1,
  'ALTER TABLE professional_institutions DROP COLUMN user_role',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Postflight: a antiga saiu, a canônica ficou
-- ---------------------------------------------------------------------------

SET @pi_after := (
  SELECT SUM(COLUMN_NAME = 'role_in_institution') - SUM(COLUMN_NAME = 'user_role')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_institutions'
    AND COLUMN_NAME IN ('role_in_institution', 'user_role')
);
SET @ddl := IF(
  @pi_after = 1,
  'SELECT 1',
  'SELECT 1 FROM `__professional_institutions_user_role_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
