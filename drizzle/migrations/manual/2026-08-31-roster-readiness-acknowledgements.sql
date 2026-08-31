-- 2026-08-31 — ciência auditada de alertas operacionais na publicação mensal.
--
-- A migration é estritamente aditiva. Uma ciência só é inserida no mesmo
-- commit que publica o roster; não cria calendário, acessos ou profissionais.

-- A FK abaixo precisa de uma chave composta no roster que prove também
-- instituição, hospital e competência. Em bases já existentes, cria apenas
-- o índice ausente; não reescreve nem remove linhas.
SET @hospital_idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'hospitals'
    AND INDEX_NAME = 'uniq_hospitals_topology_id'
);
SET @hospital_ddl := IF(
  @hospital_idx_exists = 0,
  'ALTER TABLE hospitals ADD UNIQUE KEY uniq_hospitals_topology_id (institution_id, id)',
  'SELECT 1'
);
PREPARE hospital_stmt FROM @hospital_ddl;
EXECUTE hospital_stmt;
DEALLOCATE PREPARE hospital_stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'monthly_rosters'
    AND INDEX_NAME = 'uniq_monthly_rosters_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE monthly_rosters ADD UNIQUE KEY uniq_monthly_rosters_topology_id (institution_id, hospital_id, year_month, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A ciência precisa provar no próprio banco que o ator pertence ao tenant
-- auditado. Não presumimos o nome de índice de instalações antigas: aceitamos
-- qualquer UNIQUE físico exatamente em (user_id, institution_id) e só então
-- criamos o nome canônico se ele estiver ausente.
SET @actor_membership_unique_exists := (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'professional_institutions'
    GROUP BY INDEX_NAME
    HAVING MIN(NON_UNIQUE) = 0
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'user_id,institution_id'
  ) AS actor_membership_unique_indexes
);
SET @actor_membership_ddl := IF(
  @actor_membership_unique_exists = 0,
  'ALTER TABLE professional_institutions ADD UNIQUE KEY uniq_professional_institutions_user_institution (user_id, institution_id)',
  'SELECT 1'
);
PREPARE actor_membership_stmt FROM @actor_membership_ddl;
EXECUTE actor_membership_stmt;
DEALLOCATE PREPARE actor_membership_stmt;

CREATE TABLE IF NOT EXISTS roster_readiness_acknowledgements (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  monthly_roster_id INT NOT NULL,
  year_month VARCHAR(7) NOT NULL,
  actor_user_id INT NOT NULL,
  report_version VARCHAR(16) NOT NULL DEFAULT 'v1',
  snapshot_hash VARCHAR(64) NOT NULL,
  readiness_fence_revision BIGINT UNSIGNED NOT NULL,
  readiness_fence_coverage_version VARCHAR(64) NOT NULL,
  readiness_fence_coverage_hash VARCHAR(64) NOT NULL,
  issue_codes JSON NOT NULL,
  issue_snapshot JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_roster_readiness_acknowledgement
    (monthly_roster_id, actor_user_id, snapshot_hash),
  KEY idx_roster_readiness_ack_scope
    (institution_id, hospital_id, year_month, id),
  CONSTRAINT fk_roster_readiness_ack_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_roster_readiness_ack_hospital
    FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_roster_readiness_ack_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals(institution_id, id),
  CONSTRAINT fk_roster_readiness_ack_roster
    FOREIGN KEY (monthly_roster_id) REFERENCES monthly_rosters(id),
  CONSTRAINT fk_roster_readiness_ack_roster_topology
    FOREIGN KEY (institution_id, hospital_id, year_month, monthly_roster_id)
    REFERENCES monthly_rosters(institution_id, hospital_id, year_month, id),
  CONSTRAINT fk_roster_readiness_ack_actor
    FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT fk_roster_readiness_ack_actor_institution
    FOREIGN KEY (actor_user_id, institution_id)
    REFERENCES professional_institutions(user_id, institution_id)
);

-- Bases que por algum motivo já tenham a tabela desta frente sem a nova FK
-- não são corrigidas silenciosamente. A adição falha se houver auditoria
-- inconsistente, preservando as linhas para investigação em vez de apagá-las.
SET @actor_tenant_fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'roster_readiness_acknowledgements'
    AND CONSTRAINT_NAME = 'fk_roster_readiness_ack_actor_institution'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @actor_tenant_fk_ddl := IF(
  @actor_tenant_fk_exists = 0,
  'ALTER TABLE roster_readiness_acknowledgements ADD CONSTRAINT fk_roster_readiness_ack_actor_institution FOREIGN KEY (actor_user_id, institution_id) REFERENCES professional_institutions(user_id, institution_id)',
  'SELECT 1'
);
PREPARE actor_tenant_fk_stmt FROM @actor_tenant_fk_ddl;
EXECUTE actor_tenant_fk_stmt;
DEALLOCATE PREPARE actor_tenant_fk_stmt;
