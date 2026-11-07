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

/** A variable that may be left out; empty counts as not set. */
function optional(name: string): string | undefined {
	const value = process.env[name];
	return value === undefined || value === '' ? undefined : value;
}

/**
 * The first admin, made at start-up when the server has no users
 * (SPEC-SIGN-IN S18). For unattended installs; never changes an existing account.
 */
export type FirstAdmin =
	{ kind: 'none' } | { kind: 'set'; name: string; email: string; password: string };

function firstAdmin(): FirstAdmin {
	const email = optional('BMUSTER_ADMIN_EMAIL');
	const password = optional('BMUSTER_ADMIN_PASSWORD');
	const name = optional('BMUSTER_ADMIN_NAME');
	if (email === undefined && password === undefined) {
		if (name !== undefined) {
			throw new Error('BMUSTER_ADMIN_NAME is set without BMUSTER_ADMIN_EMAIL and _PASSWORD');
		}
		return { kind: 'none' };
	}
	if (email === undefined || password === undefined) {
		throw new Error('Set both BMUSTER_ADMIN_EMAIL and BMUSTER_ADMIN_PASSWORD, or neither');
	}
	return { kind: 'set', name: name ?? 'Administrator', email, password };
}

/**
 * BMUSTER_LOCAL_NETWORK_MODE=on (SPEC-SERVER-INSTALL I12): the installer's
 * default, so a fresh server with no domain serves HTTPS with its own
 * certificate. Applied only while the server has no users.
 */
function localNetworkModeAtFirstRun(): boolean {
	const value = optional('BMUSTER_LOCAL_NETWORK_MODE');
	if (value === undefined) {
		return false;
	}
	if (value !== 'on') {
		throw new Error(`BMUSTER_LOCAL_NETWORK_MODE must be on or left out, not ${value}`);
	}
	return true;
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
	releasesPath: required('RELEASES_PATH'),
	/** Optional: the admin to create on a server with no users (S18). */
	firstAdmin: firstAdmin(),
	/** Optional: turn local network mode on for a server with no users (I12). */
	localNetworkModeAtFirstRun: localNetworkModeAtFirstRun()
};
