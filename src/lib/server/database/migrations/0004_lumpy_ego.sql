CREATE TABLE `machine_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `machine_notes_machine` ON `machine_notes` (`machine_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `join_codes` ADD `reinstall_machine_id` text;--> statement-breakpoint
ALTER TABLE `machines` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `machines` ADD `last_user_name` text;--> statement-breakpoint
ALTER TABLE `machines` ADD `last_user_seen_at` integer;