-- 2026-09-10 — intenção/outbox e journal duráveis da emissão nominal.
--
-- Tabelas/colunas aditivas e migration rerodável.
-- Aplicar ANTES da migration hash V2 e de qualquer runtime novo, com writers fora de
-- rotação. A reaplicação recria apenas os guards append-only depois de provar
-- o manifesto exato. Nenhuma tabela guarda código em claro, hash do código,
-- e-mail ou payload do provedor.

-- Preflight de ambos os objetos ANTES do primeiro DDL permanente. Uma tabela
-- homônima só é aceita quando o manifesto final inteiro coincide; drift ou
-- objeto parcial falha sem tentar consertar estado desconhecido.
SET @siif_fence_objects := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_fence_tables := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siif_fence_columns_ok := (
  SELECT COUNT(*) = 21
    AND SUM(CASE WHEN COLUMN_NAME = 'id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' AND EXTRA LIKE '%auto_increment%' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'institution_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'hospital_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'sector_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'invited_user_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'generation' AND COLUMN_TYPE = 'int unsigned' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = '0' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'state' AND COLUMN_TYPE = 'enum(''IDLE'',''PREPARING'',''PROVIDER_UNKNOWN'',''PROVIDER_ACCEPTED'',''ACTIVE'',''PROVIDER_REJECTED'',''PROVIDER_ACCEPTED_ACTIVATION_FAILED'')' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = 'IDLE' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'lease_token' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'lease_expires_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'attempt_expires_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'code_nonce' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'code_pepper_key_id' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'recipient_binding_hash' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_idempotency_key' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_request_fingerprint' AND COLUMN_TYPE = 'char(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_correlation_id' AND COLUMN_TYPE = 'varchar(128)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_accepted_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'schedule_invite_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'failure_code' AND COLUMN_TYPE = 'varchar(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'created_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'NO' AND LOWER(CAST(COLUMN_DEFAULT AS CHAR)) IN ('current_timestamp','now()') THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'updated_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'NO' AND LOWER(EXTRA) LIKE '%on update current_timestamp%' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_fence_indexes_ok := (
  SELECT COUNT(*) = 6
    AND SUM(CASE WHEN INDEX_NAME = 'PRIMARY' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'uniq_schedule_invite_issuance_scope' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'uniq_schedule_invite_issuance_scope' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'uniq_schedule_invite_issuance_scope' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'sector_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'uniq_schedule_invite_issuance_scope' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'invited_user_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'fk_schedule_invite_issuance_invited_user' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'invited_user_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
);
SET @siif_fence_fks_ok := (
  SELECT COUNT(*) = 6
    AND COUNT(DISTINCT key_columns.CONSTRAINT_NAME) = 3
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_hospital_topology' AND key_columns.ORDINAL_POSITION = 1 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 1 AND key_columns.COLUMN_NAME = 'institution_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'hospitals' AND key_columns.REFERENCED_COLUMN_NAME = 'institution_id' AND referential_constraints.MATCH_OPTION = 'NONE' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_hospital_topology' AND key_columns.ORDINAL_POSITION = 2 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 2 AND key_columns.COLUMN_NAME = 'hospital_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'hospitals' AND key_columns.REFERENCED_COLUMN_NAME = 'id' AND referential_constraints.MATCH_OPTION = 'NONE' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_sector_topology' AND key_columns.ORDINAL_POSITION = 1 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 1 AND key_columns.COLUMN_NAME = 'institution_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'sectors' AND key_columns.REFERENCED_COLUMN_NAME = 'institution_id' AND referential_constraints.MATCH_OPTION = 'NONE' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_sector_topology' AND key_columns.ORDINAL_POSITION = 2 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 2 AND key_columns.COLUMN_NAME = 'hospital_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'sectors' AND key_columns.REFERENCED_COLUMN_NAME = 'hospital_id' AND referential_constraints.MATCH_OPTION = 'NONE' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_sector_topology' AND key_columns.ORDINAL_POSITION = 3 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 3 AND key_columns.COLUMN_NAME = 'sector_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'sectors' AND key_columns.REFERENCED_COLUMN_NAME = 'id' AND referential_constraints.MATCH_OPTION = 'NONE' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_invited_user' AND key_columns.ORDINAL_POSITION = 1 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 1 AND key_columns.COLUMN_NAME = 'invited_user_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'users' AND key_columns.REFERENCED_COLUMN_NAME = 'id' AND referential_constraints.MATCH_OPTION = 'NONE' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'CASCADE' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS key_columns
  INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS referential_constraints
    ON referential_constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
    AND referential_constraints.TABLE_NAME = key_columns.TABLE_NAME
    AND referential_constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
  WHERE key_columns.TABLE_SCHEMA = DATABASE()
    AND key_columns.TABLE_NAME = 'schedule_invite_issuance_fences'
    AND key_columns.REFERENCED_TABLE_NAME IS NOT NULL
    AND referential_constraints.MATCH_OPTION = 'NONE'
);
SET @siif_fence_checks_ok := (
  SELECT COUNT(*) = 6 AND SUM(check_manifest.ENFORCED = 'YES') = 6
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_generation' AND check_manifest.NORMALIZED_CLAUSE = '((state=''idle''andgeneration=0)or(state<>''idle''andgeneration>0))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_lease_shape' AND check_manifest.NORMALIZED_CLAUSE = '((statein(''preparing'',''provider_unknown'',''provider_accepted'')andlease_tokenisnotnullandlease_expires_atisnotnull)or(statenotin(''preparing'',''provider_unknown'',''provider_accepted'')andlease_tokenisnullandlease_expires_atisnull))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_material_shape' AND check_manifest.NORMALIZED_CLAUSE = '((state=''idle''andattempt_expires_atisnullandcode_nonceisnullandcode_pepper_key_idisnullandrecipient_binding_hashisnullandprovider_idempotency_keyisnullandprovider_request_fingerprintisnull)or(state<>''idle''andattempt_expires_atisnotnullandcode_nonceisnotnullandcode_pepper_key_idisnotnullandrecipient_binding_hashisnotnullandprovider_idempotency_keyisnotnullandprovider_request_fingerprintisnotnull))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_accepted_shape' AND check_manifest.NORMALIZED_CLAUSE = '((statein(''provider_accepted'',''active'',''provider_accepted_activation_failed'')andprovider_accepted_atisnotnull)or(statenotin(''provider_accepted'',''active'',''provider_accepted_activation_failed'')andprovider_accepted_atisnull))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_failure_shape' AND check_manifest.NORMALIZED_CLAUSE = '((statein(''provider_unknown'',''provider_rejected'',''provider_accepted_activation_failed'')andfailure_codeisnotnull)or(statenotin(''provider_unknown'',''provider_rejected'',''provider_accepted_activation_failed'')andfailure_codeisnull))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_activation_shape' AND check_manifest.NORMALIZED_CLAUSE = '((state=''active''andschedule_invite_idisnotnull)or(state<>''active''andschedule_invite_idisnull))') = 1
  FROM (
    SELECT table_constraints.CONSTRAINT_NAME, table_constraints.ENFORCED,
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(check_constraints.CHECK_CLAUSE), CHAR(96), ''), '_utf8mb4', ''), ' ', ''), CHAR(10), ''), CHAR(13), '') AS NORMALIZED_CLAUSE
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS table_constraints
    INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS check_constraints
      ON check_constraints.CONSTRAINT_SCHEMA = table_constraints.CONSTRAINT_SCHEMA
      AND check_constraints.CONSTRAINT_NAME = table_constraints.CONSTRAINT_NAME
    WHERE table_constraints.CONSTRAINT_SCHEMA = DATABASE()
      AND table_constraints.TABLE_NAME = 'schedule_invite_issuance_fences'
      AND table_constraints.CONSTRAINT_TYPE = 'CHECK'
  ) AS check_manifest
);
SET @siif_fence_options_ok := (
  SELECT COUNT(*) = 1 AND MIN(ENGINE = 'InnoDB') = 1
    AND MIN(TABLE_COLLATION = 'utf8mb4_0900_ai_ci') = 1
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_fences'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siif_fence_trigger_count := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_fences'
);
SET @siif_fence_contract_ok := (
  @siif_fence_objects = 1 AND @siif_fence_tables = 1
  AND @siif_fence_columns_ok AND @siif_fence_indexes_ok
  AND @siif_fence_fks_ok AND @siif_fence_checks_ok
  AND @siif_fence_options_ok AND @siif_fence_trigger_count = 0
);

SET @siij_objects := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
);
SET @siij_tables := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siij_columns_ok := (
  SELECT COUNT(*) = 11
    AND SUM(CASE WHEN COLUMN_NAME = 'id' AND COLUMN_TYPE = 'bigint unsigned' AND IS_NULLABLE = 'NO' AND EXTRA LIKE '%auto_increment%' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'institution_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'hospital_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'sector_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'invited_user_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'generation' AND COLUMN_TYPE = 'int unsigned' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'event' AND COLUMN_TYPE = 'enum(''CLAIMED'',''ATTEMPT_SUPERSEDED'',''DELIVERY_RECLAIMED'',''PROVIDER_ACCEPTED'',''PROVIDER_REJECTED'',''PROVIDER_UNKNOWN'',''ACTIVATION_RESUMED'',''ACTIVATED'',''ACTIVATION_FAILED'')' AND IS_NULLABLE = 'NO' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'reason_code' AND COLUMN_TYPE = 'varchar(64)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'provider_correlation_id' AND COLUMN_TYPE = 'varchar(128)' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'schedule_invite_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN COLUMN_NAME = 'created_at' AND COLUMN_TYPE = 'timestamp(6)' AND IS_NULLABLE = 'NO' AND LOWER(CAST(COLUMN_DEFAULT AS CHAR)) IN ('current_timestamp(6)','now(6)') THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
);
SET @siij_indexes_ok := (
  SELECT COUNT(*) = 7
    AND SUM(CASE WHEN INDEX_NAME = 'PRIMARY' AND NON_UNIQUE = 0 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'hospital_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'sector_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'invited_user_id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'generation' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN INDEX_NAME = 'idx_schedule_invite_issuance_journal_generation' AND NON_UNIQUE = 1 AND SEQ_IN_INDEX = 6 AND COLUMN_NAME = 'id' AND COLLATION = 'A' AND SUB_PART IS NULL AND INDEX_TYPE = 'BTREE' AND IS_VISIBLE = 'YES' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
);
SET @siij_checks_ok := (
  SELECT COUNT(*) = 1 AND SUM(check_manifest.ENFORCED = 'YES') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_journal_generation' AND check_manifest.NORMALIZED_CLAUSE = '(generation>0)') = 1
  FROM (
    SELECT table_constraints.CONSTRAINT_NAME, table_constraints.ENFORCED,
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(check_constraints.CHECK_CLAUSE), CHAR(96), ''), '_utf8mb4', ''), ' ', ''), CHAR(10), ''), CHAR(13), '') AS NORMALIZED_CLAUSE
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS table_constraints
    INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS check_constraints
      ON check_constraints.CONSTRAINT_SCHEMA = table_constraints.CONSTRAINT_SCHEMA
      AND check_constraints.CONSTRAINT_NAME = table_constraints.CONSTRAINT_NAME
    WHERE table_constraints.CONSTRAINT_SCHEMA = DATABASE()
      AND table_constraints.TABLE_NAME = 'schedule_invite_issuance_journal'
      AND table_constraints.CONSTRAINT_TYPE = 'CHECK'
  ) AS check_manifest
);
SET @siij_fk_count := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
    AND REFERENCED_TABLE_NAME IS NOT NULL
);
SET @siij_triggers_ok := (
  SELECT COUNT(*) = 2
    AND SUM(CASE WHEN TRIGGER_NAME = 'trg_schedule_invite_issuance_journal_no_update' AND ACTION_TIMING = 'BEFORE' AND EVENT_MANIPULATION = 'UPDATE' AND ACTION_ORIENTATION = 'ROW' AND ACTION_CONDITION IS NULL AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(ACTION_STATEMENT), ' ', ''), CHAR(10), ''), CHAR(13), ''), ';', '') = 'signalsqlstate''45000''setmessage_text=''schedule_invite_issuance_journal_is_append_only''' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN TRIGGER_NAME = 'trg_schedule_invite_issuance_journal_no_delete' AND ACTION_TIMING = 'BEFORE' AND EVENT_MANIPULATION = 'DELETE' AND ACTION_ORIENTATION = 'ROW' AND ACTION_CONDITION IS NULL AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(ACTION_STATEMENT), ' ', ''), CHAR(10), ''), CHAR(13), ''), ';', '') = 'signalsqlstate''45000''setmessage_text=''schedule_invite_issuance_journal_is_append_only''' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_journal'
);
SET @siij_reserved_trigger_count := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND TRIGGER_NAME IN (
      'trg_schedule_invite_issuance_journal_no_update',
      'trg_schedule_invite_issuance_journal_no_delete'
    )
);
SET @siij_options_ok := (
  SELECT COUNT(*) = 1 AND MIN(ENGINE = 'InnoDB') = 1
    AND MIN(TABLE_COLLATION = 'utf8mb4_0900_ai_ci') = 1
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_invite_issuance_journal'
    AND TABLE_TYPE = 'BASE TABLE'
);
SET @siij_contract_ok := (
  @siij_objects = 1 AND @siij_tables = 1
  AND @siij_columns_ok AND @siij_indexes_ok AND @siij_checks_ok
  AND @siij_fk_count = 0 AND @siij_triggers_ok
  AND @siij_reserved_trigger_count = 2 AND @siij_options_ok
);

SET @siif_preflight_sql := IF(
  (@siif_fence_objects = 0 OR @siif_fence_contract_ok)
  AND (
    (@siij_objects = 0 AND @siij_reserved_trigger_count = 0)
    OR @siij_contract_ok
  ),
  'SELECT 1',
  'SELECT JSON_EXTRACT(''SCHEDULE_INVITE_DURABLE_DELIVERY_PREFLIGHT_MISMATCH'', ''$'')'
);
PREPARE siif_preflight_stmt FROM @siif_preflight_sql;
EXECUTE siif_preflight_stmt;
DEALLOCATE PREPARE siif_preflight_stmt;

CREATE TABLE IF NOT EXISTS schedule_invite_issuance_fences (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  sector_id INT NOT NULL,
  invited_user_id INT NOT NULL,
  generation INT UNSIGNED NOT NULL DEFAULT 0,
  state ENUM(
    'IDLE', 'PREPARING', 'PROVIDER_UNKNOWN', 'PROVIDER_ACCEPTED',
    'ACTIVE', 'PROVIDER_REJECTED',
    'PROVIDER_ACCEPTED_ACTIVATION_FAILED'
  ) NOT NULL DEFAULT 'IDLE',
  lease_token CHAR(64) NULL DEFAULT NULL,
  lease_expires_at TIMESTAMP NULL DEFAULT NULL,
  attempt_expires_at TIMESTAMP NULL DEFAULT NULL,
  code_nonce CHAR(64) NULL DEFAULT NULL,
  code_pepper_key_id CHAR(64) NULL DEFAULT NULL,
  recipient_binding_hash CHAR(64) NULL DEFAULT NULL,
  provider_idempotency_key CHAR(64) NULL DEFAULT NULL,
  provider_request_fingerprint CHAR(64) NULL DEFAULT NULL,
  provider_correlation_id VARCHAR(128) NULL DEFAULT NULL,
  provider_accepted_at TIMESTAMP NULL DEFAULT NULL,
  schedule_invite_id INT NULL DEFAULT NULL,
  failure_code VARCHAR(64) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_schedule_invite_issuance_scope (
    institution_id, hospital_id, sector_id, invited_user_id
  ),
  CONSTRAINT fk_schedule_invite_issuance_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals (institution_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_schedule_invite_issuance_sector_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors (institution_id, hospital_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_schedule_invite_issuance_invited_user
    FOREIGN KEY (invited_user_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT chk_schedule_invite_issuance_generation CHECK (
    (state = 'IDLE' AND generation = 0)
    OR (state <> 'IDLE' AND generation > 0)
  ),
  CONSTRAINT chk_schedule_invite_issuance_lease_shape CHECK (
    (state IN ('PREPARING','PROVIDER_UNKNOWN','PROVIDER_ACCEPTED')
      AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state NOT IN ('PREPARING','PROVIDER_UNKNOWN','PROVIDER_ACCEPTED')
      AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT chk_schedule_invite_issuance_material_shape CHECK (
    (state = 'IDLE' AND attempt_expires_at IS NULL AND code_nonce IS NULL
      AND code_pepper_key_id IS NULL AND recipient_binding_hash IS NULL
      AND provider_idempotency_key IS NULL AND provider_request_fingerprint IS NULL)
    OR
    (state <> 'IDLE' AND attempt_expires_at IS NOT NULL AND code_nonce IS NOT NULL
      AND code_pepper_key_id IS NOT NULL AND recipient_binding_hash IS NOT NULL
      AND provider_idempotency_key IS NOT NULL AND provider_request_fingerprint IS NOT NULL)
  ),
  CONSTRAINT chk_schedule_invite_issuance_accepted_shape CHECK (
    (state IN ('PROVIDER_ACCEPTED','ACTIVE','PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND provider_accepted_at IS NOT NULL)
    OR
    (state NOT IN ('PROVIDER_ACCEPTED','ACTIVE','PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND provider_accepted_at IS NULL)
  ),
  CONSTRAINT chk_schedule_invite_issuance_failure_shape CHECK (
    (state IN ('PROVIDER_UNKNOWN','PROVIDER_REJECTED','PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND failure_code IS NOT NULL)
    OR
    (state NOT IN ('PROVIDER_UNKNOWN','PROVIDER_REJECTED','PROVIDER_ACCEPTED_ACTIVATION_FAILED')
      AND failure_code IS NULL)
  ),
  CONSTRAINT chk_schedule_invite_issuance_activation_shape CHECK (
    (state = 'ACTIVE' AND schedule_invite_id IS NOT NULL)
    OR (state <> 'ACTIVE' AND schedule_invite_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS schedule_invite_issuance_journal (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  sector_id INT NOT NULL,
  invited_user_id INT NOT NULL,
  generation INT UNSIGNED NOT NULL,
  event ENUM(
    'CLAIMED', 'ATTEMPT_SUPERSEDED', 'DELIVERY_RECLAIMED',
    'PROVIDER_ACCEPTED', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN',
    'ACTIVATION_RESUMED', 'ACTIVATED', 'ACTIVATION_FAILED'
  ) NOT NULL,
  reason_code VARCHAR(64) NULL DEFAULT NULL,
  provider_correlation_id VARCHAR(128) NULL DEFAULT NULL,
  schedule_invite_id INT NULL DEFAULT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_schedule_invite_issuance_journal_generation (
    institution_id, hospital_id, sector_id, invited_user_id, generation, id
  ),
  CONSTRAINT chk_schedule_invite_issuance_journal_generation
    CHECK (generation > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Proteção física append-only. Os nomes e ACTION_STATEMENT fazem parte do
-- manifesto: trigger extra ou alterado bloqueia a reaplicação antes deste
-- ponto. DROP + CREATE usa DDL suportado pelo MySQL 8 e torna o arquivo
-- rerodável; a janela de instalação exige writers quiescentes, como todo o
-- rollout coordenado desta migration.
DROP TRIGGER IF EXISTS trg_schedule_invite_issuance_journal_no_update;
CREATE TRIGGER trg_schedule_invite_issuance_journal_no_update
  BEFORE UPDATE ON schedule_invite_issuance_journal FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'SCHEDULE_INVITE_ISSUANCE_JOURNAL_IS_APPEND_ONLY';

DROP TRIGGER IF EXISTS trg_schedule_invite_issuance_journal_no_delete;
CREATE TRIGGER trg_schedule_invite_issuance_journal_no_delete
  BEFORE DELETE ON schedule_invite_issuance_journal FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'SCHEDULE_INVITE_ISSUANCE_JOURNAL_IS_APPEND_ONLY';

-- Postflight cobre o manifesto crítico já no primeiro run. O preflight da
-- segunda execução repete a prova completa sem alterar linhas.
SET @siif_postflight_fks_ok := (
  SELECT COUNT(*) = 6
    AND COUNT(DISTINCT key_columns.CONSTRAINT_NAME) = 3
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_hospital_topology' AND key_columns.ORDINAL_POSITION = 1 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 1 AND key_columns.COLUMN_NAME = 'institution_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'hospitals' AND key_columns.REFERENCED_COLUMN_NAME = 'institution_id' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_hospital_topology' AND key_columns.ORDINAL_POSITION = 2 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 2 AND key_columns.COLUMN_NAME = 'hospital_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'hospitals' AND key_columns.REFERENCED_COLUMN_NAME = 'id' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_sector_topology' AND key_columns.ORDINAL_POSITION = 1 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 1 AND key_columns.COLUMN_NAME = 'institution_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'sectors' AND key_columns.REFERENCED_COLUMN_NAME = 'institution_id' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_sector_topology' AND key_columns.ORDINAL_POSITION = 2 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 2 AND key_columns.COLUMN_NAME = 'hospital_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'sectors' AND key_columns.REFERENCED_COLUMN_NAME = 'hospital_id' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_sector_topology' AND key_columns.ORDINAL_POSITION = 3 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 3 AND key_columns.COLUMN_NAME = 'sector_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'sectors' AND key_columns.REFERENCED_COLUMN_NAME = 'id' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'RESTRICT' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN key_columns.CONSTRAINT_NAME = 'fk_schedule_invite_issuance_invited_user' AND key_columns.ORDINAL_POSITION = 1 AND key_columns.POSITION_IN_UNIQUE_CONSTRAINT = 1 AND key_columns.COLUMN_NAME = 'invited_user_id' AND key_columns.REFERENCED_TABLE_SCHEMA = DATABASE() AND key_columns.REFERENCED_TABLE_NAME = 'users' AND key_columns.REFERENCED_COLUMN_NAME = 'id' AND referential_constraints.UPDATE_RULE = 'RESTRICT' AND referential_constraints.DELETE_RULE = 'CASCADE' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS key_columns
  INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS referential_constraints
    ON referential_constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA
    AND referential_constraints.TABLE_NAME = key_columns.TABLE_NAME
    AND referential_constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME
  WHERE key_columns.TABLE_SCHEMA = DATABASE()
    AND key_columns.TABLE_NAME = 'schedule_invite_issuance_fences'
    AND key_columns.REFERENCED_TABLE_NAME IS NOT NULL
    AND referential_constraints.MATCH_OPTION = 'NONE'
);
SET @siif_postflight_checks_ok := (
  SELECT COUNT(*) = 6 AND SUM(check_manifest.ENFORCED = 'YES') = 6
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_generation' AND check_manifest.NORMALIZED_CLAUSE = '((state=''idle''andgeneration=0)or(state<>''idle''andgeneration>0))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_lease_shape' AND check_manifest.NORMALIZED_CLAUSE = '((statein(''preparing'',''provider_unknown'',''provider_accepted'')andlease_tokenisnotnullandlease_expires_atisnotnull)or(statenotin(''preparing'',''provider_unknown'',''provider_accepted'')andlease_tokenisnullandlease_expires_atisnull))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_material_shape' AND check_manifest.NORMALIZED_CLAUSE = '((state=''idle''andattempt_expires_atisnullandcode_nonceisnullandcode_pepper_key_idisnullandrecipient_binding_hashisnullandprovider_idempotency_keyisnullandprovider_request_fingerprintisnull)or(state<>''idle''andattempt_expires_atisnotnullandcode_nonceisnotnullandcode_pepper_key_idisnotnullandrecipient_binding_hashisnotnullandprovider_idempotency_keyisnotnullandprovider_request_fingerprintisnotnull))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_accepted_shape' AND check_manifest.NORMALIZED_CLAUSE = '((statein(''provider_accepted'',''active'',''provider_accepted_activation_failed'')andprovider_accepted_atisnotnull)or(statenotin(''provider_accepted'',''active'',''provider_accepted_activation_failed'')andprovider_accepted_atisnull))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_failure_shape' AND check_manifest.NORMALIZED_CLAUSE = '((statein(''provider_unknown'',''provider_rejected'',''provider_accepted_activation_failed'')andfailure_codeisnotnull)or(statenotin(''provider_unknown'',''provider_rejected'',''provider_accepted_activation_failed'')andfailure_codeisnull))') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_activation_shape' AND check_manifest.NORMALIZED_CLAUSE = '((state=''active''andschedule_invite_idisnotnull)or(state<>''active''andschedule_invite_idisnull))') = 1
  FROM (
    SELECT table_constraints.CONSTRAINT_NAME, table_constraints.ENFORCED,
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(check_constraints.CHECK_CLAUSE), CHAR(96), ''), '_utf8mb4', ''), ' ', ''), CHAR(10), ''), CHAR(13), '') AS NORMALIZED_CLAUSE
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS table_constraints
    INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS check_constraints
      ON check_constraints.CONSTRAINT_SCHEMA = table_constraints.CONSTRAINT_SCHEMA
      AND check_constraints.CONSTRAINT_NAME = table_constraints.CONSTRAINT_NAME
    WHERE table_constraints.CONSTRAINT_SCHEMA = DATABASE()
      AND table_constraints.TABLE_NAME = 'schedule_invite_issuance_fences'
      AND table_constraints.CONSTRAINT_TYPE = 'CHECK'
  ) AS check_manifest
);
SET @siij_postflight_check_ok := (
  SELECT COUNT(*) = 1 AND SUM(check_manifest.ENFORCED = 'YES') = 1
    AND SUM(check_manifest.CONSTRAINT_NAME = 'chk_schedule_invite_issuance_journal_generation' AND check_manifest.NORMALIZED_CLAUSE = '(generation>0)') = 1
  FROM (
    SELECT table_constraints.CONSTRAINT_NAME, table_constraints.ENFORCED,
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(check_constraints.CHECK_CLAUSE), CHAR(96), ''), '_utf8mb4', ''), ' ', ''), CHAR(10), ''), CHAR(13), '') AS NORMALIZED_CLAUSE
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS table_constraints
    INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS check_constraints
      ON check_constraints.CONSTRAINT_SCHEMA = table_constraints.CONSTRAINT_SCHEMA
      AND check_constraints.CONSTRAINT_NAME = table_constraints.CONSTRAINT_NAME
    WHERE table_constraints.CONSTRAINT_SCHEMA = DATABASE()
      AND table_constraints.TABLE_NAME = 'schedule_invite_issuance_journal'
      AND table_constraints.CONSTRAINT_TYPE = 'CHECK'
  ) AS check_manifest
);
SET @siij_postflight_triggers_ok := (
  SELECT COUNT(*) = 2
    AND SUM(CASE WHEN TRIGGER_NAME = 'trg_schedule_invite_issuance_journal_no_update' AND ACTION_TIMING = 'BEFORE' AND EVENT_MANIPULATION = 'UPDATE' AND ACTION_ORIENTATION = 'ROW' AND ACTION_CONDITION IS NULL AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(ACTION_STATEMENT), ' ', ''), CHAR(10), ''), CHAR(13), ''), ';', '') = 'signalsqlstate''45000''setmessage_text=''schedule_invite_issuance_journal_is_append_only''' THEN 1 ELSE 0 END) = 1
    AND SUM(CASE WHEN TRIGGER_NAME = 'trg_schedule_invite_issuance_journal_no_delete' AND ACTION_TIMING = 'BEFORE' AND EVENT_MANIPULATION = 'DELETE' AND ACTION_ORIENTATION = 'ROW' AND ACTION_CONDITION IS NULL AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(ACTION_STATEMENT), ' ', ''), CHAR(10), ''), CHAR(13), ''), ';', '') = 'signalsqlstate''45000''setmessage_text=''schedule_invite_issuance_journal_is_append_only''' THEN 1 ELSE 0 END) = 1
  FROM INFORMATION_SCHEMA.TRIGGERS
  WHERE TRIGGER_SCHEMA = DATABASE()
    AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_journal'
);
SET @siif_postflight_missing := (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_invite_issuance_fences') <> 21
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_invite_issuance_fences'
       AND CONSTRAINT_TYPE = 'CHECK') <> 6
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_invite_issuance_journal') <> 11
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'schedule_invite_issuance_journal'
       AND CONSTRAINT_TYPE = 'CHECK') <> 1
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
     WHERE TRIGGER_SCHEMA = DATABASE()
       AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_journal') <> 2
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
     WHERE TRIGGER_SCHEMA = DATABASE()
       AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_journal'
       AND TRIGGER_NAME = 'trg_schedule_invite_issuance_journal_no_update'
       AND ACTION_TIMING = 'BEFORE'
       AND EVENT_MANIPULATION = 'UPDATE'
       AND ACTION_ORIENTATION = 'ROW') <> 1
    OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
     WHERE TRIGGER_SCHEMA = DATABASE()
       AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_journal'
       AND TRIGGER_NAME = 'trg_schedule_invite_issuance_journal_no_delete'
       AND ACTION_TIMING = 'BEFORE'
       AND EVENT_MANIPULATION = 'DELETE'
       AND ACTION_ORIENTATION = 'ROW') <> 1
    OR NOT @siif_postflight_fks_ok
    OR NOT @siif_postflight_checks_ok
    OR NOT @siij_postflight_check_ok
    OR NOT @siij_postflight_triggers_ok
);
SET @siif_postflight_sql := IF(
  @siif_postflight_missing = 0,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''SCHEDULE_INVITE_DURABLE_DELIVERY_POSTFLIGHT_MISMATCH'', ''$'')'
);
PREPARE siif_postflight_stmt FROM @siif_postflight_sql;
EXECUTE siif_postflight_stmt;
DEALLOCATE PREPARE siif_postflight_stmt;
