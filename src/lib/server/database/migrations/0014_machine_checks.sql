CREATE TABLE `machine_checks` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`results` text NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
