-- Aditiva, rerodável. Aplicar antes do código. Nenhum backfill/verificação automática.
-- Audit account-wide não tem FK de usuário: exclusão não apaga a rastreabilidade.
CREATE TABLE IF NOT EXISTS account_audit_events (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id INT NULL,
  subject_user_id INT NOT NULL,
  action VARCHAR(40) NOT NULL,
  outcome ENUM('REQUESTED','SUCCEEDED','REJECTED','FAILED') NOT NULL,
  contact_id INT NULL,
  session_version INT NULL,
  parent_event_id INT NULL,
  verification_cleared TINYINT(1) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_account_audit_subject (subject_user_id, id),
  KEY idx_account_audit_parent (parent_event_id)
) ENGINE=InnoDB;

-- Um desafio corrente por usuário. Sem telefone/OTP; SID privado não vai para audit.
CREATE TABLE IF NOT EXISTS whatsapp_verification_challenges (
  user_id INT NOT NULL PRIMARY KEY,
  challenge_id CHAR(36) NOT NULL,
  contact_id INT NOT NULL,
  session_version INT NOT NULL,
  state ENUM('STARTING','READY','INVALIDATED','CONSUMED','FAILED') NOT NULL,
  provider_verification_sid VARCHAR(34) NULL,
  request_audit_id INT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_whatsapp_verification_challenge (challenge_id),
  CONSTRAINT fk_whatsapp_challenge_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_whatsapp_challenge_contact FOREIGN KEY (contact_id) REFERENCES user_contact_channels(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Falha explícita em tabela homônima incompatível. DDL MySQL não é transacional:
-- se o postflight falhar, não promover código; inspecionar o schema sem remover dados.
SET @wa_account_contract := (
  SELECT SUM(CASE WHEN
    (TABLE_NAME = 'account_audit_events' AND (
      (COLUMN_NAME IN ('id','subject_user_id') AND DATA_TYPE = 'int' AND IS_NULLABLE = 'NO') OR
      (COLUMN_NAME IN ('actor_user_id','contact_id','session_version','parent_event_id') AND DATA_TYPE = 'int' AND IS_NULLABLE = 'YES') OR
      (COLUMN_NAME = 'action' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 40 AND IS_NULLABLE = 'NO') OR
      (COLUMN_NAME = 'outcome' AND COLUMN_TYPE = 'enum(''REQUESTED'',''SUCCEEDED'',''REJECTED'',''FAILED'')' AND IS_NULLABLE = 'NO') OR
      (COLUMN_NAME = 'verification_cleared' AND DATA_TYPE = 'tinyint' AND IS_NULLABLE = 'YES') OR
      (COLUMN_NAME = 'created_at' AND DATA_TYPE = 'timestamp' AND IS_NULLABLE = 'NO')
    )) OR
    (TABLE_NAME = 'whatsapp_verification_challenges' AND (
      (COLUMN_NAME IN ('user_id','contact_id','session_version','request_audit_id') AND DATA_TYPE = 'int' AND IS_NULLABLE = 'NO') OR
      (COLUMN_NAME = 'challenge_id' AND DATA_TYPE = 'char' AND CHARACTER_MAXIMUM_LENGTH = 36 AND IS_NULLABLE = 'NO') OR
      (COLUMN_NAME = 'provider_verification_sid' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 34 AND IS_NULLABLE = 'YES') OR
      (COLUMN_NAME = 'state' AND COLUMN_TYPE = 'enum(''STARTING'',''READY'',''INVALIDATED'',''CONSUMED'',''FAILED'')' AND IS_NULLABLE = 'NO') OR
      (COLUMN_NAME IN ('expires_at','created_at','updated_at') AND DATA_TYPE = 'timestamp' AND IS_NULLABLE = 'NO')
    )) THEN 1 ELSE 0 END) = 20
  FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
)
AND (SELECT COUNT(*) = 2 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('account_audit_events','whatsapp_verification_challenges') AND ENGINE = 'InnoDB')
AND (SELECT COUNT(*) = 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'account_audit_events' AND COLUMN_NAME = 'id' AND EXTRA LIKE '%auto_increment%')
AND (SELECT COUNT(*) = 0 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'account_audit_events' AND REFERENCED_TABLE_NAME IS NOT NULL)
AND (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id' FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_audit_events' AND INDEX_NAME = 'PRIMARY' AND NON_UNIQUE = 0)
AND (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'user_id' FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'whatsapp_verification_challenges' AND INDEX_NAME = 'PRIMARY' AND NON_UNIQUE = 0)
AND (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'challenge_id' FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'whatsapp_verification_challenges' AND INDEX_NAME = 'uniq_whatsapp_verification_challenge' AND NON_UNIQUE = 0)
AND (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'subject_user_id,id' FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_audit_events' AND INDEX_NAME = 'idx_account_audit_subject')
AND (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'parent_event_id' FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_audit_events' AND INDEX_NAME = 'idx_account_audit_parent')
AND (SELECT COUNT(*) = 2 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
  JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
    AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
  WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_SCHEMA = DATABASE()
    AND k.TABLE_NAME = 'whatsapp_verification_challenges' AND r.DELETE_RULE = 'CASCADE'
    AND ((k.COLUMN_NAME = 'user_id' AND k.REFERENCED_TABLE_NAME = 'users' AND k.REFERENCED_COLUMN_NAME = 'id')
      OR (k.COLUMN_NAME = 'contact_id' AND k.REFERENCED_TABLE_NAME = 'user_contact_channels' AND k.REFERENCED_COLUMN_NAME = 'id'))
);
SET @wa_account_sql := IF(@wa_account_contract, 'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_ACCOUNT_SCHEMA_MISMATCH'', ''$'')');
PREPARE wa_account_stmt FROM @wa_account_sql;
EXECUTE wa_account_stmt;
DEALLOCATE PREPARE wa_account_stmt;
