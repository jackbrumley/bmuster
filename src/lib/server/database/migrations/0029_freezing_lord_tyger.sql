CREATE TABLE `storage_cleanup_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`user_id` text NOT NULL,
	`oauth_grant_id` text NOT NULL,
	`items` text NOT NULL,
	`sizes` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`requested_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`deny_note` text,
	`cleanup_id` text,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`oauth_grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cleanup_id`) REFERENCES `storage_cleanups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `storage_cleanup_requests_status_idx` ON `storage_cleanup_requests` (`status`);