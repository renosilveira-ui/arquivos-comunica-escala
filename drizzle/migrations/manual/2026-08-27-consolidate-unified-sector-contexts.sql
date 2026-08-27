-- 2026-08-27 — consolida contextos PINNED legados em escala unificada por setor.
--
-- Quando um setor já tem schedule_context QUALIFICATION_ALLOWLIST ativo,
-- move plantões dos contextos PINNED antigos (Anestesiologia, Clínica médica…)
-- para a escala unificada e desativa os legados.
--
-- Rerodável: só afeta setores com allowlist + pinned legado ativos.
--
-- Aplicar no staging:
--   pnpm apply:migration drizzle/migrations/manual/2026-08-27-consolidate-unified-sector-contexts.sql
--
-- Alternativa idempotente (TypeScript, com dry-run):
--   HSC_PROVISION_CONFIRM=SAO_CARLOS_MULTISETOR pnpm provision:sao-carlos -- --apply

UPDATE shift_instances si
INNER JOIN schedule_contexts legacy
  ON legacy.id = si.schedule_context_id
INNER JOIN (
  SELECT
    institution_id,
    hospital_id,
    sector_id,
    MIN(id) AS unified_id
  FROM schedule_contexts
  WHERE admission_policy = 'QUALIFICATION_ALLOWLIST'
    AND active = TRUE
  GROUP BY institution_id, hospital_id, sector_id
) unified
  ON unified.institution_id = legacy.institution_id
 AND unified.hospital_id = legacy.hospital_id
 AND unified.sector_id = legacy.sector_id
SET si.schedule_context_id = unified.unified_id
WHERE legacy.admission_policy = 'PINNED_QUALIFICATION'
  AND legacy.active = TRUE
  AND legacy.id <> unified.unified_id;

UPDATE schedule_contexts legacy
INNER JOIN (
  SELECT
    institution_id,
    hospital_id,
    sector_id,
    MIN(id) AS unified_id
  FROM schedule_contexts
  WHERE admission_policy = 'QUALIFICATION_ALLOWLIST'
    AND active = TRUE
  GROUP BY institution_id, hospital_id, sector_id
) unified
  ON unified.institution_id = legacy.institution_id
 AND unified.hospital_id = legacy.hospital_id
 AND unified.sector_id = legacy.sector_id
SET legacy.active = FALSE
WHERE legacy.admission_policy = 'PINNED_QUALIFICATION'
  AND legacy.active = TRUE
  AND legacy.id <> unified.unified_id;
