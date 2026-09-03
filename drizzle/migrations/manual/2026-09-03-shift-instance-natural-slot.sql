-- 2026-09-03 — impede turno físico duplicado (mesma escala, horário e rótulo).
-- Aditiva e rerodável. O UNIQUE falha fechado se ainda houver turnos físicos
-- duplicados sob um contexto canônico: primeiro reconcilie a topologia
-- (remova as instâncias vazias duplicadas geradas na consolidação) e só então
-- aplique. Nunca escolha nem apague uma instância arbitrária nesta migration.
--
-- schedule_context_id NULL (instâncias legadas ainda não classificadas)
-- permanece permitido: NULLs são distintos no índice único do MySQL, então
-- esta barreira não altera dados existentes nem bloqueia legado sem contexto.

SET @natural_slot_unique_exists := (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shift_instances'
     AND INDEX_NAME = 'uniq_shift_instance_natural_slot'
);
SET @ddl := IF(
  @natural_slot_unique_exists = 0,
  'ALTER TABLE shift_instances ADD UNIQUE KEY uniq_shift_instance_natural_slot (institution_id, hospital_id, sector_id, schedule_context_id, start_at, end_at, label)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
