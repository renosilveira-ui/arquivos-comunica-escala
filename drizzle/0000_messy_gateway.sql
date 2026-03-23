CREATE TABLE `audit_trail` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actor_user_id` int NOT NULL,
	`actor_role` varchar(20) NOT NULL,
	`actor_name` varchar(255),
	`action` enum('SHIFT_CREATED','SHIFT_UPDATED','SHIFT_DELETED','ASSIGNMENT_CREATED','ASSIGNMENT_REMOVED','ASSIGNMENT_ASSUMED_VACANCY','ASSIGNMENT_APPROVED','ASSIGNMENT_REJECTED','SWAP_REQUESTED','SWAP_ACCEPTED','SWAP_REJECTED','SWAP_APPROVED_BY_MANAGER','SWAP_CANCELLED','TRANSFER_OFFERED','TRANSFER_ACCEPTED','TRANSFER_REJECTED','TRANSFER_APPROVED_BY_MANAGER','TRANSFER_CANCELLED','ROSTER_PUBLISHED','ROSTER_LOCKED','USER_CREATED','USER_UPDATED','USER_ROLE_CHANGED','CONFLICT_DETECTED','CONFLICT_OVERRIDDEN') NOT NULL,
	`entity_type` enum('SHIFT_INSTANCE','SHIFT_ASSIGNMENT','SWAP_REQUEST','TRANSFER_REQUEST','MONTHLY_ROSTER','USER','PROFESSIONAL') NOT NULL,
	`entity_id` int NOT NULL,
	`description` varchar(500) NOT NULL,
	`metadata` json,
	`from_professional_id` int,
	`to_professional_id` int,
	`from_user_id` int,
	`to_user_id` int,
	`institution_id` int NOT NULL,
	`hospital_id` int,
	`sector_id` int,
	`shift_instance_id` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`ip_address` varchar(45),
	`user_agent` varchar(500),
	CONSTRAINT `audit_trail_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `hospitals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`address` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `hospitals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `institution_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`edit_window_days` int NOT NULL DEFAULT 3,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `institution_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `institution_config_institution_id_unique` UNIQUE(`institution_id`)
);
--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`cnpj` varchar(14) NOT NULL,
	`legal_name` varchar(255),
	`trade_name` varchar(255),
	`is_active` boolean NOT NULL DEFAULT true,
	`metadata` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `institutions_id` PRIMARY KEY(`id`),
	CONSTRAINT `institutions_cnpj_unique` UNIQUE(`cnpj`)
);
--> statement-breakpoint
CREATE TABLE `manager_scope` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`manager_professional_id` int NOT NULL,
	`hospital_id` int NOT NULL,
	`sector_id` int,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `manager_scope_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `monthly_rosters` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`hospital_id` int NOT NULL,
	`year_month` varchar(7) NOT NULL,
	`status` enum('DRAFT','PUBLISHED','LOCKED') NOT NULL DEFAULT 'DRAFT',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`published_at` datetime,
	`published_by_user_id` int,
	`locked_at` datetime,
	`locked_by_user_id` int,
	`version` int NOT NULL DEFAULT 1,
	CONSTRAINT `monthly_rosters_id` PRIMARY KEY(`id`),
	CONSTRAINT `monthly_rosters_institution_id_hospital_id_year_month_unique` UNIQUE(`institution_id`,`hospital_id`,`year_month`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`user_id` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`body` text,
	`read` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `professional_access` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`professional_id` int NOT NULL,
	`hospital_id` int NOT NULL,
	`sector_id` int,
	`can_access` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `professional_access_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `professional_institutions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`professional_id` int NOT NULL,
	`user_id` int NOT NULL,
	`institution_id` int NOT NULL,
	`user_role` enum('USER','GESTOR_MEDICO','GESTOR_PLUS') NOT NULL DEFAULT 'USER',
	`is_primary` boolean NOT NULL DEFAULT false,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `professional_institutions_id` PRIMARY KEY(`id`),
	CONSTRAINT `professional_institutions_professional_id_institution_id_unique` UNIQUE(`professional_id`,`institution_id`),
	CONSTRAINT `professional_institutions_user_id_institution_id_unique` UNIQUE(`user_id`,`institution_id`)
);
--> statement-breakpoint
CREATE TABLE `professionals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`role` varchar(100) NOT NULL,
	`user_role` enum('USER','GESTOR_MEDICO','GESTOR_PLUS') NOT NULL DEFAULT 'USER',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `professionals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `push_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`user_id` int NOT NULL,
	`token` varchar(512) NOT NULL,
	`platform` varchar(20) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `push_tokens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sectors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`hospital_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`category` enum('internacao','cirurgico','servico') NOT NULL,
	`color` varchar(7) NOT NULL,
	`min_staff_count` int NOT NULL DEFAULT 2,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sectors_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shift_assignments_v2` (
	`id` int AUTO_INCREMENT NOT NULL,
	`shift_instance_id` int NOT NULL,
	`institution_id` int NOT NULL,
	`hospital_id` int NOT NULL,
	`sector_id` int NOT NULL,
	`professional_id` int NOT NULL,
	`assignment_type` enum('ON_DUTY','BACKUP','ON_CALL') NOT NULL DEFAULT 'ON_DUTY',
	`status` varchar(20) NOT NULL DEFAULT 'PENDENTE',
	`is_active` boolean NOT NULL DEFAULT true,
	`created_by` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shift_assignments_v2_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shift_audit_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`event` varchar(50) NOT NULL,
	`shift_instance_id` int NOT NULL,
	`professional_id` int,
	`reason` text,
	`metadata` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shift_audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shift_instances` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`hospital_id` int NOT NULL,
	`sector_id` int NOT NULL,
	`label` varchar(100) NOT NULL,
	`start_at` timestamp NOT NULL,
	`end_at` timestamp NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'VAGO',
	`created_by` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shift_instances_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shift_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`institution_id` int NOT NULL,
	`hospital_id` int NOT NULL,
	`sector_id` int,
	`name` varchar(100) NOT NULL,
	`start_time` time NOT NULL,
	`end_time` time NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`priority` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shift_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `swap_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`type` enum('SWAP','TRANSFER') NOT NULL,
	`status` enum('PENDING','ACCEPTED','APPROVED','REJECTED_BY_PEER','REJECTED_BY_MANAGER','CANCELLED','EXPIRED') NOT NULL DEFAULT 'PENDING',
	`from_professional_id` int NOT NULL,
	`from_user_id` int NOT NULL,
	`from_shift_instance_id` int NOT NULL,
	`from_assignment_id` int NOT NULL,
	`to_professional_id` int,
	`to_user_id` int,
	`to_shift_instance_id` int,
	`to_assignment_id` int,
	`reviewed_by_user_id` int,
	`reviewed_at` datetime,
	`review_note` varchar(500),
	`institution_id` int NOT NULL,
	`hospital_id` int NOT NULL,
	`sector_id` int,
	`reason` varchar(500),
	`expires_at` datetime,
	`version` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `swap_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64),
	`name` text,
	`email` varchar(320),
	`password_hash` varchar(255),
	`loginMethod` varchar(64),
	`role` enum('admin','manager','doctor','nurse','tech') NOT NULL DEFAULT 'doctor',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
ALTER TABLE `audit_trail` ADD CONSTRAINT `audit_trail_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `hospitals` ADD CONSTRAINT `hospitals_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `institution_config` ADD CONSTRAINT `institution_config_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `manager_scope` ADD CONSTRAINT `manager_scope_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `manager_scope` ADD CONSTRAINT `manager_scope_manager_professional_id_professionals_id_fk` FOREIGN KEY (`manager_professional_id`) REFERENCES `professionals`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `manager_scope` ADD CONSTRAINT `manager_scope_hospital_id_hospitals_id_fk` FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `manager_scope` ADD CONSTRAINT `manager_scope_sector_id_sectors_id_fk` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monthly_rosters` ADD CONSTRAINT `monthly_rosters_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monthly_rosters` ADD CONSTRAINT `monthly_rosters_hospital_id_hospitals_id_fk` FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professional_access` ADD CONSTRAINT `professional_access_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professional_access` ADD CONSTRAINT `professional_access_professional_id_professionals_id_fk` FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professional_access` ADD CONSTRAINT `professional_access_hospital_id_hospitals_id_fk` FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professional_access` ADD CONSTRAINT `professional_access_sector_id_sectors_id_fk` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professional_institutions` ADD CONSTRAINT `professional_institutions_professional_id_professionals_id_fk` FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professional_institutions` ADD CONSTRAINT `professional_institutions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professional_institutions` ADD CONSTRAINT `professional_institutions_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professionals` ADD CONSTRAINT `professionals_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `push_tokens` ADD CONSTRAINT `push_tokens_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `push_tokens` ADD CONSTRAINT `push_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sectors` ADD CONSTRAINT `sectors_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sectors` ADD CONSTRAINT `sectors_hospital_id_hospitals_id_fk` FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_assignments_v2` ADD CONSTRAINT `shift_assignments_v2_shift_instance_id_shift_instances_id_fk` FOREIGN KEY (`shift_instance_id`) REFERENCES `shift_instances`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_assignments_v2` ADD CONSTRAINT `shift_assignments_v2_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_assignments_v2` ADD CONSTRAINT `shift_assignments_v2_hospital_id_hospitals_id_fk` FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_assignments_v2` ADD CONSTRAINT `shift_assignments_v2_sector_id_sectors_id_fk` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_assignments_v2` ADD CONSTRAINT `shift_assignments_v2_professional_id_professionals_id_fk` FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_assignments_v2` ADD CONSTRAINT `shift_assignments_v2_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_audit_log` ADD CONSTRAINT `shift_audit_log_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_audit_log` ADD CONSTRAINT `shift_audit_log_shift_instance_id_shift_instances_id_fk` FOREIGN KEY (`shift_instance_id`) REFERENCES `shift_instances`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_audit_log` ADD CONSTRAINT `shift_audit_log_professional_id_professionals_id_fk` FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_instances` ADD CONSTRAINT `shift_instances_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_instances` ADD CONSTRAINT `shift_instances_hospital_id_hospitals_id_fk` FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_instances` ADD CONSTRAINT `shift_instances_sector_id_sectors_id_fk` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_instances` ADD CONSTRAINT `shift_instances_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_templates` ADD CONSTRAINT `shift_templates_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_templates` ADD CONSTRAINT `shift_templates_hospital_id_hospitals_id_fk` FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shift_templates` ADD CONSTRAINT `shift_templates_sector_id_sectors_id_fk` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_from_professional_id_professionals_id_fk` FOREIGN KEY (`from_professional_id`) REFERENCES `professionals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_from_user_id_users_id_fk` FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_from_shift_instance_id_shift_instances_id_fk` FOREIGN KEY (`from_shift_instance_id`) REFERENCES `shift_instances`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_from_assignment_id_shift_assignments_v2_id_fk` FOREIGN KEY (`from_assignment_id`) REFERENCES `shift_assignments_v2`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_to_professional_id_professionals_id_fk` FOREIGN KEY (`to_professional_id`) REFERENCES `professionals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_to_user_id_users_id_fk` FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_to_shift_instance_id_shift_instances_id_fk` FOREIGN KEY (`to_shift_instance_id`) REFERENCES `shift_instances`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_to_assignment_id_shift_assignments_v2_id_fk` FOREIGN KEY (`to_assignment_id`) REFERENCES `shift_assignments_v2`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_reviewed_by_user_id_users_id_fk` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_institution_id_institutions_id_fk` FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_hospital_id_hospitals_id_fk` FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `swap_requests` ADD CONSTRAINT `swap_requests_sector_id_sectors_id_fk` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_trail` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_trail` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_shift` ON `audit_trail` (`shift_instance_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_institution_id` ON `audit_trail` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_audit_date` ON `audit_trail` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hospitals_institution_id` ON `hospitals` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_institution_config_institution_id` ON `institution_config` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_manager_scope_institution_id` ON `manager_scope` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_monthly_rosters_institution` ON `monthly_rosters` (`institution_id`);--> statement-breakpoint
CREATE INDEX `idx_monthly_rosters_institution_id` ON `monthly_rosters` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_monthly_rosters_hospital` ON `monthly_rosters` (`hospital_id`);--> statement-breakpoint
CREATE INDEX `idx_notifications_institution_id` ON `notifications` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_prof_access_institution_id` ON `professional_access` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_prof_inst_prof` ON `professional_institutions` (`professional_id`,`institution_id`);--> statement-breakpoint
CREATE INDEX `idx_prof_inst_institution_active` ON `professional_institutions` (`institution_id`,`active`);--> statement-breakpoint
CREATE INDEX `idx_prof_inst_institution_id` ON `professional_institutions` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_push_tokens_institution_id` ON `push_tokens` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sectors_institution_id` ON `sectors` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_shift_assignments_institution_id` ON `shift_assignments_v2` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_shift_audit_institution_id` ON `shift_audit_log` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_shift_instances_institution_id` ON `shift_instances` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_shift_templates_institution_id` ON `shift_templates` (`institution_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_swap_from` ON `swap_requests` (`from_professional_id`);--> statement-breakpoint
CREATE INDEX `idx_swap_to` ON `swap_requests` (`to_professional_id`);--> statement-breakpoint
CREATE INDEX `idx_swap_status` ON `swap_requests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_swap_shift` ON `swap_requests` (`from_shift_instance_id`);--> statement-breakpoint
CREATE INDEX `idx_swap_institution_id` ON `swap_requests` (`institution_id`,`id`);