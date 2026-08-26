-- 2026-08-25 — contextos de escala por setor e qualificação médica canônica.
--
-- Migração ADITIVA. Não remove o texto legado `specialty`; ele permanece
-- durante a transição. Não cria hospitais/setores de cliente: a carga do
-- Hospital São Carlos pertence a um script operacional separado.
--
-- Idempotência:
--   * tabelas usam CREATE TABLE IF NOT EXISTS;
--   * colunas, índices e FKs em tabelas existentes consultam INFORMATION_SCHEMA;
--   * catálogo usa UPSERT por code;
--   * backfill só preenche linhas ainda sem classificação canônica.

CREATE TABLE IF NOT EXISTS medical_specialties (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  source_version VARCHAR(32) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_medical_specialty_code (code),
  KEY idx_medical_specialty_sort_order (sort_order)
);

-- Relação A da Portaria CME nº 1/2024, homologada pela Resolução CFM
-- nº 2.380/2024. MEDICO_GENERALISTA não entra aqui: é perfil operacional.
INSERT INTO medical_specialties
  (code, name, source_version, active, sort_order)
VALUES
  ('ACUPUNTURA', 'Acupuntura', 'CFM_2380_2024', TRUE, 1),
  ('ALERGIA_E_IMUNOLOGIA', 'Alergia e imunologia', 'CFM_2380_2024', TRUE, 2),
  ('ANESTESIOLOGIA', 'Anestesiologia', 'CFM_2380_2024', TRUE, 3),
  ('ANGIOLOGIA', 'Angiologia', 'CFM_2380_2024', TRUE, 4),
  ('CARDIOLOGIA', 'Cardiologia', 'CFM_2380_2024', TRUE, 5),
  ('CIRURGIA_CARDIOVASCULAR', 'Cirurgia cardiovascular', 'CFM_2380_2024', TRUE, 6),
  ('CIRURGIA_DA_MAO', 'Cirurgia da mão', 'CFM_2380_2024', TRUE, 7),
  ('CIRURGIA_DE_CABECA_E_PESCOCO', 'Cirurgia de cabeça e pescoço', 'CFM_2380_2024', TRUE, 8),
  ('CIRURGIA_DO_APARELHO_DIGESTIVO', 'Cirurgia do aparelho digestivo', 'CFM_2380_2024', TRUE, 9),
  ('CIRURGIA_GERAL', 'Cirurgia geral', 'CFM_2380_2024', TRUE, 10),
  ('CIRURGIA_ONCOLOGICA', 'Cirurgia oncológica', 'CFM_2380_2024', TRUE, 11),
  ('CIRURGIA_PEDIATRICA', 'Cirurgia pediátrica', 'CFM_2380_2024', TRUE, 12),
  ('CIRURGIA_PLASTICA', 'Cirurgia plástica', 'CFM_2380_2024', TRUE, 13),
  ('CIRURGIA_TORACICA', 'Cirurgia torácica', 'CFM_2380_2024', TRUE, 14),
  ('CIRURGIA_VASCULAR', 'Cirurgia vascular', 'CFM_2380_2024', TRUE, 15),
  ('CLINICA_MEDICA', 'Clínica médica', 'CFM_2380_2024', TRUE, 16),
  ('COLOPROCTOLOGIA', 'Coloproctologia', 'CFM_2380_2024', TRUE, 17),
  ('DERMATOLOGIA', 'Dermatologia', 'CFM_2380_2024', TRUE, 18),
  ('ENDOCRINOLOGIA_E_METABOLOGIA', 'Endocrinologia e metabologia', 'CFM_2380_2024', TRUE, 19),
  ('ENDOSCOPIA', 'Endoscopia', 'CFM_2380_2024', TRUE, 20),
  ('GASTROENTEROLOGIA', 'Gastroenterologia', 'CFM_2380_2024', TRUE, 21),
  ('GENETICA_MEDICA', 'Genética médica', 'CFM_2380_2024', TRUE, 22),
  ('GERIATRIA', 'Geriatria', 'CFM_2380_2024', TRUE, 23),
  ('GINECOLOGIA_E_OBSTETRICIA', 'Ginecologia e obstetrícia', 'CFM_2380_2024', TRUE, 24),
  ('HEMATOLOGIA_E_HEMOTERAPIA', 'Hematologia e hemoterapia', 'CFM_2380_2024', TRUE, 25),
  ('HOMEOPATIA', 'Homeopatia', 'CFM_2380_2024', TRUE, 26),
  ('INFECTOLOGIA', 'Infectologia', 'CFM_2380_2024', TRUE, 27),
  ('MASTOLOGIA', 'Mastologia', 'CFM_2380_2024', TRUE, 28),
  ('MEDICINA_DE_EMERGENCIA', 'Medicina de emergência', 'CFM_2380_2024', TRUE, 29),
  ('MEDICINA_DE_FAMILIA_E_COMUNIDADE', 'Medicina de família e comunidade', 'CFM_2380_2024', TRUE, 30),
  ('MEDICINA_DO_TRABALHO', 'Medicina do trabalho', 'CFM_2380_2024', TRUE, 31),
  ('MEDICINA_DO_TRAFEGO', 'Medicina do tráfego', 'CFM_2380_2024', TRUE, 32),
  ('MEDICINA_ESPORTIVA', 'Medicina esportiva', 'CFM_2380_2024', TRUE, 33),
  ('MEDICINA_FISICA_E_REABILITACAO', 'Medicina física e reabilitação', 'CFM_2380_2024', TRUE, 34),
  ('MEDICINA_INTENSIVA', 'Medicina intensiva', 'CFM_2380_2024', TRUE, 35),
  ('MEDICINA_LEGAL_E_PERICIA_MEDICA', 'Medicina legal e perícia médica', 'CFM_2380_2024', TRUE, 36),
  ('MEDICINA_NUCLEAR', 'Medicina nuclear', 'CFM_2380_2024', TRUE, 37),
  ('MEDICINA_PREVENTIVA_E_SOCIAL', 'Medicina preventiva e social', 'CFM_2380_2024', TRUE, 38),
  ('NEFROLOGIA', 'Nefrologia', 'CFM_2380_2024', TRUE, 39),
  ('NEUROCIRURGIA', 'Neurocirurgia', 'CFM_2380_2024', TRUE, 40),
  ('NEUROLOGIA', 'Neurologia', 'CFM_2380_2024', TRUE, 41),
  ('NUTROLOGIA', 'Nutrologia', 'CFM_2380_2024', TRUE, 42),
  ('OFTALMOLOGIA', 'Oftalmologia', 'CFM_2380_2024', TRUE, 43),
  ('ONCOLOGIA_CLINICA', 'Oncologia clínica', 'CFM_2380_2024', TRUE, 44),
  ('ORTOPEDIA_E_TRAUMATOLOGIA', 'Ortopedia e traumatologia', 'CFM_2380_2024', TRUE, 45),
  ('OTORRINOLARINGOLOGIA', 'Otorrinolaringologia', 'CFM_2380_2024', TRUE, 46),
  ('PATOLOGIA', 'Patologia', 'CFM_2380_2024', TRUE, 47),
  ('PATOLOGIA_CLINICA_MEDICINA_LABORATORIAL', 'Patologia clínica/medicina laboratorial', 'CFM_2380_2024', TRUE, 48),
  ('PEDIATRIA', 'Pediatria', 'CFM_2380_2024', TRUE, 49),
  ('PNEUMOLOGIA', 'Pneumologia', 'CFM_2380_2024', TRUE, 50),
  ('PSIQUIATRIA', 'Psiquiatria', 'CFM_2380_2024', TRUE, 51),
  ('RADIOLOGIA_E_DIAGNOSTICO_POR_IMAGEM', 'Radiologia e diagnóstico por imagem', 'CFM_2380_2024', TRUE, 52),
  ('RADIOTERAPIA', 'Radioterapia', 'CFM_2380_2024', TRUE, 53),
  ('REUMATOLOGIA', 'Reumatologia', 'CFM_2380_2024', TRUE, 54),
  ('UROLOGIA', 'Urologia', 'CFM_2380_2024', TRUE, 55)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  source_version = VALUES(source_version),
  active = VALUES(active),
  sort_order = VALUES(sort_order);

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'medical_specialty_id'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE professionals ADD COLUMN medical_specialty_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'operational_profile_code'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE professionals ADD COLUMN operational_profile_code ENUM(''MEDICO_GENERALISTA'', ''RESIDENTE_ANESTESIOLOGIA'') NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND INDEX_NAME = 'idx_professionals_medical_specialty'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE professionals ADD INDEX idx_professionals_medical_specialty (medical_specialty_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND CONSTRAINT_NAME = 'fk_professionals_medical_specialty'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE professionals ADD CONSTRAINT fk_professionals_medical_specialty FOREIGN KEY (medical_specialty_id) REFERENCES medical_specialties(id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @check_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND CONSTRAINT_NAME = 'chk_professionals_at_most_one_medical_qualification'
    AND CONSTRAINT_TYPE = 'CHECK'
);
SET @ddl := IF(
  @check_exists = 0,
  'ALTER TABLE professionals ADD CONSTRAINT chk_professionals_at_most_one_medical_qualification CHECK (medical_specialty_id IS NULL OR operational_profile_code IS NULL)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- As FKs compostas abaixo tornam a hierarquia uma propriedade do banco, não
-- apenas uma convenção da aplicação. IDs individuais corretos, mas combinados
-- com instituição/hospital errados, passam a ser impossíveis de persistir.
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'hospitals'
    AND INDEX_NAME = 'uniq_hospitals_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE hospitals ADD UNIQUE KEY uniq_hospitals_topology_id (institution_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sectors'
    AND INDEX_NAME = 'uniq_sectors_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE sectors ADD UNIQUE KEY uniq_sectors_topology_id (institution_id, hospital_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sectors'
    AND CONSTRAINT_NAME = 'fk_sectors_hospital_topology'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE sectors ADD CONSTRAINT fk_sectors_hospital_topology FOREIGN KEY (institution_id, hospital_id) REFERENCES hospitals(institution_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS schedule_contexts (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  sector_id INT NOT NULL,
  medical_specialty_id INT NULL,
  operational_profile_code ENUM('MEDICO_GENERALISTA', 'RESIDENTE_ANESTESIOLOGIA') NULL,
  admission_policy ENUM(
    'PINNED_QUALIFICATION',
    'ALL_CFM_SPECIALTIES',
    'ALL_CFM_EXCEPT_GENERALIST'
  ) NOT NULL DEFAULT 'PINNED_QUALIFICATION',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_schedule_context_specialty
    (institution_id, hospital_id, sector_id, medical_specialty_id),
  UNIQUE KEY uniq_schedule_context_operational_profile
    (institution_id, hospital_id, sector_id, operational_profile_code),
  UNIQUE KEY uniq_schedule_context_topology_id
    (institution_id, hospital_id, sector_id, id),
  KEY idx_schedule_context_institution (institution_id, id),
  KEY idx_schedule_context_hospital (hospital_id),
  KEY idx_schedule_context_sector (sector_id),
  KEY idx_schedule_context_medical_specialty (medical_specialty_id),
  CONSTRAINT fk_schedule_context_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_schedule_context_hospital
    FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_schedule_context_sector
    FOREIGN KEY (sector_id) REFERENCES sectors(id),
  CONSTRAINT fk_schedule_context_medical_specialty
    FOREIGN KEY (medical_specialty_id) REFERENCES medical_specialties(id),
  CONSTRAINT fk_schedule_context_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals(institution_id, id),
  CONSTRAINT fk_schedule_context_sector_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors(institution_id, hospital_id, id),
  CONSTRAINT chk_schedule_context_qualification_matches_policy CHECK (
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
      admission_policy IN ('ALL_CFM_SPECIALTIES', 'ALL_CFM_EXCEPT_GENERALIST')
      AND medical_specialty_id IS NULL
      AND operational_profile_code IS NULL
    )
  )
);

-- Completa uma execução parcial de uma versão anterior desta migration.
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND INDEX_NAME = 'uniq_schedule_context_topology_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE schedule_contexts ADD UNIQUE KEY uniq_schedule_context_topology_id (institution_id, hospital_id, sector_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND CONSTRAINT_NAME = 'fk_schedule_context_hospital_topology'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE schedule_contexts ADD CONSTRAINT fk_schedule_context_hospital_topology FOREIGN KEY (institution_id, hospital_id) REFERENCES hospitals(institution_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND CONSTRAINT_NAME = 'fk_schedule_context_sector_topology'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE schedule_contexts ADD CONSTRAINT fk_schedule_context_sector_topology FOREIGN KEY (institution_id, hospital_id, sector_id) REFERENCES sectors(institution_id, hospital_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Expande o enum se uma execução anterior criou só MEDICO_GENERALISTA.
ALTER TABLE professionals
  MODIFY COLUMN operational_profile_code
  ENUM('MEDICO_GENERALISTA', 'RESIDENTE_ANESTESIOLOGIA') NULL;
ALTER TABLE schedule_contexts
  MODIFY COLUMN operational_profile_code
  ENUM('MEDICO_GENERALISTA', 'RESIDENTE_ANESTESIOLOGIA') NULL;

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND COLUMN_NAME = 'admission_policy'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE schedule_contexts ADD COLUMN admission_policy ENUM(''PINNED_QUALIFICATION'', ''ALL_CFM_SPECIALTIES'', ''ALL_CFM_EXCEPT_GENERALIST'') NOT NULL DEFAULT ''PINNED_QUALIFICATION''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @old_check := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND CONSTRAINT_NAME = 'chk_schedule_context_exactly_one_qualification'
    AND CONSTRAINT_TYPE = 'CHECK'
);
SET @ddl := IF(
  @old_check = 1,
  'ALTER TABLE schedule_contexts DROP CHECK chk_schedule_context_exactly_one_qualification',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @new_check := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'schedule_contexts'
    AND CONSTRAINT_NAME = 'chk_schedule_context_qualification_matches_policy'
    AND CONSTRAINT_TYPE = 'CHECK'
);
SET @ddl := IF(
  @new_check = 0,
  'ALTER TABLE schedule_contexts ADD CONSTRAINT chk_schedule_context_qualification_matches_policy CHECK (((admission_policy = ''PINNED_QUALIFICATION'' AND ((medical_specialty_id IS NOT NULL AND operational_profile_code IS NULL) OR (medical_specialty_id IS NULL AND operational_profile_code IS NOT NULL))) OR (admission_policy IN (''ALL_CFM_SPECIALTIES'', ''ALL_CFM_EXCEPT_GENERALIST'') AND medical_specialty_id IS NULL AND operational_profile_code IS NULL)))',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'schedule_context_id'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE shift_instances ADD COLUMN schedule_context_id INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND INDEX_NAME = 'idx_shift_instances_schedule_context'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE shift_instances ADD INDEX idx_shift_instances_schedule_context (institution_id, schedule_context_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND CONSTRAINT_NAME = 'fk_shift_instances_schedule_context'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE shift_instances ADD CONSTRAINT fk_shift_instances_schedule_context FOREIGN KEY (schedule_context_id) REFERENCES schedule_contexts(id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND CONSTRAINT_NAME = 'fk_shift_instance_schedule_context_topology'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_exists = 0,
  'ALTER TABLE shift_instances ADD CONSTRAINT fk_shift_instance_schedule_context_topology FOREIGN KEY (institution_id, hospital_id, sector_id, schedule_context_id) REFERENCES schedule_contexts(institution_id, hospital_id, sector_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill deliberadamente estreito. Texto desconhecido fica NULL e exige
-- classificação humana; nenhuma heurística escolhe especialidade por usuário.
UPDATE professionals AS professional
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'ANESTESIOLOGIA'
SET professional.medical_specialty_id = specialty.id
WHERE professional.medical_specialty_id IS NULL
  AND professional.operational_profile_code IS NULL
  AND LOWER(TRIM(professional.specialty)) = 'anestesiologia';

UPDATE professionals AS professional
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'ORTOPEDIA_E_TRAUMATOLOGIA'
SET professional.medical_specialty_id = specialty.id
WHERE professional.medical_specialty_id IS NULL
  AND professional.operational_profile_code IS NULL
  AND LOWER(TRIM(professional.specialty)) = 'ortopedia';

UPDATE professionals AS professional
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'CLINICA_MEDICA'
SET professional.medical_specialty_id = specialty.id
WHERE professional.medical_specialty_id IS NULL
  AND professional.operational_profile_code IS NULL
  AND LOWER(TRIM(professional.specialty)) IN ('clínica geral', 'clínico geral');

-- Cada especialidade/perfil reconhecido cria no máximo um contexto por
-- instituição + hospital + setor. A qualificação desconhecida não cria linha.
INSERT INTO schedule_contexts (
  institution_id,
  hospital_id,
  sector_id,
  medical_specialty_id,
  operational_profile_code,
  active
)
SELECT DISTINCT
  shift_instance.institution_id,
  shift_instance.hospital_id,
  shift_instance.sector_id,
  specialty.id,
  NULL,
  TRUE
FROM shift_instances AS shift_instance
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'ANESTESIOLOGIA'
WHERE shift_instance.schedule_context_id IS NULL
  AND LOWER(TRIM(shift_instance.specialty)) = 'anestesiologia'
ON DUPLICATE KEY UPDATE active = schedule_contexts.active;

INSERT INTO schedule_contexts (
  institution_id,
  hospital_id,
  sector_id,
  medical_specialty_id,
  operational_profile_code,
  active
)
SELECT DISTINCT
  shift_instance.institution_id,
  shift_instance.hospital_id,
  shift_instance.sector_id,
  specialty.id,
  NULL,
  TRUE
FROM shift_instances AS shift_instance
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'ORTOPEDIA_E_TRAUMATOLOGIA'
WHERE shift_instance.schedule_context_id IS NULL
  AND LOWER(TRIM(shift_instance.specialty)) = 'ortopedia'
ON DUPLICATE KEY UPDATE active = schedule_contexts.active;

INSERT INTO schedule_contexts (
  institution_id,
  hospital_id,
  sector_id,
  medical_specialty_id,
  operational_profile_code,
  admission_policy,
  active
)
SELECT DISTINCT
  shift_instance.institution_id,
  shift_instance.hospital_id,
  shift_instance.sector_id,
  specialty.id,
  NULL,
  'PINNED_QUALIFICATION',
  TRUE
FROM shift_instances AS shift_instance
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'CLINICA_MEDICA'
WHERE shift_instance.schedule_context_id IS NULL
  AND LOWER(TRIM(shift_instance.specialty)) IN ('clínica geral', 'clínico geral')
ON DUPLICATE KEY UPDATE active = schedule_contexts.active;

UPDATE shift_instances AS shift_instance
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'ANESTESIOLOGIA'
INNER JOIN schedule_contexts AS schedule_context
  ON schedule_context.institution_id = shift_instance.institution_id
  AND schedule_context.hospital_id = shift_instance.hospital_id
  AND schedule_context.sector_id = shift_instance.sector_id
  AND schedule_context.medical_specialty_id = specialty.id
  AND schedule_context.operational_profile_code IS NULL
SET shift_instance.schedule_context_id = schedule_context.id
WHERE shift_instance.schedule_context_id IS NULL
  AND LOWER(TRIM(shift_instance.specialty)) = 'anestesiologia';

UPDATE shift_instances AS shift_instance
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'ORTOPEDIA_E_TRAUMATOLOGIA'
INNER JOIN schedule_contexts AS schedule_context
  ON schedule_context.institution_id = shift_instance.institution_id
  AND schedule_context.hospital_id = shift_instance.hospital_id
  AND schedule_context.sector_id = shift_instance.sector_id
  AND schedule_context.medical_specialty_id = specialty.id
  AND schedule_context.operational_profile_code IS NULL
SET shift_instance.schedule_context_id = schedule_context.id
WHERE shift_instance.schedule_context_id IS NULL
  AND LOWER(TRIM(shift_instance.specialty)) = 'ortopedia';

UPDATE shift_instances AS shift_instance
INNER JOIN medical_specialties AS specialty
  ON specialty.code = 'CLINICA_MEDICA'
INNER JOIN schedule_contexts AS schedule_context
  ON schedule_context.institution_id = shift_instance.institution_id
  AND schedule_context.hospital_id = shift_instance.hospital_id
  AND schedule_context.sector_id = shift_instance.sector_id
  AND schedule_context.medical_specialty_id = specialty.id
  AND schedule_context.operational_profile_code IS NULL
SET shift_instance.schedule_context_id = schedule_context.id
WHERE shift_instance.schedule_context_id IS NULL
  AND LOWER(TRIM(shift_instance.specialty)) IN ('clínica geral', 'clínico geral');
