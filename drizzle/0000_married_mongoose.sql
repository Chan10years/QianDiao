CREATE TABLE `decision_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`summary` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decision_events_session_idx` ON `decision_events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `experiment_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`feedback_id` text NOT NULL,
	`summary` text NOT NULL,
	`tags_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feedback_id`) REFERENCES `feedback`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `experiment_memories_recipe_idx` ON `experiment_memories` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `experiment_memories_feedback_idx` ON `experiment_memories` (`feedback_id`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`rating` integer NOT NULL,
	`accepted` integer NOT NULL,
	`deltas_json` text NOT NULL,
	`notes` text,
	`final_image_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`final_image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "feedback_rating_check" CHECK("feedback"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `feedback_session_idx` ON `feedback` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_recipe_idx` ON `feedback` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`response_json` text NOT NULL,
	`status_code` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "idempotency_records_status_check" CHECK("idempotency_records"."status_code" BETWEEN 100 AND 599)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_records_session_request_unique` ON `idempotency_records` (`session_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idempotency_records_session_idx` ON `idempotency_records` (`session_id`);--> statement-breakpoint
CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`object_key` text NOT NULL,
	`mime` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "images_dimensions_check" CHECK("images"."width" > 0 AND "images"."height" > 0),
	CONSTRAINT "images_role_check" CHECK("images"."role" IN ('overview', 'label_closeup', 'final_drink'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_object_key_unique` ON `images` (`object_key`);--> statement-breakpoint
CREATE INDEX `images_session_idx` ON `images` (`session_id`);--> statement-breakpoint
CREATE TABLE `ingredients` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`raw_name` text NOT NULL,
	`canonical_name` text NOT NULL,
	`category` text NOT NULL,
	`brand` text,
	`abv` real,
	`confidence` real NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ingredients_confidence_check" CHECK("ingredients"."confidence" >= 0 AND "ingredients"."confidence" <= 1),
	CONSTRAINT "ingredients_abv_check" CHECK("ingredients"."abv" IS NULL OR ("ingredients"."abv" >= 0 AND "ingredients"."abv" <= 100)),
	CONSTRAINT "ingredients_category_check" CHECK("ingredients"."category" IN ('spirit', 'mixer', 'tea', 'fruit', 'sweetener', 'herb', 'ice', 'energy_drink', 'medicine', 'non_food', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingredients_session_canonical_unique` ON `ingredients` (`session_id`,`canonical_name`);--> statement-breakpoint
CREATE INDEX `ingredients_session_idx` ON `ingredients` (`session_id`);--> statement-breakpoint
CREATE INDEX `ingredients_confirmation_idx` ON `ingredients` (`session_id`,`confirmed`);--> statement-breakpoint
CREATE TABLE `recipe_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`recommended_recipe_id` text,
	`source_mode` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recommended_recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recipe_sets_source_mode_check" CHECK("recipe_sets"."source_mode" IN ('fallback', 'qwen'))
);
--> statement-breakpoint
CREATE INDEX `recipe_sets_session_idx` ON `recipe_sets` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`recipe_set_id` text NOT NULL,
	`strategy` text NOT NULL,
	`title` text NOT NULL,
	`fit_reason` text NOT NULL,
	`difference_reason` text NOT NULL,
	`materials_json` text NOT NULL,
	`steps_json` text NOT NULL,
	`estimated_abv` real,
	`safety_level` text NOT NULL,
	`experimental` integer NOT NULL,
	`missing_ingredients_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`parent_recipe_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_set_id`) REFERENCES `recipe_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recipes_strategy_check" CHECK("recipes"."strategy" IN ('A_CONSERVATIVE', 'B_CREATIVE', 'C_UPGRADE')),
	CONSTRAINT "recipes_safety_level_check" CHECK("recipes"."safety_level" IN ('ALLOW', 'WARN', 'BLOCK')),
	CONSTRAINT "recipes_version_check" CHECK("recipes"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipes_set_strategy_unique` ON `recipes` (`recipe_set_id`,`strategy`);--> statement-breakpoint
CREATE INDEX `recipes_session_idx` ON `recipes` (`session_id`);--> statement-breakpoint
CREATE INDEX `recipes_set_idx` ON `recipes` (`recipe_set_id`);--> statement-breakpoint
CREATE INDEX `recipes_parent_idx` ON `recipes` (`parent_recipe_id`);--> statement-breakpoint
CREATE TABLE `safety_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`level` text NOT NULL,
	`rule_hits_json` text NOT NULL,
	`engine_version` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "safety_decisions_level_check" CHECK("safety_decisions"."level" IN ('ALLOW', 'WARN', 'BLOCK'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `safety_decisions_recipe_unique` ON `safety_decisions` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `safety_decisions_level_idx` ON `safety_decisions` (`level`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'PREFERENCES' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`preferences_json` text,
	`selected_recipe_id` text,
	`current_step` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`selected_recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sessions_state_check" CHECK("sessions"."state" IN ('PREFERENCES', 'SCAN', 'CONFIRM', 'READY', 'RECIPE_SELECTION', 'MIXING', 'FEEDBACK', 'ADJUSTMENT', 'COMPLETED')),
	CONSTRAINT "sessions_version_check" CHECK("sessions"."version" >= 0),
	CONSTRAINT "sessions_current_step_check" CHECK("sessions"."current_step" IS NULL OR "sessions"."current_step" >= 0)
);
--> statement-breakpoint
CREATE INDEX `sessions_state_idx` ON `sessions` (`state`);