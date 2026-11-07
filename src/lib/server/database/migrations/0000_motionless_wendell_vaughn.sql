CREATE TABLE `join_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`machine_group_ids` text NOT NULL,
	`max_uses` integer NOT NULL,
	`uses` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `join_codes_codeHash_unique` ON `join_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `machine_inventory` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machine_status` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`signed_in_user` text NOT NULL,
	`cpu_percent` real NOT NULL,
	`memory_used_bytes` integer NOT NULL,
	`uptime_seconds` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hostname` text NOT NULL,
	`os_family` text NOT NULL,
	`target` text NOT NULL,
	`agent_version` text NOT NULL,
	`public_key` text NOT NULL,
	`last_request_ms` integer NOT NULL,
	`check_in_seconds` integer NOT NULL,
	`enrolled_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE TABLE `server_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key_encrypted` text NOT NULL,
	`created_at` integer NOT NULL
);
