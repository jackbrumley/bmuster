CREATE TABLE `machine_storage` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`drives` text NOT NULL,
	`reported_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
