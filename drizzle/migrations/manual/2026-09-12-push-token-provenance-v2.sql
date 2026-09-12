-- 2026-09-12 — push_tokens: proveniência do tenant e identidade do token (v2).
--
-- Substitui 2026-08-24-push-token-provenance.sql, que nunca foi aplicada no
-- banco real (18 dias sem ninguém ver — parecer de bancos, 12/09/2026) e não
-- era rerodável: `ADD UNIQUE INDEX` e `ADD CONSTRAINT` sem guarda falham na
-- segunda execução. Esta versão faz a mesma coisa, guardada passo a passo.
--
-- O que muda e por quê (contrato do schema Drizzle, `pushTokens`):
--   1. `institution_id` passa a aceitar NULL. O token pertence à conta e ao
--      aparelho; pode nascer antes da hidratação do tenant. Com NOT NULL em
--      modo estrito, o registro falhava e o app dizia "Não foi possível
--      registrar o token".
--   2. `token` passa a `utf8mb4_bin`: tokens do Expo são opacos e sensíveis a
--      maiúsculas; comparação binária governa UNIQUE, consultas e o SHA-256
--      do mutex distribuído.
--   3. UNIQUE `uniq_push_token (token)`: a proteção contra tokens duplicados
--      deixa de depender só do código.
--   4. CHECK `chk_push_token_no_whitespace`: token com espaço é lixo de
--      cliente, não dado.
--
-- Limpeza antes da UNIQUE (hoje: 18 tokens, 18 distintos, 0 com espaço — os
-- DELETEs não tocam em nada; ficam para um banco onde tocariam):
--   - token duplicado: fica a linha MAIS RECENTE (maior id) — o registro
--     mais novo é o dono atual do aparelho; a v1 apagava todas as cópias.
--   - token com espaço em branco: sai.
--
-- Janela: rodar num momento sem registro de token em curso. Sem LOCK TABLES
-- (incompatível com PREPARE sobre INFORMATION_SCHEMA); se uma duplicata
-- nascer entre o DELETE e o ADD UNIQUE, o ADD falha fechado e a migração é
-- só rerodar. Não promete atomicidade entre passos — cada passo é atômico e
-- rerodável.
--
-- Fora do hash da cerca de prontidão (cobertura de push_tokens: id, user_id).
-- ANSI_QUOTES: só aspas simples.
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela inexistente.

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------

SET @pt_shape := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'push_tokens'
    AND COLUMN_NAME IN ('id', 'institution_id', 'user_id', 'token', 'platform', 'created_at')
);
SET @ddl := IF(
  @pt_shape = 6,
  'SELECT 1',
  'SELECT 1 FROM `__push_tokens_shape_unexpected__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 1. institution_id aceita NULL
-- ---------------------------------------------------------------------------

SET @pt_inst_notnull := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'push_tokens'
    AND COLUMN_NAME = 'institution_id'
    AND IS_NULLABLE = 'NO'
);
SET @ddl := IF(
  @pt_inst_notnull = 1,
  'ALTER TABLE push_tokens MODIFY COLUMN institution_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. token em utf8mb4_bin
-- ---------------------------------------------------------------------------

SET @pt_token_ci := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'push_tokens'
    AND COLUMN_NAME = 'token'
    AND (COLLATION_NAME IS NULL OR COLLATION_NAME <> 'utf8mb4_bin')
);
SET @ddl := IF(
  @pt_token_ci = 1,
  'ALTER TABLE push_tokens MODIFY COLUMN token VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3. Limpeza de dados (só o que a UNIQUE e o CHECK recusariam)
--
-- DEPOIS da collation binária, de propósito: com a collation antiga
-- (case-insensitive) 'aaa' e 'AAA' contariam como o mesmo token e a
-- deduplicação apagaria um token legítimo — a v1 tinha exatamente esse
-- defeito, e o teste de prova o pegou.
-- ---------------------------------------------------------------------------

-- Duplicatas: fica o maior id por token.
DELETE older
FROM push_tokens AS older
INNER JOIN (
  SELECT token, MAX(id) AS keep_id
  FROM push_tokens
  GROUP BY token
  HAVING COUNT(*) > 1
) AS dup ON dup.token = older.token AND older.id <> dup.keep_id;

-- Token com espaço em branco não é token.
DELETE FROM push_tokens
WHERE token REGEXP '[[:space:]]';

-- ---------------------------------------------------------------------------
-- 4. UNIQUE do token
-- ---------------------------------------------------------------------------

SET @pt_uniq := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'push_tokens'
    AND INDEX_NAME = 'uniq_push_token'
);
SET @ddl := IF(
  @pt_uniq = 0,
  'ALTER TABLE push_tokens ADD UNIQUE INDEX uniq_push_token (token)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 5. CHECK sem espaço em branco
-- ---------------------------------------------------------------------------

SET @pt_chk := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'push_tokens'
    AND CONSTRAINT_TYPE = 'CHECK'
    AND CONSTRAINT_NAME = 'chk_push_token_no_whitespace'
);
SET @ddl := IF(
  @pt_chk = 0,
  'ALTER TABLE push_tokens ADD CONSTRAINT chk_push_token_no_whitespace CHECK (token NOT REGEXP ''[[:space:]]'')',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Postflight estrutural
-- ---------------------------------------------------------------------------

SET @pt_after := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'push_tokens'
    AND (
      (COLUMN_NAME = 'institution_id' AND IS_NULLABLE = 'YES')
      OR (COLUMN_NAME = 'token' AND COLLATION_NAME = 'utf8mb4_bin' AND IS_NULLABLE = 'NO')
    )
) + (
  SELECT COUNT(DISTINCT INDEX_NAME)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'push_tokens'
    AND INDEX_NAME = 'uniq_push_token'
    AND NON_UNIQUE = 0
) + (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'push_tokens'
    AND CONSTRAINT_TYPE = 'CHECK'
    AND CONSTRAINT_NAME = 'chk_push_token_no_whitespace'
);
SET @ddl := IF(
  @pt_after = 4,
  'SELECT 1',
  'SELECT 1 FROM `__push_tokens_contract_mismatch__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
