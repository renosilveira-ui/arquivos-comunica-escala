-- 2026-08-31 — fence transacional do diagnóstico corporativo de prontidão.
--
-- A tabela é aditiva e contém somente uma revisão monotônica por instituição.
-- Nenhuma fonte de escala é criada, reescrita ou removida por esta migration.
-- Os triggers abaixo são deliberadamente corpos de UMA instrução SQL. Esta
-- migration deve ser aplicada somente pelo instalador dedicado
-- `pnpm apply:readiness-fence-migration`, que consulta INFORMATION_SCHEMA e
-- cria apenas observadores ausentes; não use o executor manual genérico.
--
-- Reaplicar é seguro: CREATE TABLE IF NOT EXISTS preserva a fence existente e
-- cada marcador @idempotent-trigger é instalado pelo runner somente se estiver
-- ausente; uma definição existente divergente falha fechada. Não existe trigger
-- sobre institution_readiness_fences, logo a própria invalidação não é
-- observada recursivamente.
--
-- O marcador institution_readiness_fence_installations só é escrito pelo
-- instalador depois que TODOS os triggers forem relidos e validados. O runtime
-- recusa operar sem esse marcador canônico: uma falha parcial de DDL nunca
-- pode deixar publicação futura aceitar uma fence com cobertura incompleta.
--
-- Extensões futuras intencionalmente fora desta migration: a relação
-- descritiva sector_service_specialties e user_operational_email_trust. Cada
-- uma ganha observadores somente junto da frente que a fizer entrar no
-- fingerprint/decisão de prontidão.

CREATE TABLE IF NOT EXISTS institution_readiness_fences (
  institution_id INT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (institution_id),
  CONSTRAINT fk_institution_readiness_fences_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS institution_readiness_fence_installations (
  id TINYINT UNSIGNED NOT NULL,
  coverage_version VARCHAR(64) NOT NULL,
  coverage_hash CHAR(64) NOT NULL,
  installed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- A validação de escopo do relatório passa pela hierarquia canônica. Embora
-- instituições e hospitais não componham métricas clínicas, uma troca de
-- topologia invalida qualquer leitura iniciada antes dela.
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_institutions_ai
AFTER INSERT ON institutions
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_institutions_au
AFTER UPDATE ON institutions
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT NEW.id, 1
  WHERE NOT (OLD.is_active <=> NEW.is_active)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_institutions_bd
BEFORE DELETE ON institutions
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_hospitals_ai
AFTER INSERT ON hospitals
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_hospitals_au
AFTER UPDATE ON hospitals
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT changed_institutions.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS changed_institutions
  WHERE NOT (OLD.institution_id <=> NEW.institution_id)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_hospitals_ad
AFTER DELETE ON hospitals
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- setores
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_sectors_ai
AFTER INSERT ON sectors
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = NEW.hospital_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_sectors_au
AFTER UPDATE ON sectors
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT old_hospital.institution_id AS institution_id
    FROM hospitals AS old_hospital
    WHERE old_hospital.id = OLD.hospital_id
    UNION
    SELECT new_hospital.institution_id AS institution_id
    FROM hospitals AS new_hospital
    WHERE new_hospital.id = NEW.hospital_id
  ) AS affected
  WHERE NOT (OLD.institution_id <=> NEW.institution_id)
     OR NOT (OLD.hospital_id <=> NEW.hospital_id)
     OR NOT (OLD.name <=> NEW.name)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_sectors_ad
AFTER DELETE ON sectors
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = OLD.hospital_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- contextos ativos de escala
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_schedule_contexts_ai
AFTER INSERT ON schedule_contexts
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = NEW.hospital_id
  ) AS affected
  WHERE NEW.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_schedule_contexts_au
AFTER UPDATE ON schedule_contexts
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    WHERE OLD.active = TRUE
    UNION
    SELECT NEW.institution_id AS institution_id
    WHERE NEW.active = TRUE
    UNION
    SELECT old_hospital.institution_id AS institution_id
    FROM hospitals AS old_hospital
    WHERE old_hospital.id = OLD.hospital_id AND OLD.active = TRUE
    UNION
    SELECT new_hospital.institution_id AS institution_id
    FROM hospitals AS new_hospital
    WHERE new_hospital.id = NEW.hospital_id AND NEW.active = TRUE
  ) AS affected
  WHERE NOT (OLD.active <=> NEW.active)
     OR (
       (OLD.active = TRUE OR NEW.active = TRUE)
       AND (
         NOT (OLD.institution_id <=> NEW.institution_id)
         OR NOT (OLD.hospital_id <=> NEW.hospital_id)
         OR NOT (OLD.sector_id <=> NEW.sector_id)
         OR NOT (OLD.medical_specialty_id <=> NEW.medical_specialty_id)
         OR NOT (OLD.operational_profile_code <=> NEW.operational_profile_code)
         OR NOT (OLD.admission_policy <=> NEW.admission_policy)
       )
     )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_schedule_contexts_ad
AFTER DELETE ON schedule_contexts
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = OLD.hospital_id
  ) AS affected
  WHERE OLD.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- Allowlist canônica de contextos. Somente contextos ativos de política
-- QUALIFICATION_ALLOWLIST participam do fingerprint de prontidão. A remoção
-- em cascata por apagar o próprio contexto já é observada pelo trigger do
-- pai; a remoção direta resolve a instituição antes de apagar a relação.
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_schedule_context_allowed_qualifications_ai
AFTER INSERT ON schedule_context_allowed_qualifications
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT schedule_context.institution_id AS institution_id
    FROM schedule_contexts AS schedule_context
    WHERE schedule_context.id = NEW.schedule_context_id
      AND schedule_context.active = TRUE
      AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM schedule_contexts AS schedule_context
    INNER JOIN hospitals AS hospital ON hospital.id = schedule_context.hospital_id
    WHERE schedule_context.id = NEW.schedule_context_id
      AND schedule_context.active = TRUE
      AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
  ) AS affected
  WHERE EXISTS (
    SELECT 1
    FROM schedule_contexts AS schedule_context
    WHERE schedule_context.id = NEW.schedule_context_id
      AND schedule_context.active = TRUE
      AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
  )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_schedule_context_allowed_qualifications_au
AFTER UPDATE ON schedule_context_allowed_qualifications
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT schedule_context.institution_id AS institution_id
    FROM schedule_contexts AS schedule_context
    WHERE schedule_context.id IN (OLD.schedule_context_id, NEW.schedule_context_id)
      AND schedule_context.active = TRUE
      AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM schedule_contexts AS schedule_context
    INNER JOIN hospitals AS hospital ON hospital.id = schedule_context.hospital_id
    WHERE schedule_context.id IN (OLD.schedule_context_id, NEW.schedule_context_id)
      AND schedule_context.active = TRUE
      AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
  ) AS affected
  WHERE (
      NOT (OLD.schedule_context_id <=> NEW.schedule_context_id)
      OR NOT (OLD.medical_specialty_id <=> NEW.medical_specialty_id)
      OR NOT (OLD.operational_profile_code <=> NEW.operational_profile_code)
    )
    AND EXISTS (
      SELECT 1
      FROM schedule_contexts AS schedule_context
      WHERE schedule_context.id IN (OLD.schedule_context_id, NEW.schedule_context_id)
        AND schedule_context.active = TRUE
        AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
    )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_schedule_context_allowed_qualifications_ad
AFTER DELETE ON schedule_context_allowed_qualifications
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT schedule_context.institution_id AS institution_id
    FROM schedule_contexts AS schedule_context
    WHERE schedule_context.id = OLD.schedule_context_id
      AND schedule_context.active = TRUE
      AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM schedule_contexts AS schedule_context
    INNER JOIN hospitals AS hospital ON hospital.id = schedule_context.hospital_id
    WHERE schedule_context.id = OLD.schedule_context_id
      AND schedule_context.active = TRUE
      AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
  ) AS affected
  WHERE EXISTS (
    SELECT 1
    FROM schedule_contexts AS schedule_context
    WHERE schedule_context.id = OLD.schedule_context_id
      AND schedule_context.active = TRUE
      AND schedule_context.admission_policy = 'QUALIFICATION_ALLOWLIST'
  )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- modelos de turno
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_templates_ai
AFTER INSERT ON shift_templates
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = NEW.hospital_id
  ) AS affected
  WHERE NEW.is_active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_templates_au
AFTER UPDATE ON shift_templates
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    WHERE OLD.is_active = TRUE
    UNION
    SELECT NEW.institution_id AS institution_id
    WHERE NEW.is_active = TRUE
    UNION
    SELECT old_hospital.institution_id AS institution_id
    FROM hospitals AS old_hospital
    WHERE old_hospital.id = OLD.hospital_id AND OLD.is_active = TRUE
    UNION
    SELECT new_hospital.institution_id AS institution_id
    FROM hospitals AS new_hospital
    WHERE new_hospital.id = NEW.hospital_id AND NEW.is_active = TRUE
  ) AS affected
  WHERE NOT (OLD.is_active <=> NEW.is_active)
     OR (
       (OLD.is_active = TRUE OR NEW.is_active = TRUE)
       AND (
         NOT (OLD.institution_id <=> NEW.institution_id)
         OR NOT (OLD.hospital_id <=> NEW.hospital_id)
         OR NOT (OLD.sector_id <=> NEW.sector_id)
         OR NOT (OLD.name <=> NEW.name)
         OR NOT (OLD.start_time <=> NEW.start_time)
         OR NOT (OLD.end_time <=> NEW.end_time)
         OR NOT (OLD.priority <=> NEW.priority)
       )
     )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_templates_ad
AFTER DELETE ON shift_templates
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = OLD.hospital_id
  ) AS affected
  WHERE OLD.is_active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- calendário de plantões
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_instances_ai
AFTER INSERT ON shift_instances
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = NEW.hospital_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_instances_au
AFTER UPDATE ON shift_instances
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT old_hospital.institution_id AS institution_id
    FROM hospitals AS old_hospital
    WHERE old_hospital.id = OLD.hospital_id
    UNION
    SELECT new_hospital.institution_id AS institution_id
    FROM hospitals AS new_hospital
    WHERE new_hospital.id = NEW.hospital_id
  ) AS affected
  WHERE NOT (OLD.institution_id <=> NEW.institution_id)
     OR NOT (OLD.hospital_id <=> NEW.hospital_id)
     OR NOT (OLD.sector_id <=> NEW.sector_id)
     OR NOT (OLD.schedule_context_id <=> NEW.schedule_context_id)
     OR NOT (OLD.label <=> NEW.label)
     OR NOT (OLD.specialty <=> NEW.specialty)
     OR NOT (OLD.status <=> NEW.status)
     OR NOT (OLD.start_at <=> NEW.start_at)
     OR NOT (OLD.end_at <=> NEW.end_at)
     OR NOT (OLD.modality <=> NEW.modality)
     OR NOT (OLD.coverage_type <=> NEW.coverage_type)
     OR NOT (OLD.payment_model <=> NEW.payment_model)
     OR NOT (OLD.productivity_cap_brl <=> NEW.productivity_cap_brl)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_instances_ad
AFTER DELETE ON shift_instances
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = OLD.hospital_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- alocações de plantão
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_assignments_v2_ai
AFTER INSERT ON shift_assignments_v2
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = NEW.hospital_id
    UNION
    SELECT parent_shift.institution_id AS institution_id
    FROM shift_instances AS parent_shift
    WHERE parent_shift.id = NEW.shift_instance_id
    UNION
    SELECT parent_hospital.institution_id AS institution_id
    FROM shift_instances AS parent_shift
    INNER JOIN hospitals AS parent_hospital
      ON parent_hospital.id = parent_shift.hospital_id
    WHERE parent_shift.id = NEW.shift_instance_id
  ) AS affected
  WHERE NEW.is_active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_assignments_v2_au
AFTER UPDATE ON shift_assignments_v2
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    WHERE OLD.is_active = TRUE
    UNION
    SELECT NEW.institution_id AS institution_id
    WHERE NEW.is_active = TRUE
    UNION
    SELECT old_hospital.institution_id AS institution_id
    FROM hospitals AS old_hospital
    WHERE old_hospital.id = OLD.hospital_id AND OLD.is_active = TRUE
    UNION
    SELECT new_hospital.institution_id AS institution_id
    FROM hospitals AS new_hospital
    WHERE new_hospital.id = NEW.hospital_id AND NEW.is_active = TRUE
    UNION
    SELECT old_parent_shift.institution_id AS institution_id
    FROM shift_instances AS old_parent_shift
    WHERE old_parent_shift.id = OLD.shift_instance_id AND OLD.is_active = TRUE
    UNION
    SELECT new_parent_shift.institution_id AS institution_id
    FROM shift_instances AS new_parent_shift
    WHERE new_parent_shift.id = NEW.shift_instance_id AND NEW.is_active = TRUE
    UNION
    SELECT old_parent_hospital.institution_id AS institution_id
    FROM shift_instances AS old_parent_shift
    INNER JOIN hospitals AS old_parent_hospital
      ON old_parent_hospital.id = old_parent_shift.hospital_id
    WHERE old_parent_shift.id = OLD.shift_instance_id AND OLD.is_active = TRUE
    UNION
    SELECT new_parent_hospital.institution_id AS institution_id
    FROM shift_instances AS new_parent_shift
    INNER JOIN hospitals AS new_parent_hospital
      ON new_parent_hospital.id = new_parent_shift.hospital_id
    WHERE new_parent_shift.id = NEW.shift_instance_id AND NEW.is_active = TRUE
  ) AS affected
  WHERE NOT (OLD.is_active <=> NEW.is_active)
     OR (
       (OLD.is_active = TRUE OR NEW.is_active = TRUE)
       AND (
         NOT (OLD.institution_id <=> NEW.institution_id)
         OR NOT (OLD.hospital_id <=> NEW.hospital_id)
         OR NOT (OLD.sector_id <=> NEW.sector_id)
         OR NOT (OLD.shift_instance_id <=> NEW.shift_instance_id)
         OR NOT (OLD.professional_id <=> NEW.professional_id)
         OR NOT (OLD.status <=> NEW.status)
       )
     )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_shift_assignments_v2_ad
AFTER DELETE ON shift_assignments_v2
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = OLD.hospital_id
    UNION
    SELECT parent_shift.institution_id AS institution_id
    FROM shift_instances AS parent_shift
    WHERE parent_shift.id = OLD.shift_instance_id
    UNION
    SELECT parent_hospital.institution_id AS institution_id
    FROM shift_instances AS parent_shift
    INNER JOIN hospitals AS parent_hospital
      ON parent_hospital.id = parent_shift.hospital_id
    WHERE parent_shift.id = OLD.shift_instance_id
  ) AS affected
  WHERE OLD.is_active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- vínculo institucional canônico
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professional_institutions_ai
AFTER INSERT ON professional_institutions
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT NEW.institution_id, 1
  WHERE NEW.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professional_institutions_au
AFTER UPDATE ON professional_institutions
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT changed_institutions.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    WHERE OLD.active = TRUE
    UNION
    SELECT NEW.institution_id AS institution_id
    WHERE NEW.active = TRUE
  ) AS changed_institutions
  WHERE NOT (OLD.active <=> NEW.active)
     OR (
       (OLD.active = TRUE OR NEW.active = TRUE)
       AND (
         NOT (OLD.institution_id <=> NEW.institution_id)
         OR NOT (OLD.professional_id <=> NEW.professional_id)
         OR NOT (OLD.user_id <=> NEW.user_id)
         OR NOT (OLD.role_in_institution <=> NEW.role_in_institution)
       )
     )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professional_institutions_ad
AFTER DELETE ON professional_institutions
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT OLD.institution_id, 1
  WHERE OLD.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- acesso assistencial
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professional_access_ai
AFTER INSERT ON professional_access
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = NEW.hospital_id
  ) AS affected
  WHERE NEW.can_access = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professional_access_au
AFTER UPDATE ON professional_access
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    WHERE OLD.can_access = TRUE
    UNION
    SELECT NEW.institution_id AS institution_id
    WHERE NEW.can_access = TRUE
    UNION
    SELECT old_hospital.institution_id AS institution_id
    FROM hospitals AS old_hospital
    WHERE old_hospital.id = OLD.hospital_id AND OLD.can_access = TRUE
    UNION
    SELECT new_hospital.institution_id AS institution_id
    FROM hospitals AS new_hospital
    WHERE new_hospital.id = NEW.hospital_id AND NEW.can_access = TRUE
  ) AS affected
  WHERE NOT (OLD.can_access <=> NEW.can_access)
     OR (
       (OLD.can_access = TRUE OR NEW.can_access = TRUE)
       AND (
         NOT (OLD.institution_id <=> NEW.institution_id)
         OR NOT (OLD.professional_id <=> NEW.professional_id)
         OR NOT (OLD.hospital_id <=> NEW.hospital_id)
         OR NOT (OLD.sector_id <=> NEW.sector_id)
       )
     )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professional_access_ad
AFTER DELETE ON professional_access
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = OLD.hospital_id
  ) AS affected
  WHERE OLD.can_access = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- jurisdição de gestor médico
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_manager_scope_ai
AFTER INSERT ON manager_scope
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT NEW.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = NEW.hospital_id
  ) AS affected
  WHERE NEW.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_manager_scope_au
AFTER UPDATE ON manager_scope
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    WHERE OLD.active = TRUE
    UNION
    SELECT NEW.institution_id AS institution_id
    WHERE NEW.active = TRUE
    UNION
    SELECT old_hospital.institution_id AS institution_id
    FROM hospitals AS old_hospital
    WHERE old_hospital.id = OLD.hospital_id AND OLD.active = TRUE
    UNION
    SELECT new_hospital.institution_id AS institution_id
    FROM hospitals AS new_hospital
    WHERE new_hospital.id = NEW.hospital_id AND NEW.active = TRUE
  ) AS affected
  WHERE NOT (OLD.active <=> NEW.active)
     OR (
       (OLD.active = TRUE OR NEW.active = TRUE)
       AND (
         NOT (OLD.institution_id <=> NEW.institution_id)
         OR NOT (OLD.manager_professional_id <=> NEW.manager_professional_id)
         OR NOT (OLD.hospital_id <=> NEW.hospital_id)
         OR NOT (OLD.sector_id <=> NEW.sector_id)
       )
     )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_manager_scope_ad
AFTER DELETE ON manager_scope
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT hospital.institution_id AS institution_id
    FROM hospitals AS hospital
    WHERE hospital.id = OLD.hospital_id
  ) AS affected
  WHERE OLD.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- status mensal do roster também compõe o snapshot de prontidão.
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_monthly_rosters_ai
AFTER INSERT ON monthly_rosters
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT NEW.institution_id, 1
  WHERE NEW.status <> 'DRAFT'
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_monthly_rosters_au
AFTER UPDATE ON monthly_rosters
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT changed_institutions.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    WHERE OLD.status <> 'DRAFT'
    UNION
    SELECT NEW.institution_id AS institution_id
    WHERE NEW.status <> 'DRAFT'
  ) AS changed_institutions
  WHERE NOT (OLD.status <=> NEW.status)
     OR (
       (OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT')
       AND (
         NOT (OLD.institution_id <=> NEW.institution_id)
         OR NOT (OLD.hospital_id <=> NEW.hospital_id)
         OR NOT (OLD.year_month <=> NEW.year_month)
       )
     )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_monthly_rosters_ad
AFTER DELETE ON monthly_rosters
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT OLD.institution_id, 1
  WHERE OLD.status <> 'DRAFT'
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- O diagnóstico lê e-mail, aprovação e soft-delete por meio do vínculo ativo.
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_users_ai
AFTER INSERT ON users
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = NEW.id
    AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_users_au
AFTER UPDATE ON users
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = NEW.id
    AND membership.active = TRUE
    AND (
      NOT (OLD.email <=> NEW.email)
      OR NOT (OLD.approval_status <=> NEW.approval_status)
      OR NOT (OLD.deleted_at <=> NEW.deleted_at)
    )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- BEFORE DELETE é essencial: cascades de FK podem remover o vínculo antes de
-- um AFTER DELETE conseguir descobrir quais diagnósticos eram afetados.
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_users_bd
BEFORE DELETE ON users
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = OLD.id AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- `professionals.user_id` participa da validação do vínculo. A revisão só
-- avança quando esse valor observado pelo relatório muda.
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professionals_ai
AFTER INSERT ON professionals
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.professional_id = NEW.id AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professionals_au
AFTER UPDATE ON professionals
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.professional_id = NEW.id
    AND membership.active = TRUE
    AND NOT (OLD.user_id <=> NEW.user_id)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_professionals_bd
BEFORE DELETE ON professionals
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.professional_id = OLD.id AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- push_tokens é associado ao usuário, não ao tenant de proveniência. Um único
-- token pode contar para todos os vínculos institucionais ativos daquele usuário.
-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_push_tokens_ai
AFTER INSERT ON push_tokens
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = NEW.user_id AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_push_tokens_au
AFTER UPDATE ON push_tokens
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT membership.institution_id AS institution_id
    FROM professional_institutions AS membership
    WHERE membership.user_id = OLD.user_id AND membership.active = TRUE
    UNION
    SELECT membership.institution_id AS institution_id
    FROM professional_institutions AS membership
    WHERE membership.user_id = NEW.user_id AND membership.active = TRUE
  ) AS affected
  WHERE NOT (OLD.user_id <=> NEW.user_id)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_push_tokens_ad
AFTER DELETE ON push_tokens
FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = OLD.user_id AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
