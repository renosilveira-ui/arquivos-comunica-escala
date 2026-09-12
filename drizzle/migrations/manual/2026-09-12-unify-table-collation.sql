-- 2026-09-12 — uma collation só no banco.
--
-- Achado do segundo parecer de bancos, validado por mim: 10 tabelas criadas
-- por migrações manuais estão em `utf8mb4_unicode_ci`; as outras 49 e o
-- schema Drizzle estão em `utf8mb4_0900_ai_ci` (o padrão do servidor).
--
-- Por que fere: um JOIN, UNION ou comparação entre colunas de texto das duas
-- famílias devolve o erro 1267, "Illegal mix of collations". Hoje as junções
-- entre esses grupos são por inteiro, então o risco é latente — mas é o tipo
-- de bomba que estoura na primeira consulta nova, em produção, num relatório
-- que ninguém testou.
--
-- Por que a checagem de drift não via: `scripts/schema-drift-core.ts`
-- normalizava collation para apenas "binária ou não", de propósito, para
-- acomodar exatamente esta divergência. Esta migração remove a divergência;
-- a mesma PR aperta a checagem, para não poder voltar escondida.
--
-- O QUE NÃO PODE SER PERDIDO: `departure_plans.dedup_key` é
-- `utf8mb4_bin` DE PROPÓSITO — chave de deduplicação tem de distinguir
-- maiúscula de minúscula, pela mesma razão do token de push. Um
-- `CONVERT TO CHARACTER SET` em bloco sobrescreve collation de coluna e
-- apagaria essa escolha em silêncio, transformando a chave em
-- case-insensitive. Por isso a coluna é restaurada logo após a conversão, e
-- o postflight confere. O schema Drizzle já a declara `binaryVarchar`.
--
-- Conferido antes de escrever: nenhuma FK sobre coluna de texto no banco
-- (conversão não pode quebrar referência), e as 10 tabelas somam ~260 linhas.
--
-- ANSI_QUOTES: só aspas simples. Rerodável: a segunda execução não encontra
-- tabela em `utf8mb4_unicode_ci` e não faz nada.
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\``.

-- ---------------------------------------------------------------------------
-- Conversão, tabela a tabela e guardada
-- ---------------------------------------------------------------------------

-- departure_plans
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'departure_plans'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE departure_plans CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- duty_confirmations
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'duty_confirmations'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE duty_confirmations CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- external_calendar_event_links
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'external_calendar_event_links'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE external_calendar_event_links CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- google_oauth_states
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'google_oauth_states'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE google_oauth_states CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- manual_migration_ledger
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'manual_migration_ledger'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE manual_migration_ledger CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- personal_calendar_external_links
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'personal_calendar_external_links'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE personal_calendar_external_links CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- personal_calendar_import_cursors
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'personal_calendar_import_cursors'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE personal_calendar_import_cursors CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- user_departure_preferences
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_departure_preferences'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE user_departure_preferences CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- user_external_credentials
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_external_credentials'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE user_external_credentials CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- user_travel_origins
SET @conv := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_travel_origins'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @conv = 1,
  'ALTER TABLE user_travel_origins CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Restaura a collation binária que a conversão em bloco sobrescreve
-- ---------------------------------------------------------------------------

SET @dedup_bin := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'departure_plans'
    AND COLUMN_NAME = 'dedup_key'
    AND COLLATION_NAME = 'utf8mb4_bin'
);
SET @dedup_existe := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'departure_plans'
    AND COLUMN_NAME = 'dedup_key'
);
SET @ddl := IF(
  @dedup_existe = 1 AND @dedup_bin = 0,
  'ALTER TABLE departure_plans MODIFY dedup_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------

-- Nenhuma tabela pode ter sobrado na família antiga. A checagem é do banco
-- INTEIRO, não da lista acima: se outra migração criar uma tabela em
-- utf8mb4_unicode_ci, esta migração passa a recusar.
SET @restantes := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE = 'BASE TABLE'
    AND TABLE_COLLATION = 'utf8mb4_unicode_ci'
);
SET @ddl := IF(
  @restantes = 0,
  'SELECT 1',
  'SELECT 1 FROM `__tabela_em_utf8mb4_unicode_ci_restante__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A chave de deduplicação continua distinguindo maiúscula de minúscula.
SET @dedup_final := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'departure_plans'
    AND COLUMN_NAME = 'dedup_key'
    AND COLLATION_NAME = 'utf8mb4_bin'
);
SET @ddl := IF(
  @dedup_final = 1,
  'SELECT 1',
  'SELECT 1 FROM `__dedup_key_perdeu_a_collation_binaria__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
