-- 2026-09-06 — fundação de identidade profissional (PR 1).
--
-- Adiciona profession_code e custom_profession_name em professionals.
-- VARCHAR, não ENUM MySQL: o catálogo vive em lib/profession-definitions.ts
-- e pode crescer sem redesenhar AuthZ.
--
-- NÃO cria UNIQUE(user_id): a cardinalidade user↔professional permanece
-- UNPROVEN.
--
-- Backfill histórico: SOMENTE professionals.role, labels inequívocos já
-- usados pelo produto. users.role NÃO é fonte de identidade (leftover
-- global/AuthZ, default doctor). Gestão não é profissão. "Técnico" isolado
-- não é técnico de enfermagem. UNKNOWN/vazio/NULL permanecem NULL.
-- Nunca classifica OTHER.
--
-- Homônimo incompatível (tipo, nulidade, default, generated ou índice)
-- aborta com JSON inválido — não coage, não redimensiona nem faz backfill.
--
-- Aplicar no staging ANTES do merge (o deploy não roda migrações):
--   pnpm apply:migration drizzle/migrations/manual/2026-09-06-professional-identity-foundation.sql
--
-- Idempotente: INFORMATION_SCHEMA antes de ALTER; backfill só preenche NULL.

-- ---------------------------------------------------------------------------
-- Preflight: todas as inspeções ANTES de qualquer ALTER/UPDATE.
-- ---------------------------------------------------------------------------

SET @profession_code_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'profession_code'
);
SET @profession_code_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE
        WHEN DATA_TYPE = 'varchar'
          AND CHARACTER_MAXIMUM_LENGTH = 64
          AND IS_NULLABLE = 'YES'
          AND COLUMN_DEFAULT IS NULL
          AND IFNULL(GENERATION_EXPRESSION, '') = ''
          AND EXTRA NOT LIKE '%GENERATED%'
        THEN 1 ELSE 0
      END
    ) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'profession_code'
);
SET @ddl := IF(
  @profession_code_exists = 0 OR @profession_code_contract_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''PROFESSIONAL_IDENTITY_PROFESSION_CODE_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @custom_profession_name_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'custom_profession_name'
);
SET @custom_profession_name_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE
        WHEN DATA_TYPE = 'varchar'
          AND CHARACTER_MAXIMUM_LENGTH = 120
          AND IS_NULLABLE = 'YES'
          AND COLUMN_DEFAULT IS NULL
          AND IFNULL(GENERATION_EXPRESSION, '') = ''
          AND EXTRA NOT LIKE '%GENERATED%'
        THEN 1 ELSE 0
      END
    ) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'custom_profession_name'
);
SET @ddl := IF(
  @custom_profession_name_exists = 0
    OR @custom_profession_name_contract_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''PROFESSIONAL_IDENTITY_CUSTOM_PROFESSION_NAME_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @profession_code_index_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND INDEX_NAME = 'idx_professionals_profession_code'
);
SET @profession_code_index_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE
        WHEN SEQ_IN_INDEX = 1
          AND COLUMN_NAME = 'profession_code'
          AND NON_UNIQUE = 1
          AND COLLATION = 'A'
          AND SUB_PART IS NULL
          AND INDEX_TYPE = 'BTREE'
          AND IS_VISIBLE = 'YES'
        THEN 1 ELSE 0
      END
    ) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND INDEX_NAME = 'idx_professionals_profession_code'
);
SET @ddl := IF(
  @profession_code_index_exists = 0
    OR @profession_code_index_contract_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''PROFESSIONAL_IDENTITY_PROFESSION_CODE_INDEX_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- DDL aditivo somente após contrato compatível ou ausência.
-- ---------------------------------------------------------------------------

SET @ddl := IF(
  @profession_code_exists = 0,
  'ALTER TABLE professionals ADD COLUMN profession_code VARCHAR(64) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  @custom_profession_name_exists = 0,
  'ALTER TABLE professionals ADD COLUMN custom_profession_name VARCHAR(120) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  @profession_code_index_exists = 0,
  'ALTER TABLE professionals ADD INDEX idx_professionals_profession_code (profession_code)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Postflight: o contrato tem de existir depois do ALTER.
SET @profession_code_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE
        WHEN DATA_TYPE = 'varchar'
          AND CHARACTER_MAXIMUM_LENGTH = 64
          AND IS_NULLABLE = 'YES'
          AND COLUMN_DEFAULT IS NULL
          AND IFNULL(GENERATION_EXPRESSION, '') = ''
          AND EXTRA NOT LIKE '%GENERATED%'
        THEN 1 ELSE 0
      END
    ) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'profession_code'
);
SET @ddl := IF(
  @profession_code_contract_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''PROFESSIONAL_IDENTITY_PROFESSION_CODE_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @custom_profession_name_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE
        WHEN DATA_TYPE = 'varchar'
          AND CHARACTER_MAXIMUM_LENGTH = 120
          AND IS_NULLABLE = 'YES'
          AND COLUMN_DEFAULT IS NULL
          AND IFNULL(GENERATION_EXPRESSION, '') = ''
          AND EXTRA NOT LIKE '%GENERATED%'
        THEN 1 ELSE 0
      END
    ) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'custom_profession_name'
);
SET @ddl := IF(
  @custom_profession_name_contract_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''PROFESSIONAL_IDENTITY_CUSTOM_PROFESSION_NAME_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @profession_code_index_contract_matches := (
  SELECT COUNT(*) = 1
    AND SUM(
      CASE
        WHEN SEQ_IN_INDEX = 1
          AND COLUMN_NAME = 'profession_code'
          AND NON_UNIQUE = 1
          AND COLLATION = 'A'
          AND SUB_PART IS NULL
          AND INDEX_TYPE = 'BTREE'
          AND IS_VISIBLE = 'YES'
        THEN 1 ELSE 0
      END
    ) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND INDEX_NAME = 'idx_professionals_profession_code'
);
SET @ddl := IF(
  @profession_code_index_contract_matches = 1,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''PROFESSIONAL_IDENTITY_PROFESSION_CODE_INDEX_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Backfill: professionals.role ONLY. Precisão > recall.
-- Labels inequívocos comprovados no repositório:
--   "Médico" (writers/seeds/testes)
--   "Enfermeiro" (seed-shifts / label de /register nurse)
--   "Técnico de Enfermagem" (mapRoleToLabel histórico / bulk-import)
--   "Técnico de enfermagem" (catálogo atual / writers da PR1)
-- ---------------------------------------------------------------------------

UPDATE professionals
SET profession_code = CASE role
  WHEN 'Médico' THEN 'MEDIC'
  WHEN 'Enfermeiro' THEN 'NURSING'
  WHEN 'Técnico de Enfermagem' THEN 'NURSING_TECHNICIAN'
  WHEN 'Técnico de enfermagem' THEN 'NURSING_TECHNICIAN'
  ELSE profession_code
END
WHERE profession_code IS NULL
  AND role IN (
    'Médico',
    'Enfermeiro',
    'Técnico de Enfermagem',
    'Técnico de enfermagem'
  );
