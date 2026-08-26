-- 2026-08-26 — convites de escala (gestor gera, médico resgata).
-- Aditiva e rerodável. Não cria setores nem usuários.

CREATE TABLE IF NOT EXISTS schedule_invites (
  id INT NOT NULL AUTO_INCREMENT,
  institution_id INT NOT NULL,
  hospital_id INT NOT NULL,
  sector_id INT NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  created_by_user_id INT NOT NULL,
  max_redemptions INT NOT NULL DEFAULT 40,
  redeemed_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_schedule_invite_code_hash (code_hash),
  KEY idx_schedule_invite_institution (institution_id, hospital_id, sector_id),
  CONSTRAINT fk_schedule_invite_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_schedule_invite_hospital
    FOREIGN KEY (hospital_id) REFERENCES hospitals(id),
  CONSTRAINT fk_schedule_invite_sector
    FOREIGN KEY (sector_id) REFERENCES sectors(id),
  CONSTRAINT fk_schedule_invite_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  CONSTRAINT fk_schedule_invite_hospital_topology
    FOREIGN KEY (institution_id, hospital_id)
    REFERENCES hospitals(institution_id, id),
  CONSTRAINT fk_schedule_invite_sector_topology
    FOREIGN KEY (institution_id, hospital_id, sector_id)
    REFERENCES sectors(institution_id, hospital_id, id)
);
