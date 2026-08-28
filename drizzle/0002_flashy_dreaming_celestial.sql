DROP INDEX `idempotency_records_session_request_unique`;--> statement-breakpoint
ALTER TABLE `idempotency_records` ADD `request_fingerprint` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `idempotency_records`
SET `request_fingerprint` = 'legacy:' || `id`
WHERE `request_fingerprint` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_records_request_unique` ON `idempotency_records` (`request_id`);
