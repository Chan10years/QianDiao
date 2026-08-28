ALTER TABLE `recipes` ADD `feedback_id` text REFERENCES feedback(id);--> statement-breakpoint
CREATE INDEX `recipes_feedback_idx` ON `recipes` (`feedback_id`);