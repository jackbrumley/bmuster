/**
 * The one place server code reads environment variables. A missing value
 * stops the server at start-up (fail hard), never later at first use.
 */
import { existsSync } from 'node:fs';

// Variables already set (Docker, the shell) win over .env.
if (existsSync('.env')) {
	process.loadEnvFile('.env');
}

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`Environment variable ${name} is not set (see .env.example)`);
	}
	return value;
}

export const env = {
	/** Path to the SQLite database file, e.g. ./data/bmuster.db */
	databasePath: required('DATABASE_PATH')
};
