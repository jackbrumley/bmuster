CREATE TABLE `access_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_group_id` text NOT NULL,
	`machine_group_id` text NOT NULL,
	`permissions` text NOT NULL,
	`consent` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`user_group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_group_id`) REFERENCES `machine_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machine_group_members` (
	`machine_group_id` text NOT NULL,
	`machine_id` text NOT NULL,
	PRIMARY KEY(`machine_group_id`, `machine_id`),
	FOREIGN KEY (`machine_group_id`) REFERENCES `machine_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `machine_group_members_machine` ON `machine_group_members` (`machine_id`);--> statement-breakpoint
CREATE TABLE `machine_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`built_in` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_groups_name_unique` ON `machine_groups` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_groups_builtIn_unique` ON `machine_groups` (`built_in`);--> statement-breakpoint
CREATE TABLE `user_group_members` (
	`user_group_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`user_group_id`, `user_id`),
	FOREIGN KEY (`user_group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `user_group_members_user` ON `user_group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_groups_name_unique` ON `user_groups` (`name`);--> statement-breakpoint
ALTER TABLE `audit_entries` ADD `machine_id` text;--> statement-breakpoint
CREATE INDEX `audit_entries_machine` ON `audit_entries` (`machine_id`,`at`);--> statement-breakpoint
INSERT INTO `machine_groups` (`id`, `name`, `description`, `built_in`, `created_at`) VALUES ('00000000-0000-4000-8000-00000000a11a', 'All machines', 'Every machine on this server, now and later.', 'all', 0);
