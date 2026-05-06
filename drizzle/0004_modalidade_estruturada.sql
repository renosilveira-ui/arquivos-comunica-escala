-- Frente 7 — Modalidade estruturada (docs/product/escala-ux.md §5).
-- Adiciona 4 colunas em shift_instances para que o app deixe de
-- depender do `label` (texto livre) para distinguir plantão de
-- sobreaviso e suporte filtragem/cálculo financeiro futuro.
--
-- NOT NULL com DEFAULT garante que rows existentes recebem o valor
-- default ('PLANTAO' / 'FIXO') no ALTER, sem necessidade de UPDATE
-- manual de backfill.

ALTER TABLE `shift_instances` ADD `modality` enum('PLANTAO','SOBREAVISO') DEFAULT 'PLANTAO' NOT NULL;--> statement-breakpoint
ALTER TABLE `shift_instances` ADD `coverage_type` enum('URGENCIA_EMERGENCIA','ELETIVAS');--> statement-breakpoint
ALTER TABLE `shift_instances` ADD `payment_model` enum('FIXO','FIXO_PRODUTIVIDADE_TETO','FIXO_PRODUTIVIDADE_SEM_TETO','PRODUTIVIDADE_PURA') DEFAULT 'FIXO' NOT NULL;--> statement-breakpoint
ALTER TABLE `shift_instances` ADD `productivity_cap_brl` decimal(12,2);--> statement-breakpoint
CREATE INDEX `idx_shift_instances_modality` ON `shift_instances` (`institution_id`,`modality`);
