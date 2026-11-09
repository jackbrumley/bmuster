CREATE TABLE `agent_log_records` (
	`machine_id` text NOT NULL,
	`instance` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`target` text NOT NULL,
	`text` text NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `instance`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `agent_log_records_machine_at` ON `agent_log_records` (`machine_id`,`at`);--> statement-breakpoint
CREATE TABLE `diagnostics_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	`last_audited_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostics_tokens_tokenHash_unique` ON `diagnostics_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `diagnostics_tokens_user` ON `diagnostics_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `server_log_records` (
	`instance` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`area` text NOT NULL,
	`machine_id` text,
	`text` text NOT NULL,
	PRIMARY KEY(`instance`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `server_log_records_at` ON `server_log_records` (`at`);--> statement-breakpoint
ALTER TABLE `machines` ADD `verbose_until` integer;