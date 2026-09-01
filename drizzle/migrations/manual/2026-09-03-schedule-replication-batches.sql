-- 2026-09-03 — agregado imutável para uma ação de replicação de escala.
--
-- Pré-requisitos: foundation de eventos (2026-08-31) e modo de emissão
-- (2026-09-01). A migration é aditiva e reexecutável: não migra emissores,
-- não envia mensagens e não altera calendário, alocação ou histórico.
--
-- O lote separa a identidade de um único comando de replicação das várias
-- competências/setores que ele pode materializar. Somente hashes e IDs são
-- persistidos; não há texto clínico, e-mail ou token em claro.

SET @replication_required_tables := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN (
      'operational_events',
      'institutions',
      'hospitals',
      'sectors',
      'schedule_contexts',
      'monthly_rosters',
      'users'
    )
);
SET @replication_emission_mode_contract := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operational_events'
    AND COLUMN_NAME = 'emission_mode'
    AND COLUMN_TYPE = 'enum(''SHADOW'',''ACTIVE'')'
    AND IS_NULLABLE = 'NO'
    AND COLUMN_DEFAULT = 'SHADOW'
);
SET @replication_prerequisites := IF(
  @replication_required_tables = 7
  AND @replication_emission_mode_contract = 1,
  'SELECT 1',
  'SELECT * FROM schedule_replication_batch_prerequisite_missing WHERE 1 = 0'
);
PREPARE replication_prerequisites_stmt FROM @replication_prerequisites;
EXECUTE replication_prerequisites_stmt;
DEALLOCATE PREPARE replication_prerequisites_stmt;

-- A FK de escopo para a competência precisa de uma chave-pai composta.
-- Se o nome já existir com outro contrato, aborta em vez de reescrever dados.
SET @monthly_roster_topology_index_named := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'monthly_rosters'
    AND INDEX_NAME = 'uniq_monthly_rosters_topology_id'
);
SET @monthly_roster_topology_index_matches := (
  SELECT COUNT(*)
  FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'monthly_rosters'
      AND INDEX_NAME = 'uniq_monthly_rosters_topology_id'
    GROUP BY INDEX_NAME, NON_UNIQUE
    HAVING NON_UNIQUE = 0
      AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'institution_id,hospital_id,id'
  ) AS monthly_roster_topology_index
);
SET @monthly_roster_topology_precondition := IF(
  @monthly_roster_topology_index_named = 0
  OR @monthly_roster_topology_index_matches = 1,
  'SELECT 1',
  'SELECT * FROM monthly_rosters_topology_index_contract_mismatch WHERE 1 = 0'
);
PREPARE monthly_roster_topology_stmt FROM @monthly_roster_topology_precondition;
EXECUTE monthly_roster_topology_stmt;
DEALLOCATE PREPARE monthly_roster_topology_stmt;

SET @ddl := IF(
  @monthly_roster_topology_index_named = 0,
  'ALTER TABLE monthly_rosters ADD UNIQUE KEY uniq_monthly_rosters_topology_id (institution_id, hospital_id, id)',
  'SELECT 1'
);
PREPARE monthly_roster_topology_ddl_stmt FROM @ddl;
EXECUTE monthly_roster_topology_ddl_stmt;
DEALLOCATE PREPARE monthly_roster_topology_ddl_stmt;

CREATE TABLE IF NOT EXISTS schedule_replication_batches (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  command_key_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_kind ENUM('RANGE', 'MONTH_CALENDAR') NOT NULL,
  status ENUM('COMPLETED') NOT NULL DEFAULT 'COMPLETED',
  version INT NOT NULL DEFAULT 1,
  created_by_user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_schedule_replication_batch_command (institution_id, command_key_hash),
  UNIQUE KEY uniq_schedule_replication_batch_topology_id (institution_id, hospital_id, id),
  KEY idx_schedule_replication_batch_hospital (institution_id, hospital_id, id),
  CONSTRAINT fk_schedule_replication_batch_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_schedule_replication_batch_hospital
    FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_schedule_replication_batch_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  CONSTRAINT fk_schedule_replication_batch_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals(institution_id, id)
) ENGINE=InnoDB;

-- `CREATE TABLE IF NOT EXISTS` não corrige uma tabela homônima parcial.
-- Portanto, depois do DDL, o contrato esperado precisa existir por inteiro;
-- divergência encerra sem tentar completar, alterar ou sobrescrever estado.
SET @batch_columns_match := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_replication_batches'
    AND (
      (COLUMN_NAME = 'id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' AND EXTRA = 'auto_increment')
      OR (COLUMN_NAME = 'institution_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'hospital_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'command_key_hash' AND COLUMN_TYPE = 'varchar(64)' AND IS_NULLABLE = 'NO' AND COLLATION_NAME = 'utf8mb4_bin')
      OR (COLUMN_NAME = 'source_kind' AND COLUMN_TYPE = 'enum(''RANGE'',''MONTH_CALENDAR'')' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'status' AND COLUMN_TYPE = 'enum(''COMPLETED'')' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = 'COMPLETED')
      OR (COLUMN_NAME = 'version' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = '1')
      OR (COLUMN_NAME = 'created_by_user_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'created_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'NO')
    )
);
SET @batch_columns_total := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_replication_batches'
);
SET @batch_indexes_match := (
  SELECT COUNT(*)
  FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'schedule_replication_batches'
      AND INDEX_NAME IN (
        'PRIMARY',
        'uniq_schedule_replication_batch_command',
        'uniq_schedule_replication_batch_topology_id',
        'idx_schedule_replication_batch_hospital'
      )
    GROUP BY INDEX_NAME, NON_UNIQUE
    HAVING (INDEX_NAME = 'PRIMARY' AND NON_UNIQUE = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'id')
      OR (INDEX_NAME = 'uniq_schedule_replication_batch_command' AND NON_UNIQUE = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'institution_id,command_key_hash')
      OR (INDEX_NAME = 'uniq_schedule_replication_batch_topology_id' AND NON_UNIQUE = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'institution_id,hospital_id,id')
      OR (INDEX_NAME = 'idx_schedule_replication_batch_hospital' AND NON_UNIQUE = 1 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'institution_id,hospital_id,id')
  ) AS batch_indexes
);
SET @batch_fks_match := (
  SELECT COUNT(*)
  FROM (
    SELECT CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'schedule_replication_batches'
      AND REFERENCED_TABLE_SCHEMA = DATABASE()
      AND REFERENCED_TABLE_NAME IS NOT NULL
      AND CONSTRAINT_NAME IN (
        'fk_schedule_replication_batch_institution',
        'fk_schedule_replication_batch_hospital',
        'fk_schedule_replication_batch_created_by',
        'fk_schedule_replication_batch_hospital_topology'
      )
    GROUP BY CONSTRAINT_NAME
    HAVING
      (CONSTRAINT_NAME = 'fk_schedule_replication_batch_institution'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'institution_id>institutions.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_hospital'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'hospital_id>hospitals.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_created_by'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'created_by_user_id>users.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_hospital_topology'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'institution_id>hospitals.institution_id,hospital_id>hospitals.id')
  ) AS batch_fks
);
SET @batch_contract_precondition := IF(
  @batch_columns_match = 9
  AND @batch_columns_total = 9
  AND @batch_indexes_match = 4
  AND @batch_fks_match = 4,
  'SELECT 1',
  'SELECT * FROM schedule_replication_batches_contract_mismatch WHERE 1 = 0'
);
PREPARE batch_contract_stmt FROM @batch_contract_precondition;
EXECUTE batch_contract_stmt;
DEALLOCATE PREPARE batch_contract_stmt;

CREATE TABLE IF NOT EXISTS schedule_replication_batch_scopes (
  id INT NOT NULL AUTO_INCREMENT,
  schedule_replication_batch_id INT NOT NULL,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  monthly_roster_id INT NOT NULL,
  sector_id INT NOT NULL,
  -- Nulo somente para turnos legados sem contexto classificado; setor e
  -- competência continuam obrigatórios e verificáveis pelas FKs canônicas.
  schedule_context_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_schedule_replication_batch_scope
    (schedule_replication_batch_id, monthly_roster_id, sector_id, schedule_context_id),
  KEY idx_schedule_replication_batch_scope_context
    (institution_id, hospital_id, monthly_roster_id, sector_id, schedule_context_id),
  CONSTRAINT fk_schedule_replication_batch_scope_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_schedule_replication_batch_scope_hospital
    FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_schedule_replication_batch_scope_roster
    FOREIGN KEY (monthly_roster_id) REFERENCES monthly_rosters(id),
  CONSTRAINT fk_schedule_replication_batch_scope_sector
    FOREIGN KEY (sector_id) REFERENCES sectors(id),
  CONSTRAINT fk_schedule_replication_batch_scope_schedule_context
    FOREIGN KEY (schedule_context_id) REFERENCES schedule_contexts(id),
  CONSTRAINT fk_schedule_replication_batch_scope_batch_topology
    FOREIGN KEY (schedule_replication_batch_id, institution_id, hospital_id)
    REFERENCES schedule_replication_batches(id, institution_id, hospital_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_schedule_replication_batch_scope_roster_topology
    FOREIGN KEY (institution_id, hospital_id, monthly_roster_id)
    REFERENCES monthly_rosters(institution_id, hospital_id, id),
  CONSTRAINT fk_schedule_replication_batch_scope_sector_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors(institution_id, hospital_id, id),
  CONSTRAINT fk_schedule_replication_batch_scope_schedule_context_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id, schedule_context_id)
    REFERENCES schedule_contexts(institution_id, hospital_id, sector_id, id)
) ENGINE=InnoDB;

SET @batch_scope_columns_match := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_replication_batch_scopes'
    AND (
      (COLUMN_NAME = 'id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO' AND EXTRA = 'auto_increment')
      OR (COLUMN_NAME = 'schedule_replication_batch_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'institution_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'hospital_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'monthly_roster_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'sector_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'NO')
      OR (COLUMN_NAME = 'schedule_context_id' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'YES')
      OR (COLUMN_NAME = 'created_at' AND COLUMN_TYPE = 'timestamp' AND IS_NULLABLE = 'NO')
    )
);
SET @batch_scope_columns_total := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_replication_batch_scopes'
);
SET @batch_scope_indexes_match := (
  SELECT COUNT(*)
  FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'schedule_replication_batch_scopes'
      AND INDEX_NAME IN (
        'PRIMARY',
        'uniq_schedule_replication_batch_scope',
        'idx_schedule_replication_batch_scope_context'
      )
    GROUP BY INDEX_NAME, NON_UNIQUE
    HAVING (INDEX_NAME = 'PRIMARY' AND NON_UNIQUE = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'id')
      OR (INDEX_NAME = 'uniq_schedule_replication_batch_scope' AND NON_UNIQUE = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'schedule_replication_batch_id,monthly_roster_id,sector_id,schedule_context_id')
      OR (INDEX_NAME = 'idx_schedule_replication_batch_scope_context' AND NON_UNIQUE = 1 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'institution_id,hospital_id,monthly_roster_id,sector_id,schedule_context_id')
  ) AS batch_scope_indexes
);
SET @batch_scope_fks_match := (
  SELECT COUNT(*)
  FROM (
    SELECT CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'schedule_replication_batch_scopes'
      AND REFERENCED_TABLE_SCHEMA = DATABASE()
      AND REFERENCED_TABLE_NAME IS NOT NULL
      AND CONSTRAINT_NAME IN (
        'fk_schedule_replication_batch_scope_batch_topology',
        'fk_schedule_replication_batch_scope_roster_topology',
        'fk_schedule_replication_batch_scope_sector_topology',
        'fk_schedule_replication_batch_scope_schedule_context_topology',
        'fk_schedule_replication_batch_scope_institution',
        'fk_schedule_replication_batch_scope_hospital',
        'fk_schedule_replication_batch_scope_roster',
        'fk_schedule_replication_batch_scope_sector',
        'fk_schedule_replication_batch_scope_schedule_context'
      )
    GROUP BY CONSTRAINT_NAME
    HAVING
      (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_institution'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'institution_id>institutions.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_hospital'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'hospital_id>hospitals.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_roster'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'monthly_roster_id>monthly_rosters.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_sector'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'sector_id>sectors.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_schedule_context'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'schedule_context_id>schedule_contexts.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_batch_topology'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'schedule_replication_batch_id>schedule_replication_batches.id,institution_id>schedule_replication_batches.institution_id,hospital_id>schedule_replication_batches.hospital_id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_roster_topology'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'institution_id>monthly_rosters.institution_id,hospital_id>monthly_rosters.hospital_id,monthly_roster_id>monthly_rosters.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_sector_topology'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'institution_id>sectors.institution_id,hospital_id>sectors.hospital_id,sector_id>sectors.id')
      OR (CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_schedule_context_topology'
        AND GROUP_CONCAT(CONCAT(COLUMN_NAME, '>', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION SEPARATOR ',') = 'institution_id>schedule_contexts.institution_id,hospital_id>schedule_contexts.hospital_id,sector_id>schedule_contexts.sector_id,schedule_context_id>schedule_contexts.id')
  ) AS batch_scope_fks
);
SET @batch_scope_batch_delete_rule_matches := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_replication_batch_scopes'
    AND CONSTRAINT_NAME = 'fk_schedule_replication_batch_scope_batch_topology'
    AND DELETE_RULE = 'CASCADE'
);
SET @batch_scope_contract_precondition := IF(
  @batch_scope_columns_match = 8
  AND @batch_scope_columns_total = 8
  AND @batch_scope_indexes_match = 3
  AND @batch_scope_fks_match = 9
  AND @batch_scope_batch_delete_rule_matches = 1,
  'SELECT 1',
  'SELECT * FROM schedule_replication_batch_scopes_contract_mismatch WHERE 1 = 0'
);
PREPARE batch_scope_contract_stmt FROM @batch_scope_contract_precondition;
EXECUTE batch_scope_contract_stmt;
DEALLOCATE PREPARE batch_scope_contract_stmt;
