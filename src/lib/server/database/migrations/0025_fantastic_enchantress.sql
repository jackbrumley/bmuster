ALTER TABLE `oauth_clients` ADD `token_endpoint_auth_method` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `secret_hash` text;