-- 2026-09-02 — índices aditivos para a leitura acionável de Vagas.
--
-- Não altera dados, autorização, elegibilidade ou topologia. O preflight
-- valida todos os nomes antes do primeiro DDL, impedindo instalação parcial
-- quando existe um índice homônimo incompatível. A migration é rerodável.

SET @professional_access_index_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_access'
    AND INDEX_NAME = 'idx_prof_access_actor_active'
);
SET @professional_access_contract_matches := (
  SELECT COUNT(*) = 5 AND SUM(CASE WHEN NON_UNIQUE = 1 AND (
    (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id') OR
    (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'professional_id') OR
    (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'can_access') OR
    (SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'hospital_id') OR
    (SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'sector_id')
  ) THEN 1 ELSE 0 END) = 5
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_access'
    AND INDEX_NAME = 'idx_prof_access_actor_active'
);

SET @manager_scope_index_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'manager_scope'
    AND INDEX_NAME = 'idx_manager_scope_actor_active'
);
SET @manager_scope_contract_matches := (
  SELECT COUNT(*) = 5 AND SUM(CASE WHEN NON_UNIQUE = 1 AND (
    (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id') OR
    (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'manager_professional_id') OR
    (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'active') OR
    (SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'hospital_id') OR
    (SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'sector_id')
  ) THEN 1 ELSE 0 END) = 5
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'manager_scope'
    AND INDEX_NAME = 'idx_manager_scope_actor_active'
);

SET @shift_instances_index_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND INDEX_NAME = 'idx_shift_instances_vacancy_lookup'
);
SET @shift_instances_contract_matches := (
  SELECT COUNT(*) = 4 AND SUM(CASE WHEN NON_UNIQUE = 1 AND (
    (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id') OR
    (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'status') OR
    (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'schedule_context_id') OR
    (SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'start_at')
  ) THEN 1 ELSE 0 END) = 4
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND INDEX_NAME = 'idx_shift_instances_vacancy_lookup'
);

SET @shift_active_index_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_assignments_v2'
    AND INDEX_NAME = 'idx_shift_assignments_shift_active'
);
SET @shift_active_contract_matches := (
  SELECT COUNT(*) = 2 AND SUM(CASE WHEN NON_UNIQUE = 1 AND (
    (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'shift_instance_id') OR
    (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'is_active')
  ) THEN 1 ELSE 0 END) = 2
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_assignments_v2'
    AND INDEX_NAME = 'idx_shift_assignments_shift_active'
);

SET @professional_active_index_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_assignments_v2'
    AND INDEX_NAME = 'idx_shift_assignments_prof_active'
);
SET @professional_active_contract_matches := (
  SELECT COUNT(*) = 3 AND SUM(CASE WHEN NON_UNIQUE = 1 AND (
    (SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'professional_id') OR
    (SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'is_active') OR
    (SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'shift_instance_id')
  ) THEN 1 ELSE 0 END) = 3
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_assignments_v2'
    AND INDEX_NAME = 'idx_shift_assignments_prof_active'
);

SET @vacancy_indexes_preflight := IF(
  (@professional_access_index_exists = 0 OR @professional_access_contract_matches = 1)
  AND (@manager_scope_index_exists = 0 OR @manager_scope_contract_matches = 1)
  AND (@shift_instances_index_exists = 0 OR @shift_instances_contract_matches = 1)
  AND (@shift_active_index_exists = 0 OR @shift_active_contract_matches = 1)
  AND (@professional_active_index_exists = 0 OR @professional_active_contract_matches = 1),
  'SELECT 1',
  'SELECT JSON_EXTRACT(''VACANCY_INDEX_CONTRACT_MISMATCH'', ''$'')'
);
PREPARE vacancy_index_stmt FROM @vacancy_indexes_preflight;
EXECUTE vacancy_index_stmt;
DEALLOCATE PREPARE vacancy_index_stmt;

SET @ddl := IF(
  @professional_access_index_exists = 0,
  'ALTER TABLE professional_access ADD INDEX idx_prof_access_actor_active (institution_id, professional_id, can_access, hospital_id, sector_id)',
  'SELECT 1'
);
PREPARE vacancy_index_stmt FROM @ddl;
EXECUTE vacancy_index_stmt;
DEALLOCATE PREPARE vacancy_index_stmt;

SET @ddl := IF(
  @manager_scope_index_exists = 0,
  'ALTER TABLE manager_scope ADD INDEX idx_manager_scope_actor_active (institution_id, manager_professional_id, active, hospital_id, sector_id)',
  'SELECT 1'
);
PREPARE vacancy_index_stmt FROM @ddl;
EXECUTE vacancy_index_stmt;
DEALLOCATE PREPARE vacancy_index_stmt;

SET @ddl := IF(
  @shift_instances_index_exists = 0,
  'ALTER TABLE shift_instances ADD INDEX idx_shift_instances_vacancy_lookup (institution_id, status, schedule_context_id, start_at)',
  'SELECT 1'
);
PREPARE vacancy_index_stmt FROM @ddl;
EXECUTE vacancy_index_stmt;
DEALLOCATE PREPARE vacancy_index_stmt;

SET @ddl := IF(
  @shift_active_index_exists = 0,
  'ALTER TABLE shift_assignments_v2 ADD INDEX idx_shift_assignments_shift_active (shift_instance_id, is_active)',
  'SELECT 1'
);
PREPARE vacancy_index_stmt FROM @ddl;
EXECUTE vacancy_index_stmt;
DEALLOCATE PREPARE vacancy_index_stmt;

SET @ddl := IF(
  @professional_active_index_exists = 0,
  'ALTER TABLE shift_assignments_v2 ADD INDEX idx_shift_assignments_prof_active (professional_id, is_active, shift_instance_id)',
  'SELECT 1'
);
PREPARE vacancy_index_stmt FROM @ddl;
EXECUTE vacancy_index_stmt;
DEALLOCATE PREPARE vacancy_index_stmt;

SET @vacancy_index_count := (
  SELECT COUNT(DISTINCT CONCAT(TABLE_NAME, ':', INDEX_NAME))
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND CONCAT(TABLE_NAME, ':', INDEX_NAME) IN (
      'professional_access:idx_prof_access_actor_active',
      'manager_scope:idx_manager_scope_actor_active',
      'shift_instances:idx_shift_instances_vacancy_lookup',
      'shift_assignments_v2:idx_shift_assignments_shift_active',
      'shift_assignments_v2:idx_shift_assignments_prof_active'
    )
);
SET @postflight := IF(
  @vacancy_index_count = 5,
  'SELECT 1',
  'SELECT JSON_EXTRACT(''VACANCY_INDEX_POSTFLIGHT_MISMATCH'', ''$'')'
);
PREPARE vacancy_index_stmt FROM @postflight;
EXECUTE vacancy_index_stmt;
DEALLOCATE PREPARE vacancy_index_stmt;
