-- 2026-09-01 — fundação V1 limpa da fence de prontidão institucional.
--
-- Esta migration é estritamente aditiva: cria duas tabelas próprias e
-- observadores de revisão. Ela não cria calendário, plantão, vínculo,
-- profissional, gestor ou configuração clínica; tampouco ativa uma API,
-- autorização de publicação ou envio de notificação.
--
-- Aplique somente pelo instalador dedicado
-- scripts/apply-readiness-fence-v1-migration.ts. O instalador faz preflight
-- do INFORMATION_SCHEMA, recusa estado parcial/incompatível e só grava o
-- recibo singleton depois de reler toda a cobertura. Não execute este arquivo
-- no executor SQL genérico: ele não faz o preflight do catálogo nem recusa
-- uma instalação parcial antes de acrescentar DDL.
-- Se um schema-push tiver criado exatamente as duas tabelas abaixo, ainda sem
-- triggers V1 nem recibo, o instalador dedicado reconhece somente esse estado
-- PREPARED e instala os observadores. Trigger ou recibo parcial continua
-- bloqueado para auditoria humana.
--
-- O contrato V1 observa alterações em fontes de topologia, contextos,
-- templates, calendário, alocações, cobertura de gestores/profissionais e
-- disponibilidade de push. Seu preflight valida apenas presença de tabelas e
-- colunas necessárias; ele não certifica a topologia nem prontidão clínica.
-- Especialidade textual, vínculo N:N setor-especialidade, confiança de e-mail,
-- UI, ciência de publicação e regras de autorização pertencem a frentes
-- posteriores e NÃO entram nesta cobertura.

CREATE TABLE institution_readiness_fences (
  institution_id INT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (institution_id),
  CONSTRAINT fk_rdf_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE institution_readiness_fence_installations (
  id TINYINT UNSIGNED NOT NULL,
  coverage_version VARCHAR(64) NOT NULL,
  coverage_hash CHAR(64) NOT NULL,
  installed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- A mesma revisão pode avançar mais do que uma vez em uma operação composta;
-- isso é seguro. O contrato é invalidar conservadoramente, nunca aprovar uma
-- leitura que talvez tenha observado estado antigo.

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_i_ai AFTER INSERT ON institutions FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_i_au AFTER UPDATE ON institutions FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.id AS institution_id
    UNION
    SELECT NEW.id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- BEFORE preserva a observação até quando o banco encadear exclusões.
-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_i_bd BEFORE DELETE ON institutions FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_h_ai AFTER INSERT ON hospitals FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_h_au AFTER UPDATE ON hospitals FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_h_bd BEFORE DELETE ON hospitals FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_s_ai AFTER INSERT ON sectors FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_s_au AFTER UPDATE ON sectors FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_s_bd BEFORE DELETE ON sectors FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_sc_ai AFTER INSERT ON schedule_contexts FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_sc_au AFTER UPDATE ON schedule_contexts FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_sc_bd BEFORE DELETE ON schedule_contexts FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_st_ai AFTER INSERT ON shift_templates FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_st_au AFTER UPDATE ON shift_templates FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_st_bd BEFORE DELETE ON shift_templates FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_si_ai AFTER INSERT ON shift_instances FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_si_au AFTER UPDATE ON shift_instances FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_si_bd BEFORE DELETE ON shift_instances FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_sa_ai AFTER INSERT ON shift_assignments_v2 FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_sa_au AFTER UPDATE ON shift_assignments_v2 FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_sa_bd BEFORE DELETE ON shift_assignments_v2 FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pi_ai AFTER INSERT ON professional_institutions FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pi_au AFTER UPDATE ON professional_institutions FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pi_bd BEFORE DELETE ON professional_institutions FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pa_ai AFTER INSERT ON professional_access FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pa_au AFTER UPDATE ON professional_access FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pa_bd BEFORE DELETE ON professional_access FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_ms_ai AFTER INSERT ON manager_scope FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_ms_au AFTER UPDATE ON manager_scope FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_ms_bd BEFORE DELETE ON manager_scope FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_mr_ai AFTER INSERT ON monthly_rosters FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (NEW.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_mr_au AFTER UPDATE ON monthly_rosters FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT affected.institution_id, 1
  FROM (
    SELECT OLD.institution_id AS institution_id
    UNION
    SELECT NEW.institution_id AS institution_id
  ) AS affected
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_mr_bd BEFORE DELETE ON monthly_rosters FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  VALUES (OLD.institution_id, 1)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- Usuário e profissional não carregam tenant próprio: os observadores partem
-- somente de vínculos institucionais ativos. Sem vínculo ativo não há escopo
-- institucional a invalidar.
-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_u_au AFTER UPDATE ON users FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT DISTINCT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = NEW.id
    AND membership.active = TRUE
    AND (
      NOT (OLD.email <=> NEW.email)
      OR NOT (OLD.approval_status <=> NEW.approval_status)
      OR NOT (OLD.deleted_at <=> NEW.deleted_at)
    )
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_u_bd BEFORE DELETE ON users FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT DISTINCT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = OLD.id
    AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_p_au AFTER UPDATE ON professionals FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT DISTINCT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.professional_id = NEW.id
    AND membership.active = TRUE
    AND NOT (OLD.user_id <=> NEW.user_id)
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_p_bd BEFORE DELETE ON professionals FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT DISTINCT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.professional_id = OLD.id
    AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- O token pertence ao usuário e pode cobrir múltiplas instituições ativas.
-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pt_ai AFTER INSERT ON push_tokens FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT DISTINCT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = NEW.user_id
    AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pt_au AFTER UPDATE ON push_tokens FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT DISTINCT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id IN (OLD.user_id, NEW.user_id)
    AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

-- @readiness-fence-trigger
CREATE TRIGGER trg_rdf_pt_bd BEFORE DELETE ON push_tokens FOR EACH ROW
  INSERT INTO institution_readiness_fences (institution_id, revision)
  SELECT DISTINCT membership.institution_id, 1
  FROM professional_institutions AS membership
  WHERE membership.user_id = OLD.user_id
    AND membership.active = TRUE
  ON DUPLICATE KEY UPDATE revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
