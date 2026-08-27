-- 2026-08-27 — papel institucional canônico em professional_institutions.
--
-- O Drizzle e os scripts operacionais (ex.: provision:sala-recuperacao) usam
-- role_in_institution por tenant. O staging ainda não tinha essa coluna.
--
-- Aplicar no staging ANTES de rodar provision:sala-recuperacao --apply:
--   pnpm apply:migration drizzle/migrations/manual/2026-08-27-professional-institutions-role.sql
--
-- Idempotente: consulta INFORMATION_SCHEMA antes de ALTER/UPDATE.

SET @prof_user_role_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professionals'
    AND COLUMN_NAME = 'user_role'
);
SET @ddl := IF(
  @prof_user_role_exists = 0,
  'ALTER TABLE professionals ADD COLUMN user_role ENUM(''USER'', ''GESTOR_MEDICO'', ''GESTOR_PLUS'') NOT NULL DEFAULT ''USER''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @membership_role_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'professional_institutions'
    AND COLUMN_NAME = 'role_in_institution'
);
SET @ddl := IF(
  @membership_role_exists = 0,
  'ALTER TABLE professional_institutions ADD COLUMN role_in_institution ENUM(''USER'', ''GESTOR_MEDICO'', ''GESTOR_PLUS'') NOT NULL DEFAULT ''USER''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Sincroniza professionals.user_role a partir do papel global legado (users.role).
UPDATE professionals AS professional
INNER JOIN users AS user_account ON user_account.id = professional.user_id
SET professional.user_role = CASE
  WHEN user_account.role = 'admin' THEN 'GESTOR_PLUS'
  WHEN user_account.role = 'manager' THEN 'GESTOR_MEDICO'
  ELSE 'USER'
END
WHERE professional.user_role = 'USER'
  AND user_account.role IN ('admin', 'manager');

-- Copia o papel canônico do profissional para o vínculo institucional.
UPDATE professional_institutions AS membership
INNER JOIN professionals AS professional
  ON professional.id = membership.professional_id
 AND professional.user_id = membership.user_id
SET membership.role_in_institution = professional.user_role
WHERE membership.role_in_institution <> professional.user_role;
