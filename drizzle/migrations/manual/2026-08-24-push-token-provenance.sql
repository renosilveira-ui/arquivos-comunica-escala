-- PROMOTION GATE: executar somente com todos os writers quiescidos. MySQL faz
-- implicit commit em DDL, portanto este arquivo NÃO promete atomicidade entre
-- a limpeza e o ALTER. O WRITE lock reduz concorrência acidental, mas não
-- substitui a janela de manutenção verificada pelo operador.
LOCK TABLES push_tokens WRITE;

-- Estado legado ambíguo não escolhe owner: toda cópia de um token duplicado
-- é removida e o dispositivo precisa registrar novamente sob sessão válida.
CREATE TEMPORARY TABLE duplicate_push_token_ids (
  id INT NOT NULL PRIMARY KEY
);

-- A janela herda exatamente a igualdade/collation da coluna legada. A tabela
-- temporária guarda somente IDs, evitando que o default atual do schema mude
-- a igualdade no JOIN de quarentena (por exemplo, *_ci legado vs *_bin atual).
INSERT INTO duplicate_push_token_ids (id)
SELECT duplicate_rows.id
FROM (
  SELECT
    id,
    COUNT(*) OVER (PARTITION BY token) AS duplicate_count
  FROM push_tokens
) AS duplicate_rows
WHERE duplicate_rows.duplicate_count > 1;

DELETE push_tokens
FROM push_tokens
INNER JOIN duplicate_push_token_ids
  ON duplicate_push_token_ids.id = push_tokens.id;

DROP TEMPORARY TABLE duplicate_push_token_ids;

-- VARCHAR usa PAD SPACE em collations legadas; nenhum token Expo válido tem
-- whitespace. Quarentena preventiva evita que bytes diferentes compartilhem
-- igualdade no índice enquanto o mutex usa SHA-256 dos bytes exatos.
DELETE FROM push_tokens
WHERE token REGEXP '[[:space:]]';

-- O token Expo pertence à conta/dispositivo. institution_id registra somente
-- a proveniência do tenant ativo no momento do registro e pode estar ausente
-- antes da hidratação do tenant no cliente.
ALTER TABLE push_tokens
  MODIFY COLUMN institution_id INT NULL,
  MODIFY COLUMN token VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  ADD UNIQUE INDEX uniq_push_token (token),
  ADD CONSTRAINT chk_push_token_no_whitespace
    CHECK (token NOT REGEXP '[[:space:]]');

UNLOCK TABLES;
