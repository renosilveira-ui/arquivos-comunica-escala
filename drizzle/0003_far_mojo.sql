ALTER TABLE `shift_assignments` ADD `position` enum('A','B','C') DEFAULT 'A' NOT NULL;--> statement-breakpoint
ALTER TABLE `shift_assignments` ADD `is_substitute` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shifts` ADD `repeat_frequency_weeks` int;--> statement-breakpoint
ALTER TABLE `shifts` ADD `repeat_end_date` timestamp;--> statement-breakpoint
ALTER TABLE `shifts` ADD `parent_shift_id` int;