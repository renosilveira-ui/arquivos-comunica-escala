-- Manual migration to add new multi-institutional tables
-- Run this manually if automatic migration fails

-- 1. Create institutions table
CREATE TABLE IF NOT EXISTS `institutions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Create hospitals table
CREATE TABLE IF NOT EXISTS `hospitals` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `institution_id` INT NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `address` TEXT,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`)
);

-- 3. Add hospitalId to sectors table (if not exists)
ALTER TABLE `sectors` 
ADD COLUMN IF NOT EXISTS `hospital_id` INT NOT NULL DEFAULT 1 AFTER `id`,
ADD FOREIGN KEY IF NOT EXISTS (`hospital_id`) REFERENCES `hospitals`(`id`);

-- 4. Create professionals table
CREATE TABLE IF NOT EXISTS `professionals` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `institution_id` INT NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `role` VARCHAR(100) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`)
);

-- 5. Create professional_access table
CREATE TABLE IF NOT EXISTS `professional_access` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `professional_id` INT NOT NULL,
  `hospital_id` INT NOT NULL,
  `sector_id` INT,
  `can_access` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`),
  FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`),
  FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`)
);

-- 6. Create shift_templates table
CREATE TABLE IF NOT EXISTS `shift_templates` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `institution_id` INT NOT NULL,
  `hospital_id` INT NOT NULL,
  `sector_id` INT,
  `name` VARCHAR(100) NOT NULL,
  `start_time` TIME NOT NULL,
  `end_time` TIME NOT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
  `priority` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`),
  FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`),
  FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`)
);

-- 7. Create shift_instances table
CREATE TABLE IF NOT EXISTS `shift_instances` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `institution_id` INT NOT NULL,
  `hospital_id` INT NOT NULL,
  `sector_id` INT NOT NULL,
  `template_id` INT,
  `start_at` TIMESTAMP NOT NULL,
  `end_at` TIMESTAMP NOT NULL,
  `label` VARCHAR(100) NOT NULL,
  `source` ENUM('TEMPLATE', 'MANUAL') NOT NULL DEFAULT 'TEMPLATE',
  `created_by` INT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`),
  FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`),
  FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`),
  FOREIGN KEY (`template_id`) REFERENCES `shift_templates`(`id`),
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`),
  INDEX `sector_date_idx` (`sector_id`, `start_at`)
);

-- 8. Create shift_assignments_v2 table
CREATE TABLE IF NOT EXISTS `shift_assignments_v2` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `shift_instance_id` INT NOT NULL,
  `institution_id` INT NOT NULL,
  `hospital_id` INT NOT NULL,
  `sector_id` INT NOT NULL,
  `professional_id` INT NOT NULL,
  `assignment_type` ENUM('ON_DUTY', 'BACKUP', 'ON_CALL') NOT NULL DEFAULT 'ON_DUTY',
  `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_by` INT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`shift_instance_id`) REFERENCES `shift_instances`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`),
  FOREIGN KEY (`hospital_id`) REFERENCES `hospitals`(`id`),
  FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`),
  FOREIGN KEY (`professional_id`) REFERENCES `professionals`(`id`),
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`),
  INDEX `professional_idx_v2` (`professional_id`, `is_active`),
  INDEX `shift_sector_idx_v2` (`shift_instance_id`, `sector_id`, `is_active`)
);

-- 9. Insert default institution and hospital
INSERT IGNORE INTO `institutions` (`id`, `name`) VALUES (1, 'Hospital Santa Cruz');
INSERT IGNORE INTO `hospitals` (`id`, `institution_id`, `name`, `address`) 
VALUES (1, 1, 'Hospital Santa Cruz - Unidade Principal', 'Rua Principal, 123 - São Paulo, SP');

-- 10. Update existing sectors to belong to default hospital (if needed)
UPDATE `sectors` SET `hospital_id` = 1 WHERE `hospital_id` IS NULL OR `hospital_id` = 0;

SELECT 'Migration completed successfully!' AS status;
