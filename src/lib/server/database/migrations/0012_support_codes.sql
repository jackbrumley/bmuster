CREATE TABLE `support_code_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`failed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `support_code_failures_address` ON `support_code_failures` (`address`,`failed_at`);--> statement-breakpoint
CREATE INDEX `support_code_failures_failed_at` ON `support_code_failures` (`failed_at`);--> statement-breakpoint
CREATE TABLE `support_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`join_code_id` text NOT NULL,
	`join_code_sealed` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`cancelled_at` integer,
	`entered_at` integer,
	FOREIGN KEY (`join_code_id`) REFERENCES `join_codes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `support_codes_code_hash` ON `support_codes` (`code_hash`,`created_at`);