CREATE TABLE `machine_local_pages` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`totp_secret_sealed` text NOT NULL,
	`certificate_sha256` text NOT NULL,
	`port` integer NOT NULL,
	`reported_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `machines` ADD `moved_at` integer;