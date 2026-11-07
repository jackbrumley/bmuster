CREATE TABLE `email_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text NOT NULL,
	`body` text,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`reply` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `email_messages_due` ON `email_messages` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `email_messages_created` ON `email_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`machine_id` text NOT NULL,
	`detail` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`event_kind` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text,
	`recipients_kind` text NOT NULL,
	`user_group_id` text,
	`addresses` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `password_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `password_links_user` ON `password_links` (`user_id`,`purpose`);