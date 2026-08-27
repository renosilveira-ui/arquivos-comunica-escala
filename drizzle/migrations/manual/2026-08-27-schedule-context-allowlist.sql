-- 2026-08-27 — escala unificada por setor (QUALIFICATION_ALLOWLIST).
--
-- Permite uma única escala operacional por setor (ex.: Sala de Recuperação)
-- com várias qualificações admitidas via lista fechada.
--
-- Aplicar no staging ANTES do deploy:
--   pnpm apply:migration drizzle/migrations/manual/2026-08-27-schedule-context-allowlist.sql
--
-- Depois consolidar dados legados:
--   HSC_PROVISION_CONFIRM=SAO_CARLOS_MULTISETOR pnpm provision:sao-carlos -- --apply

CREATE TABLE IF NOT EXISTS schedule_context_allowed_qualifications (
  id INT NOT NULL AUTO_INCREMENT,
  schedule_context_id INT NOT NULL,
  medical_specialty_id INT NULL,
  operational_profile_code ENUM('MEDICO_GENERALISTA', 'RESIDENTE_ANESTESIOLOGIA') NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_sc_allowlist_specialty (schedule_context_id, medical_specialty_id),
  UNIQUE KEY uniq_sc_allowlist_profile (schedule_context_id, operational_profile_code),
  KEY idx_sc_allowlist_context (schedule_context_id),
  CONSTRAINT fk_sc_allowlist_context
    FOREIGN KEY (schedule_context_id) REFERENCES schedule_contexts (id) ON DELETE CASCADE,
  CONSTRAINT fk_sc_allowlist_medical_specialty
    FOREIGN KEY (medical_specialty_id) REFERENCES medical_specialties (id),
  CONSTRAINT chk_sc_allowlist_exactly_one_qualification
    CHECK (
      (medical_specialty_id IS NOT NULL AND operational_profile_code IS NULL)
      OR
      (medical_specialty_id IS NULL AND operational_profile_code IS NOT NULL)
    )
);

SET @policy_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND COLUMN_NAME = 'admission_policy'
    AND COLUMN_TYPE LIKE '%QUALIFICATION_ALLOWLIST%'
);
SET @ddl := IF(
  @policy_exists = 0,
  'ALTER TABLE schedule_contexts MODIFY COLUMN admission_policy ENUM(''PINNED_QUALIFICATION'', ''ALL_CFM_SPECIALTIES'', ''ALL_CFM_EXCEPT_GENERALIST'', ''QUALIFICATION_ALLOWLIST'') NOT NULL DEFAULT ''PINNED_QUALIFICATION''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Relaxa o CHECK para aceitar QUALIFICATION_ALLOWLIST sem qualificação pinada na linha.
SET @chk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND CONSTRAINT_NAME = 'chk_schedule_context_qualification_matches_policy'
);
SET @ddl := IF(
  @chk_exists > 0,
  'ALTER TABLE schedule_contexts DROP CHECK chk_schedule_context_qualification_matches_policy',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE schedule_contexts
  ADD CONSTRAINT chk_schedule_context_qualification_matches_policy
  CHECK (
    (
      admission_policy = 'PINNED_QUALIFICATION'
      AND (
        (medical_specialty_id IS NOT NULL AND operational_profile_code IS NULL)
        OR
        (medical_specialty_id IS NULL AND operational_profile_code IS NOT NULL)
      )
    )
    OR
    (
      admission_policy IN (
        'ALL_CFM_SPECIALTIES',
        'ALL_CFM_EXCEPT_GENERALIST',
        'QUALIFICATION_ALLOWLIST'
      )
      AND medical_specialty_id IS NULL
      AND operational_profile_code IS NULL
    )
  );
