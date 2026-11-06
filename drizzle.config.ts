import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

if (existsSync('.env')) {
	process.loadEnvFile('.env');
}

const databasePath = process.env['DATABASE_PATH'];
if (databasePath === undefined || databasePath === '') {
	throw new Error('DATABASE_PATH is not set (see .env.example)');
}

export default defineConfig({
	schema: './src/lib/server/database/schema.ts',
	out: './src/lib/server/database/migrations',
	dialect: 'sqlite',
	casing: 'snake_case',
	dbCredentials: { url: databasePath },
	verbose: true,
	strict: true
});
