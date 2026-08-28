CREATE TABLE `fallback_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "fallback_materials_category_check" CHECK("fallback_materials"."category" IN ('spirit', 'mixer', 'tea', 'fruit', 'sweetener', 'herb', 'ice', 'energy_drink', 'medicine', 'non_food', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fallback_materials_name_unique` ON `fallback_materials` (`name`);--> statement-breakpoint
CREATE TABLE `inspirations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`source_name` text NOT NULL,
	`source_url` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inspirations_source_url_unique` ON `inspirations` (`source_url`);--> statement-breakpoint
CREATE TABLE `recipe_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy` text NOT NULL,
	`title` text NOT NULL,
	`fit_reason` text NOT NULL,
	`difference_reason` text NOT NULL,
	`materials_json` text NOT NULL,
	`steps_json` text NOT NULL,
	`estimated_abv` real,
	`experimental` integer NOT NULL,
	`missing_ingredients_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "recipe_templates_strategy_check" CHECK("recipe_templates"."strategy" IN ('A_CONSERVATIVE', 'B_CREATIVE', 'C_UPGRADE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_templates_strategy_unique` ON `recipe_templates` (`strategy`);