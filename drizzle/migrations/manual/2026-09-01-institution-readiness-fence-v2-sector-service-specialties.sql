-- Extensão V2 da fence de prontidão: metadados assistenciais por setor.
--
-- Esta migration não altera tabelas V1 nem redefine triggers V1 e não deve ser
-- executada diretamente. O instalador dedicado V2 exige a V1 íntegra,
-- acrescenta somente a tabela própria e os três observadores abaixo, relê os
-- dois catálogos e insere o recibo V2 sem alterar o marcador singleton V1.
--
-- A existência da relação N:N é o metadado observado: uma linha em
-- sector_service_specialties conta como especialidade definida para o setor,
-- mesmo se o catálogo global estiver inativo. Não há leitura nem trigger em
-- medical_specialties nesta versão. A semântica de atividade do catálogo é
-- extensão explícita de V3, com contrato e observadores próprios.

CREATE TABLE IF NOT EXISTS institution_readiness_fence_extension_installations (
  extension_key VARCHAR(64) NOT NULL,
  coverage_version VARCHAR(64) NOT NULL,
  coverage_hash CHAR(64) NOT NULL,
  base_installation_id TINYINT UNSIGNED NOT NULL,
  base_coverage_version VARCHAR(64) NOT NULL,
  base_coverage_hash CHAR(64) NOT NULL,
  installed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (extension_key),
  CONSTRAINT fk_readiness_fence_extension_base_installation
    FOREIGN KEY (base_installation_id)
    REFERENCES institution_readiness_fence_installations(id)
) ENGINE=InnoDB;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_sector_service_specialties_ai
AFTER INSERT ON sector_service_specialties
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
    SELECT sector.institution_id AS institution_id
    FROM sectors AS sector
    WHERE sector.id = NEW.sector_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_sector_service_specialties_au
AFTER UPDATE ON sector_service_specialties
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
    UNION
    SELECT old_sector.institution_id AS institution_id
    FROM sectors AS old_sector
    WHERE old_sector.id = OLD.sector_id
    UNION
    SELECT new_sector.institution_id AS institution_id
    FROM sectors AS new_sector
    WHERE new_sector.id = NEW.sector_id
  ) AS affected
  WHERE NOT (OLD.institution_id <=> NEW.institution_id)
     OR NOT (OLD.hospital_id <=> NEW.hospital_id)
     OR NOT (OLD.sector_id <=> NEW.sector_id)
     OR NOT (OLD.medical_specialty_id <=> NEW.medical_specialty_id)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @idempotent-trigger
CREATE TRIGGER trg_readiness_fence_sector_service_specialties_ad
AFTER DELETE ON sector_service_specialties
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
    SELECT sector.institution_id AS institution_id
    FROM sectors AS sector
    WHERE sector.id = OLD.sector_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
