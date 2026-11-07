ALTER TABLE `machines` ADD `local_codes` text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE `machines` ADD `local_events_seq` integer DEFAULT 0 NOT NULL;