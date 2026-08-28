PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_idempotency_records` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`response_json` text NOT NULL,
	`status_code` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "idempotency_records_lease_pair_check" CHECK(("__new_idempotency_records"."lease_owner" IS NULL AND "__new_idempotency_records"."lease_expires_at" IS NULL) OR ("__new_idempotency_records"."lease_owner" IS NOT NULL AND "__new_idempotency_records"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "idempotency_records_status_check" CHECK("__new_idempotency_records"."status_code" BETWEEN 100 AND 599)
);
--> statement-breakpoint
INSERT INTO `__new_idempotency_records`("id", "session_id", "request_id", "request_fingerprint", "response_json", "status_code", "lease_owner", "lease_expires_at", "created_at") SELECT "id", "session_id", "request_id", "request_fingerprint", "response_json", "status_code", NULL, NULL, "created_at" FROM `idempotency_records`;--> statement-breakpoint
DROP TABLE `idempotency_records`;--> statement-breakpoint
ALTER TABLE `__new_idempotency_records` RENAME TO `idempotency_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_records_request_unique` ON `idempotency_records` (`request_id`);--> statement-breakpoint
CREATE INDEX `idempotency_records_session_idx` ON `idempotency_records` (`session_id`);
