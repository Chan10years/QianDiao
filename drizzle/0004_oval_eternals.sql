CREATE TABLE `session_mutation_leases` (
	`session_id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`lease_owner` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_mutation_leases_version_check" CHECK("session_mutation_leases"."expected_version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_mutation_leases_request_unique` ON `session_mutation_leases` (`request_id`);--> statement-breakpoint
CREATE INDEX `session_mutation_leases_expiry_idx` ON `session_mutation_leases` (`lease_expires_at`);