PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_images` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`recipe_id` text,
	`step_index` integer,
	`object_key` text NOT NULL,
	`mime` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "images_dimensions_check" CHECK("__new_images"."width" > 0 AND "__new_images"."height" > 0),
	CONSTRAINT "images_role_check" CHECK("__new_images"."role" IN ('overview', 'label_closeup', 'final_drink', 'mixing_step')),
	CONSTRAINT "images_mixing_link_check" CHECK(("__new_images"."role" = 'mixing_step' AND "__new_images"."recipe_id" IS NOT NULL AND "__new_images"."step_index" IS NOT NULL AND "__new_images"."step_index" >= 0) OR ("__new_images"."role" <> 'mixing_step' AND "__new_images"."recipe_id" IS NULL AND "__new_images"."step_index" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_images`("id", "session_id", "role", "recipe_id", "step_index", "object_key", "mime", "width", "height", "created_at") SELECT "id", "session_id", "role", NULL, NULL, "object_key", "mime", "width", "height", "created_at" FROM `images`;--> statement-breakpoint
DROP TABLE `images`;--> statement-breakpoint
ALTER TABLE `__new_images` RENAME TO `images`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `images_object_key_unique` ON `images` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `images_mixing_current_unique` ON `images` (`session_id`,`recipe_id`,`step_index`);--> statement-breakpoint
CREATE INDEX `images_session_idx` ON `images` (`session_id`);--> statement-breakpoint
CREATE INDEX `images_mixing_lookup_idx` ON `images` (`session_id`,`recipe_id`,`step_index`);
