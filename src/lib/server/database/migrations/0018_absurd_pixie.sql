CREATE TABLE `storage_cleanups` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`user_id` text NOT NULL,
	`items` text NOT NULL,
	`requested_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `storage_cleanups_machine_idx` ON `storage_cleanups` (`machine_id`);--> statement-breakpoint
ALTER TABLE `machine_storage` ADD `low_disk_alerted` text DEFAULT '[]' NOT NULL;