CREATE TABLE `share_link_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`failed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `share_link_failures_address` ON `share_link_failures` (`address`,`failed_at`);--> statement-breakpoint
CREATE INDEX `share_link_failures_failed_at` ON `share_link_failures` (`failed_at`);--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`recipient` text NOT NULL,
	`permissions` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`ended_by` text,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ended_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_tokenHash_unique` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_machine` ON `share_links` (`machine_id`,`ended_at`);