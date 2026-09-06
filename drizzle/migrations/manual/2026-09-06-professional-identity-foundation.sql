-- 2026-09-06 — fundação de identidade profissional (PR 1).
--
-- Adiciona profession_code e custom_profession_name em professionals.
-- VARCHAR, não ENUM MySQL: o catálogo vive em lib/profession-definitions.ts
-- e pode crescer sem redesenhar AuthZ.
--
-- NÃO cria UNIQUE(user_id): a cardinalidade user↔professional permanece
-- UNPROVEN (writers convencionam 1 linha; leitores usam limit(1); o schema
-- já admite >1). Não misturar tenant, registro profissional (PR 2) nem
-- verificação externa.
--
-- Aplicar no staging ANTES do merge (o deploy não roda migrações):
--   pnpm apply:migration drizzle/migrations/manual/2026-09-06-professional-identity-foundation.sql
--
-- Idempotente: consulta INFORMATION_SCHEMA antes de ALTER; backfill só
-- preenche linhas ainda NULL.

SET @profession_code_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'profession_code'
);
SET @ddl := IF(
  @profession_code_exists = 0,
  'ALTER TABLE professionals ADD COLUMN profession_code VARCHAR(64) NULL',
  'SELECT 1'
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
SET @ddl := IF(
  @custom_profession_name_exists = 0,
  'ALTER TABLE professionals ADD COLUMN custom_profession_name VARCHAR(120) NULL',
  'SELECT 1'
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
SET @ddl := IF(
  @profession_code_index_exists = 0,
  'ALTER TABLE professionals ADD INDEX idx_professionals_profession_code (profession_code)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill conservador: só classifica quando o leftover users.role é uma
-- profissão (doctor/nurse/tech). admin/manager NÃO viram MEDIC — gestão
-- não é profissão. Labels conhecidos cobrem cascas cujo users.role não
-- reflete o dado de exibição. Demais linhas permanecem NULL (legado
-- não classificado), sem forçar médico.

UPDATE professionals AS professional
INNER JOIN users AS user_account ON user_account.id = professional.user_id
SET professional.profession_code = CASE
  WHEN user_account.role = 'doctor' THEN 'MEDIC'
  WHEN user_account.role = 'nurse' THEN 'NURSING'
  WHEN user_account.role = 'tech' THEN 'NURSING_TECHNICIAN'
  ELSE professional.profession_code
END
WHERE professional.profession_code IS NULL
  AND user_account.role IN ('doctor', 'nurse', 'tech');

UPDATE professionals
SET profession_code = 'MEDIC'
WHERE profession_code IS NULL
  AND role = 'Médico';

UPDATE professionals
SET profession_code = 'NURSING'
WHERE profession_code IS NULL
  AND role IN ('Enfermeiro', 'Enfermeiro(a)');

UPDATE professionals
SET profession_code = 'NURSING_TECHNICIAN'
WHERE profession_code IS NULL
  AND role IN (
    'Técnico de Enfermagem',
    'Técnico de enfermagem',
    'Técnico'
  );
