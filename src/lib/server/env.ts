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

function secretsKey(): Buffer {
	const key = Buffer.from(required('SECRETS_KEY'), 'base64');
	if (key.length !== 32) {
		throw new Error('SECRETS_KEY must be 32 random bytes in base64 (openssl rand -base64 32)');
	}
	return key;
}

export const env = {
	/** Path to the SQLite database file, e.g. ./data/bmuster.db */
	databasePath: required('DATABASE_PATH'),
	/** Encrypts secrets at rest (the server's signing key, provider secrets). */
	secretsKey: secretsKey(),
	/** Folder of agent builds: <version>/<target>/bmuster-agent[.exe] */
	releasesPath: required('RELEASES_PATH')
};
