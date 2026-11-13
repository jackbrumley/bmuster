CREATE TABLE `command_run_machines` (
	`run_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`skip_reason` text,
	`session_id` text,
	`exit_code` integer,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`stdout` text,
	`stderr` text,
	`stdout_truncated` integer DEFAULT false NOT NULL,
	`stderr_truncated` integer DEFAULT false NOT NULL,
	`output_bytes` integer,
	`output_sha256` text,
	`output_deleted_at` integer,
	PRIMARY KEY(`run_id`, `machine_id`),
	FOREIGN KEY (`run_id`) REFERENCES `command_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `command_run_machines_ended` ON `command_run_machines` (`ended_at`);--> statement-breakpoint
CREATE TABLE `command_run_scripts` (
	`run_id` text NOT NULL,
	`os_family` text NOT NULL,
	`shell` text NOT NULL,
	`command` text NOT NULL,
	PRIMARY KEY(`run_id`, `os_family`),
	FOREIGN KEY (`run_id`) REFERENCES `command_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `command_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text NOT NULL,
	`timeout_ms` integer NOT NULL,
	`rerun_of` text,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `command_runs_started` ON `command_runs` (`started_at`);--> statement-breakpoint
ALTER TABLE `console_sessions` ADD `reconfirmed_at` integer;