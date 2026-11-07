CREATE TABLE `agent_rollouts` (
	`version` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`stage` text NOT NULL,
	`stage_started_at` integer NOT NULL,
	`paused_at` integer,
	`paused_reason` text,
	`paused_by` text
);
--> statement-breakpoint
CREATE TABLE `machine_updates` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`launcher` integer NOT NULL,
	`pinned_at` integer,
	`pinned_by` text,
	`requested_version` text,
	`requested_at` integer,
	`offered_version` text,
	`offered_at` integer,
	`last_event_kind` text DEFAULT 'none' NOT NULL,
	`last_event_version` text DEFAULT '' NOT NULL,
	`last_event_reason` text DEFAULT '' NOT NULL,
	`last_event_at` integer,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
