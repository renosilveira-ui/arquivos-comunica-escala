-- 2026-09-12 — especialidade em branco vira ausência, e não volta mais.
--
-- Relato do PO (12/09/2026): ao tocar "Sim, confirmo" no plantão da tarde de
-- sábado, a tela respondia "Envelope imutável inválido no duty-sync" e nada
-- era confirmado. Causa: o envelope do duty-sync recusava `serviceName` em
-- branco, e `serviceName` vem de `shift_instances.specialty`.
--
-- No banco real: 76 de 453 plantões com specialty = '' (string vazia, não
-- NULL), todos criados na janela de 27–28/08/2026. Destes, 44 ainda estão no
-- futuro, até 01/10 — 44 confirmações que falhariam. O plantão do relato é o
-- id 291 (12/09, 13:00–19:00).
--
-- A correção no código (canonicalizeDutySyncServiceName) destrava a
-- confirmação. Esta migração resolve a raiz, em duas partes:
--
--   1. Normaliza o que já está gravado: '' e só-espaço viram NULL. Ausência
--      de especialidade é exatamente o que NULL significa nesta coluna; ''
--      nunca significou nada diferente, e o app já trata `string | null`.
--
--   2. Impede a volta: CHECK que recusa string vazia ou só-espaço. Sem ele,
--      qualquer caminho de escrita futuro reabre o mesmo buraco em silêncio.
--
-- NÃO toca em especialidade preenchida, não apaga linha e não mexe em
-- nenhuma outra coluna. Fora da cobertura da cerca de prontidão (que lista
-- colunas nomeadas e não inclui specialty).
--
-- ANSI_QUOTES: só aspas simples. Rerodável: a segunda execução não encontra
-- linha em branco e o CHECK já existe.
-- Idioma de aborto: `SELECT 1 FROM \`__motivo__\`` numa tabela inexistente.

-- ---------------------------------------------------------------------------
-- Preflight: a coluna precisa existir e ser de texto
-- ---------------------------------------------------------------------------

SET @si_specialty := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'specialty'
    AND DATA_TYPE IN ('varchar', 'char', 'text')
);
SET @ddl := IF(
  @si_specialty = 1,
  'SELECT 1',
  'SELECT 1 FROM `__shift_instances_specialty_ausente_ou_nao_textual__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A coluna precisa aceitar NULL: é para lá que o branco vai.
SET @si_nullable := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND COLUMN_NAME = 'specialty'
    AND IS_NULLABLE = 'YES'
);
SET @ddl := IF(
  @si_nullable = 1,
  'SELECT 1',
  'SELECT 1 FROM `__shift_instances_specialty_nao_aceita_null__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 1. Branco vira ausência
-- ---------------------------------------------------------------------------

UPDATE shift_instances
SET specialty = NULL
WHERE specialty IS NOT NULL
  AND TRIM(specialty) = '';

-- ---------------------------------------------------------------------------
-- 2. O branco não volta
-- ---------------------------------------------------------------------------

SET @si_check := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND CONSTRAINT_NAME = 'chk_shift_instances_specialty_not_blank'
);
SET @ddl := IF(
  @si_check = 0,
  'ALTER TABLE shift_instances ADD CONSTRAINT chk_shift_instances_specialty_not_blank CHECK (specialty IS NULL OR TRIM(specialty) <> '''')',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Postflight: nenhuma em branco sobrou, e a guarda está de pé
-- ---------------------------------------------------------------------------

SET @si_restantes := (
  SELECT COUNT(*)
  FROM shift_instances
  WHERE specialty IS NOT NULL
    AND TRIM(specialty) = ''
);
SET @ddl := IF(
  @si_restantes = 0,
  'SELECT 1',
  'SELECT 1 FROM `__shift_instances_specialty_em_branco_restante__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @si_check_final := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shift_instances'
    AND CONSTRAINT_NAME = 'chk_shift_instances_specialty_not_blank'
);
SET @ddl := IF(
  @si_check_final = 1,
  'SELECT 1',
  'SELECT 1 FROM `__shift_instances_specialty_check_ausente__`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
