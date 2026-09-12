-- 2026-09-12 — a instituição herda o fuso dos hospitais dela.
--
-- Regra do PO: registrar a localidade onde ela realmente é, e casar o melhor
-- fuso a ela.
--
-- Estado encontrado no banco real: os QUATRO hospitais têm endereço e
-- coordenada de Fortaleza/CE e `time_zone = 'America/Fortaleza'`, correto.
-- As TRÊS instituições — todas organizações de Fortaleza, o nome de duas
-- delas diz isso — estavam com `America/Sao_Paulo`, que é apenas o DEFAULT
-- da coluna.
--
-- Por que ninguém corrigiu antes: `scripts/provision-hospital-locations.ts`
-- tentou gravar Fortaleza com `time_zone = COALESCE(time_zone, ?)`. A coluna
-- é NOT NULL DEFAULT 'America/Sao_Paulo', então nunca esteve nula e o
-- COALESCE nunca disparou. Um no-op silencioso.
--
-- Hoje os dois fusos são UTC-3 e nada calcula errado. Mas eles NÃO são
-- historicamente iguais: São Paulo teve horário de verão até 2019, Fortaleza
-- nunca teve. Um registro falso sobre onde a instituição está é dívida que
-- só cobra juros depois — quando entrar uma instituição fora de UTC-3, ou
-- quando alguém consultar data anterior a 2019.
--
-- COMO corrige, e por que assim: a instituição herda o fuso dos hospitais
-- dela, quando TODOS concordam num único valor válido. Sem id, nome ou fuso
-- fixo no arquivo — a regra vale para qualquer instituição, hoje e depois.
-- Instituição sem hospital, ou com hospitais em fusos diferentes, não é
-- tocada: nesse caso não existe "o fuso da instituição" para deduzir, e a
-- escolha é humana.
--
-- ANSI_QUOTES: só aspas simples. Rerodável: a segunda execução não encontra
-- divergência. Idioma de aborto: `SELECT 1 FROM \`__motivo__\``.

-- ---------------------------------------------------------------------------
-- Preflight: as duas colunas precisam existir
-- ---------------------------------------------------------------------------

SET @tz_cols := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND ((TABLE_NAME = 'institutions' AND COLUMN_NAME = 'time_zone')
      OR (TABLE_NAME = 'hospitals' AND COLUMN_NAME = 'time_zone'))
);
SET @ddl := IF(
  @tz_cols = 2,
  'SELECT 1',
  'SELECT 1 FROM `__coluna_time_zone_ausente__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Correção: herda quando os hospitais são unânimes
-- ---------------------------------------------------------------------------

UPDATE institutions AS i
JOIN (
  SELECT
    h.institution_id,
    MIN(h.time_zone) AS hospital_time_zone
  FROM hospitals AS h
  WHERE h.time_zone IS NOT NULL
    AND TRIM(h.time_zone) <> ''
  GROUP BY h.institution_id
  HAVING COUNT(DISTINCT h.time_zone) = 1
) AS unanime
  ON unanime.institution_id = i.id
SET i.time_zone = unanime.hospital_time_zone
WHERE i.time_zone <> unanime.hospital_time_zone;

-- ---------------------------------------------------------------------------
-- Postflight: nenhuma instituição com hospitais unânimes pode divergir
-- ---------------------------------------------------------------------------

SET @tz_divergentes := (
  SELECT COUNT(*)
  FROM institutions AS i
  JOIN (
    SELECT
      h.institution_id,
      MIN(h.time_zone) AS hospital_time_zone
    FROM hospitals AS h
    WHERE h.time_zone IS NOT NULL
      AND TRIM(h.time_zone) <> ''
    GROUP BY h.institution_id
    HAVING COUNT(DISTINCT h.time_zone) = 1
  ) AS unanime
    ON unanime.institution_id = i.id
  WHERE i.time_zone <> unanime.hospital_time_zone
);
SET @ddl := IF(
  @tz_divergentes = 0,
  'SELECT 1',
  'SELECT 1 FROM `__instituicao_com_fuso_divergente_do_hospital__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
