ALTER TABLE `command_run_scripts` ADD `requested_command` text;--> statement-breakpoint
ALTER TABLE `command_runs` ADD `requester` text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE `command_runs` ADD `oauth_grant_id` text REFERENCES oauth_grants(id);--> statement-breakpoint
ALTER TABLE `command_runs` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `command_runs` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `command_runs` ADD `decided_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `command_runs` ADD `decided_at` integer;--> statement-breakpoint
ALTER TABLE `command_runs` ADD `deny_note` text;--> statement-breakpoint
ALTER TABLE `command_runs` ADD `requested_timeout_ms` integer;