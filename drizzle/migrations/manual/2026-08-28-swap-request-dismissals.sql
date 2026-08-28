-- 2026-08-28 — recusa individual de oferta ABERTA.
-- Aditiva e rerodável. Aplicar no staging ANTES do merge.
-- Recusar cessão/troca sem destinatário não pode marcar REJECTED_BY_PEER
-- para todo mundo: a oferta permanece PENDING; só some da lista de quem
-- recusou. Oferta direcionada continua fechando no status da solicitação.

CREATE TABLE IF NOT EXISTS swap_request_dismissals (
  id INT NOT NULL AUTO_INCREMENT,
  swap_request_id INT NOT NULL,
  institution_id INT NOT NULL,
  user_id INT NOT NULL,
  professional_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_swap_dismissal_actor (swap_request_id, user_id),
  KEY idx_swap_dismissal_institution (institution_id, swap_request_id),
  CONSTRAINT fk_swap_dismissal_request
    FOREIGN KEY (swap_request_id) REFERENCES swap_requests(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_swap_dismissal_institution
    FOREIGN KEY (institution_id) REFERENCES institutions(id),
  CONSTRAINT fk_swap_dismissal_user
    FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_swap_dismissal_professional
    FOREIGN KEY (professional_id) REFERENCES professionals(id)
);
