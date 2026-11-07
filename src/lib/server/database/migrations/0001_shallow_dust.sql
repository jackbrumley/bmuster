CREATE TABLE `audit_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_user_id` text,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_entries_at` ON `audit_entries` (`at`);--> statement-breakpoint
CREATE TABLE `console_sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text NOT NULL,
	`ip` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `identity_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_sealed` text NOT NULL,
	`scopes` text NOT NULL,
	`new_people` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sign_in_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`address` text NOT NULL,
	`failed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sign_in_failures_email` ON `sign_in_failures` (`email`,`failed_at`);--> statement-breakpoint
CREATE INDEX `sign_in_failures_address` ON `sign_in_failures` (`address`,`failed_at`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_id`) REFERENCES `identity_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_providerId_subject_unique` ON `user_identities` (`provider_id`,`subject`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text,
	`disabled_at` integer,
	`created_at` integer NOT NULL,
	`last_sign_in_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `join_codes` ADD `created_by` text REFERENCES users(id);