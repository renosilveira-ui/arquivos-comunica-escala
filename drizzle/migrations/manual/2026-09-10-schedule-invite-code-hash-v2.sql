-- 2026-09-10 — versão do hash de convite nominal.
--
-- Aplicar antes do runtime HMAC. Linhas existentes recebem explicitamente
-- SHA256_V1 e continuam resgatáveis somente até seu expires_at. No mesmo run,
-- o default final muda para HMAC_SHA256_V2; portanto writer omisso nunca cria
-- nova linha V1. Não mantenha writer legado ativo durante o rollout.
--
-- O pepper NÃO pertence ao banco nem a esta migration. Configure
-- SCHEDULE_INVITE_CODE_PEPPER separadamente em cada instância antes do deploy;
-- para rotação, mantenha SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER por >= 24 horas.

SET @sichv2_table_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @sichv2_code_hash_contract_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND COLUMN_NAME = 'code_hash'
    AND COLUMN_TYPE = 'varchar(64)'
    AND IS_NULLABLE = 'NO'
);
SET @sichv2_unique_hash_contract_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND INDEX_NAME = 'uniq_schedule_invite_code_hash'
    AND NON_UNIQUE = 0
    AND SEQ_IN_INDEX = 1
    AND COLUMN_NAME = 'code_hash'
    AND SUB_PART IS NULL
);
SET @sichv2_unique_hash_row_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND INDEX_NAME = 'uniq_schedule_invite_code_hash'
);
SET @sichv2_version_column_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invites'
    AND COLUMN_NAME = 'code_hash_version'
);
SET @sichv2_version_contract_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS version_column
  INNER JOIN INFORMATION_SCHEMA.COLUMNS hash_column
    ON hash_column.TABLE_SCHEMA = version_column.TABLE_SCHEMA
   AND hash_column.TABLE_NAME = version_column.TABLE_NAME
   AND hash_column.COLUMN_NAME = 'code_hash'
  INNER JOIN INFORMATION_SCHEMA.TABLES target_table
    ON target_table.TABLE_SCHEMA = version_column.TABLE_SCHEMA
   AND target_table.TABLE_NAME = version_column.TABLE_NAME
   AND target_table.TABLE_TYPE = 'BASE TABLE'
  WHERE version_column.TABLE_SCHEMA = DATABASE()
    AND version_column.TABLE_NAME = 'schedule_invites'
    AND version_column.COLUMN_NAME = 'code_hash_version'
    AND version_column.ORDINAL_POSITION = hash_column.ORDINAL_POSITION + 1
    AND version_column.COLUMN_TYPE = 'enum(''SHA256_V1'',''HMAC_SHA256_V2'')'
    AND version_column.IS_NULLABLE = 'NO'
    AND version_column.COLUMN_DEFAULT IN ('SHA256_V1', 'HMAC_SHA256_V2')
    AND version_column.EXTRA = ''
    AND version_column.CHARACTER_SET_NAME = 'utf8mb4'
    AND version_column.COLLATION_NAME = target_table.TABLE_COLLATION
);
SET @sichv2_preflight_ok := (
  @sichv2_table_count = 1
  AND @sichv2_code_hash_contract_count = 1
  AND @sichv2_unique_hash_contract_count = 1
  AND @sichv2_unique_hash_row_count = 1
  AND (
    @sichv2_version_column_count = 0
    OR (
      @sichv2_version_column_count = 1
      AND @sichv2_version_contract_count = 1
    )
  )
);
SET @sichv2_preflight_sql := IF(
  @sichv2_preflight_ok,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''SCHEDULE_INVITE_HASH_V2_PREFLIGHT_MISMATCH'', ''$'')'
);
PREPARE sichv2_preflight_stmt FROM @sichv2_preflight_sql;
EXECUTE sichv2_preflight_stmt;
DEALLOCATE PREPARE sichv2_preflight_stmt;

SET @sichv2_rows_before := (SELECT COUNT(*) FROM schedule_invites);
SET @sichv2_add_column_sql := IF(
  @sichv2_version_column_count = 0,
  'ALTER TABLE schedule_invites ADD COLUMN code_hash_version ENUM(''SHA256_V1'', ''HMAC_SHA256_V2'') NOT NULL DEFAULT ''SHA256_V1'' AFTER code_hash',
  'SELECT 1'
);
PREPARE sichv2_add_column_stmt FROM @sichv2_add_column_sql;
EXECUTE sichv2_add_column_stmt;
DEALLOCATE PREPARE sichv2_add_column_stmt;

-- O DEFAULT V1 existe apenas durante o ADD: ele marca o backfill legado sem
-- reescrever hashes. Antes de concluir a migration, writer omisso passa a V2.
SET @sichv2_promote_default_sql := IF(
  (SELECT COUNT(*)
   FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'schedule_invites'
     AND COLUMN_NAME = 'code_hash_version'
     AND COLUMN_DEFAULT = 'HMAC_SHA256_V2') = 1,
  'SELECT 1',
  'ALTER TABLE schedule_invites MODIFY COLUMN code_hash_version ENUM(''SHA256_V1'', ''HMAC_SHA256_V2'') NOT NULL DEFAULT ''HMAC_SHA256_V2'' AFTER code_hash'
);
PREPARE sichv2_promote_default_stmt FROM @sichv2_promote_default_sql;
EXECUTE sichv2_promote_default_stmt;
DEALLOCATE PREPARE sichv2_promote_default_stmt;

SET @sichv2_post_version_contract_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS version_column
  INNER JOIN INFORMATION_SCHEMA.COLUMNS hash_column
    ON hash_column.TABLE_SCHEMA = version_column.TABLE_SCHEMA
   AND hash_column.TABLE_NAME = version_column.TABLE_NAME
   AND hash_column.COLUMN_NAME = 'code_hash'
  INNER JOIN INFORMATION_SCHEMA.TABLES target_table
    ON target_table.TABLE_SCHEMA = version_column.TABLE_SCHEMA
   AND target_table.TABLE_NAME = version_column.TABLE_NAME
   AND target_table.TABLE_TYPE = 'BASE TABLE'
  WHERE version_column.TABLE_SCHEMA = DATABASE()
    AND version_column.TABLE_NAME = 'schedule_invites'
    AND version_column.COLUMN_NAME = 'code_hash_version'
    AND version_column.ORDINAL_POSITION = hash_column.ORDINAL_POSITION + 1
    AND version_column.COLUMN_TYPE = 'enum(''SHA256_V1'',''HMAC_SHA256_V2'')'
    AND version_column.IS_NULLABLE = 'NO'
    AND version_column.COLUMN_DEFAULT = 'HMAC_SHA256_V2'
    AND version_column.EXTRA = ''
    AND version_column.CHARACTER_SET_NAME = 'utf8mb4'
    AND version_column.COLLATION_NAME = target_table.TABLE_COLLATION
);
SET @sichv2_invalid_version_rows := (
  SELECT COUNT(*)
  FROM schedule_invites
  WHERE code_hash_version IS NULL
     OR code_hash_version NOT IN ('SHA256_V1', 'HMAC_SHA256_V2')
);
SET @sichv2_rows_after := (SELECT COUNT(*) FROM schedule_invites);
SET @sichv2_postflight_ok := (
  @sichv2_post_version_contract_count = 1
  AND @sichv2_invalid_version_rows = 0
  AND @sichv2_rows_after = @sichv2_rows_before
);
SET @sichv2_postflight_sql := IF(
  @sichv2_postflight_ok,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''SCHEDULE_INVITE_HASH_V2_POSTFLIGHT_MISMATCH'', ''$'')'
);
PREPARE sichv2_postflight_stmt FROM @sichv2_postflight_sql;
EXECUTE sichv2_postflight_stmt;
DEALLOCATE PREPARE sichv2_postflight_stmt;
