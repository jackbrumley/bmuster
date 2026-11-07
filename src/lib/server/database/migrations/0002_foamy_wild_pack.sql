CREATE TABLE `local_certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`certificate_pem` text NOT NULL,
	`private_key_encrypted` text NOT NULL,
	`pin` text NOT NULL,
	`created_at` integer NOT NULL
);
