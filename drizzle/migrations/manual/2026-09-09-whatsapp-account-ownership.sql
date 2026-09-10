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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

-- Manifesto canônico integral (36 registros), não contagem de campos reconhecidos.
-- Charset/collation explícitos no CREATE. Defaults, EXTRA, geração, índices,
-- FKs, constraints e ausência de triggers integram a assinatura. Nenhum dado
-- de aplicação/auto_increment corrente/cardinalidade estatística é comparado.
-- DDL MySQL não é transacional: em falha, não promover código nem apagar dados.
SET @wa_account_old_concat_limit := @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 65536;
WITH expected AS (
  SELECT 'T|account_audit_events' AS k, JSON_ARRAY('TABLE','account_audit_events','BASE TABLE','InnoDB','Dynamic','utf8mb4_0900_ai_ci','row_format=DYNAMIC','') AS v
  UNION ALL SELECT 'T|whatsapp_verification_challenges' AS k, JSON_ARRAY('TABLE','whatsapp_verification_challenges','BASE TABLE','InnoDB','Dynamic','utf8mb4_0900_ai_ci','row_format=DYNAMIC','') AS v
  UNION ALL SELECT 'C|account_audit_events|001' AS k, JSON_ARRAY('COLUMN','account_audit_events',1,'id','int','NO',NULL,'auto_increment','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|account_audit_events|002' AS k, JSON_ARRAY('COLUMN','account_audit_events',2,'actor_user_id','int','YES',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|account_audit_events|003' AS k, JSON_ARRAY('COLUMN','account_audit_events',3,'subject_user_id','int','NO',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|account_audit_events|004' AS k, JSON_ARRAY('COLUMN','account_audit_events',4,'action','varchar(40)','NO',NULL,'','','utf8mb4','utf8mb4_0900_ai_ci','') AS v
  UNION ALL SELECT 'C|account_audit_events|005' AS k, JSON_ARRAY('COLUMN','account_audit_events',5,'outcome','enum(''REQUESTED'',''SUCCEEDED'',''REJECTED'',''FAILED'')','NO',NULL,'','','utf8mb4','utf8mb4_0900_ai_ci','') AS v
  UNION ALL SELECT 'C|account_audit_events|006' AS k, JSON_ARRAY('COLUMN','account_audit_events',6,'contact_id','int','YES',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|account_audit_events|007' AS k, JSON_ARRAY('COLUMN','account_audit_events',7,'session_version','int','YES',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|account_audit_events|008' AS k, JSON_ARRAY('COLUMN','account_audit_events',8,'parent_event_id','int','YES',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|account_audit_events|009' AS k, JSON_ARRAY('COLUMN','account_audit_events',9,'verification_cleared','tinyint(1)','YES',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|account_audit_events|010' AS k, JSON_ARRAY('COLUMN','account_audit_events',10,'created_at','timestamp','NO','CURRENT_TIMESTAMP','DEFAULT_GENERATED','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|001' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',1,'user_id','int','NO',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|002' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',2,'challenge_id','char(36)','NO',NULL,'','','utf8mb4','utf8mb4_0900_ai_ci','') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|003' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',3,'contact_id','int','NO',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|004' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',4,'session_version','int','NO',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|005' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',5,'state','enum(''STARTING'',''READY'',''INVALIDATED'',''CONSUMED'',''FAILED'')','NO',NULL,'','','utf8mb4','utf8mb4_0900_ai_ci','') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|006' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',6,'provider_verification_sid','varchar(34)','YES',NULL,'','','utf8mb4','utf8mb4_0900_ai_ci','') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|007' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',7,'request_audit_id','int','NO',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|008' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',8,'expires_at','timestamp','NO',NULL,'','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|009' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',9,'created_at','timestamp','NO','CURRENT_TIMESTAMP','DEFAULT_GENERATED','',NULL,NULL,'') AS v
  UNION ALL SELECT 'C|whatsapp_verification_challenges|010' AS k, JSON_ARRAY('COLUMN','whatsapp_verification_challenges',10,'updated_at','timestamp','NO','CURRENT_TIMESTAMP','DEFAULT_GENERATED on update CURRENT_TIMESTAMP','',NULL,NULL,'') AS v
  UNION ALL SELECT 'I|account_audit_events|PRIMARY|1' AS k, JSON_ARRAY('INDEX','account_audit_events','PRIMARY',0,1,'id','A',NULL,'','BTREE','','','YES',NULL) AS v
  UNION ALL SELECT 'I|account_audit_events|idx_account_audit_subject|1' AS k, JSON_ARRAY('INDEX','account_audit_events','idx_account_audit_subject',1,1,'subject_user_id','A',NULL,'','BTREE','','','YES',NULL) AS v
  UNION ALL SELECT 'I|account_audit_events|idx_account_audit_subject|2' AS k, JSON_ARRAY('INDEX','account_audit_events','idx_account_audit_subject',1,2,'id','A',NULL,'','BTREE','','','YES',NULL) AS v
  UNION ALL SELECT 'I|account_audit_events|idx_account_audit_parent|1' AS k, JSON_ARRAY('INDEX','account_audit_events','idx_account_audit_parent',1,1,'parent_event_id','A',NULL,'YES','BTREE','','','YES',NULL) AS v
  UNION ALL SELECT 'I|whatsapp_verification_challenges|PRIMARY|1' AS k, JSON_ARRAY('INDEX','whatsapp_verification_challenges','PRIMARY',0,1,'user_id','A',NULL,'','BTREE','','','YES',NULL) AS v
  UNION ALL SELECT 'I|whatsapp_verification_challenges|uniq_whatsapp_verification_challenge|1' AS k, JSON_ARRAY('INDEX','whatsapp_verification_challenges','uniq_whatsapp_verification_challenge',0,1,'challenge_id','A',NULL,'','BTREE','','','YES',NULL) AS v
  UNION ALL SELECT 'I|whatsapp_verification_challenges|fk_whatsapp_challenge_contact|1' AS k, JSON_ARRAY('INDEX','whatsapp_verification_challenges','fk_whatsapp_challenge_contact',1,1,'contact_id','A',NULL,'','BTREE','','','YES',NULL) AS v
  UNION ALL SELECT 'F|whatsapp_verification_challenges|fk_whatsapp_challenge_contact|1' AS k, JSON_ARRAY('FK','whatsapp_verification_challenges','fk_whatsapp_challenge_contact','contact_id',1,1,'SELF','user_contact_channels','id','PRIMARY','NONE','NO ACTION','CASCADE') AS v
  UNION ALL SELECT 'F|whatsapp_verification_challenges|fk_whatsapp_challenge_user|1' AS k, JSON_ARRAY('FK','whatsapp_verification_challenges','fk_whatsapp_challenge_user','user_id',1,1,'SELF','users','id','PRIMARY','NONE','NO ACTION','CASCADE') AS v
  UNION ALL SELECT 'K|account_audit_events|PRIMARY' AS k, JSON_ARRAY('CONSTRAINT','account_audit_events','PRIMARY','PRIMARY KEY','YES') AS v
  UNION ALL SELECT 'K|whatsapp_verification_challenges|PRIMARY' AS k, JSON_ARRAY('CONSTRAINT','whatsapp_verification_challenges','PRIMARY','PRIMARY KEY','YES') AS v
  UNION ALL SELECT 'K|whatsapp_verification_challenges|uniq_whatsapp_verification_challenge' AS k, JSON_ARRAY('CONSTRAINT','whatsapp_verification_challenges','uniq_whatsapp_verification_challenge','UNIQUE','YES') AS v
  UNION ALL SELECT 'K|whatsapp_verification_challenges|fk_whatsapp_challenge_contact' AS k, JSON_ARRAY('CONSTRAINT','whatsapp_verification_challenges','fk_whatsapp_challenge_contact','FOREIGN KEY','YES') AS v
  UNION ALL SELECT 'K|whatsapp_verification_challenges|fk_whatsapp_challenge_user' AS k, JSON_ARRAY('CONSTRAINT','whatsapp_verification_challenges','fk_whatsapp_challenge_user','FOREIGN KEY','YES') AS v
)
SELECT COUNT(*), SHA2(GROUP_CONCAT(CAST(v AS CHAR) ORDER BY BINARY k SEPARATOR '\n'),256)
INTO @wa_account_expected_count, @wa_account_expected_hash FROM expected;

WITH actual AS (
  SELECT CONCAT('T|',TABLE_NAME) AS k,
    JSON_ARRAY('TABLE',TABLE_NAME,TABLE_TYPE,ENGINE,ROW_FORMAT,TABLE_COLLATION,CREATE_OPTIONS,TABLE_COMMENT) AS v
    FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('account_audit_events','whatsapp_verification_challenges')
  UNION ALL
  SELECT CONCAT('C|',TABLE_NAME,'|',LPAD(ORDINAL_POSITION,3,'0')),
    JSON_ARRAY('COLUMN',TABLE_NAME,ORDINAL_POSITION,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,
      COLUMN_DEFAULT,EXTRA,GENERATION_EXPRESSION,CHARACTER_SET_NAME,COLLATION_NAME,COLUMN_COMMENT)
    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('account_audit_events','whatsapp_verification_challenges')
  UNION ALL
  SELECT CONCAT('I|',TABLE_NAME,'|',INDEX_NAME,'|',SEQ_IN_INDEX),
    JSON_ARRAY('INDEX',TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,COLLATION,
      SUB_PART,NULLABLE,INDEX_TYPE,COMMENT,INDEX_COMMENT,IS_VISIBLE,EXPRESSION)
    FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('account_audit_events','whatsapp_verification_challenges')
  UNION ALL
  SELECT CONCAT('F|',k.TABLE_NAME,'|',k.CONSTRAINT_NAME,'|',k.ORDINAL_POSITION),
    JSON_ARRAY('FK',k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.ORDINAL_POSITION,k.POSITION_IN_UNIQUE_CONSTRAINT,
      IF(k.REFERENCED_TABLE_SCHEMA=DATABASE(),'SELF',k.REFERENCED_TABLE_SCHEMA),
      k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UNIQUE_CONSTRAINT_NAME,r.MATCH_OPTION,r.UPDATE_RULE,r.DELETE_RULE)
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
    JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA
      AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME
    WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME IN ('account_audit_events','whatsapp_verification_challenges')
  UNION ALL
  SELECT CONCAT('K|',TABLE_NAME,'|',CONSTRAINT_NAME),
    JSON_ARRAY('CONSTRAINT',TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE,ENFORCED)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('account_audit_events','whatsapp_verification_challenges')
  UNION ALL
  SELECT CONCAT('R|',EVENT_OBJECT_TABLE,'|',TRIGGER_NAME), JSON_ARRAY('UNEXPECTED_TRIGGER',TRIGGER_NAME)
    FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
      AND EVENT_OBJECT_TABLE IN ('account_audit_events','whatsapp_verification_challenges')
)
SELECT COUNT(*), SHA2(GROUP_CONCAT(CAST(v AS CHAR) ORDER BY BINARY k SEPARATOR '\n'),256)
INTO @wa_account_actual_count, @wa_account_actual_hash FROM actual;
SET SESSION group_concat_max_len = @wa_account_old_concat_limit;

SET @wa_account_contract := @wa_account_actual_count = @wa_account_expected_count
  AND @wa_account_actual_hash = @wa_account_expected_hash;
SET @wa_account_sql := IF(COALESCE(@wa_account_contract,0), 'SELECT 1',
  'SELECT JSON_EXTRACT(''WHATSAPP_ACCOUNT_SCHEMA_MISMATCH'', ''$'')');
PREPARE wa_account_stmt FROM @wa_account_sql;
EXECUTE wa_account_stmt;
DEALLOCATE PREPARE wa_account_stmt;
