CREATE TABLE `shift_reminders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`shift_instance_id` int NOT NULL,
	`user_id` int NOT NULL,
	`reminder_type` enum('PRE_SHIFT') NOT NULL DEFAULT 'PRE_SHIFT',
	`reminder_at` timestamp NOT NULL,
	`sent_at` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shift_reminders_id` PRIMARY KEY(`id`),
	CONSTRAINT `shift_reminders_shift_instance_id_user_id_reminder_type_unique` UNIQUE(`shift_instance_id`,`user_id`,`reminder_type`)
);
--> statement-breakpoint
CREATE TABLE `sso_used_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jti` varchar(191) NOT NULL,
	`sub` varchar(191) NOT NULL,
	`tenant_key` varchar(191) NOT NULL,
	`institution_id` int NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sso_used_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `sso_used_tokens_jti_unique` UNIQUE(`jti`)
);
--> statement-breakpoint
ALTER TABLE `audit_trail` MODIFY COLUMN `action` enum('SHIFT_CREATED','SHIFT_UPDATED','SHIFT_DELETED','ASSIGNMENT_CREATED','ASSIGNMENT_REMOVED','ASSIGNMENT_ASSUMED_VACANCY','ASSIGNMENT_APPROVED','ASSIGNMENT_REJECTED','SWAP_REQUESTED','SWAP_ACCEPTED','SWAP_REJECTED','SWAP_APPROVED_BY_MANAGER','SWAP_CANCELLED','TRANSFER_OFFERED','TRANSFER_ACCEPTED','TRANSFER_REJECTED','TRANSFER_APPROVED_BY_MANAGER','TRANSFER_CANCELLED','ROSTER_PUBLISHED','ROSTER_LOCKED','USER_CREATED','USER_UPDATED','USER_ROLE_CHANGED','SSO_JIT_LINK_CREATED','PUSH_DISPATCHED','CONFLICT_DETECTED','CONFLICT_OVERRIDDEN') NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `type` enum('GENERAL','SHIFT_REMINDER') DEFAULT 'GENERAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `status` enum('PENDING','SENT','FAILED') DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `shift_instance_id` int;--> statement-breakpoint
ALTER TABLE `notifications` ADD `reminder_type` enum('RADAR_11H','RADAR_3H');--> statement-breakpoint
ALTER TABLE `notifications` ADD `dedup_key` varchar(191);--> statement-breakpoint
ALTER TABLE `notifications` ADD `deep_link` varchar(1024);--> statement-breakpoint
ALTER TABLE `notifications` ADD `provider_receipt` json;--> statement-breakpoint
ALTER TABLE `notifications` ADD `error_message` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `sent_at` timestamp;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_dedup_key_unique` UNIQUE(`dedup_key`);--> statement-breakpoint
ALTER TABLE `shift_reminders` ADD CONSTRAINT `shift_reminders_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_reminders` ADD CONSTRAINT `shift_reminders_shift_instance_id_shift_instances_id_fk` FOREIGN KEY (`shift_instance_id`) REFERENCES `shift_instances`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_reminders` ADD CONSTRAINT `shift_reminders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sso_used_tokens` ADD CONSTRAINT `sso_used_tokens_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_shift_reminders_institution_id` ON `shift_reminders` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_shift_reminders_reminder_at` ON `shift_reminders` (`reminder_at`);--> statement-breakpoint
CREATE INDEX `idx_sso_used_tokens_expires_at` ON `sso_used_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_sso_used_tokens_institution_id` ON `sso_used_tokens` (`institution_id`,`id`);--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_shift_instance_id_shift_instances_id_fk` FOREIGN KEY (`shift_instance_id`) REFERENCES `shift_instances`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_notifications_status` ON `notifications` (`status`,`created_at`);