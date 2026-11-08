/**
 * The one place server code reads environment variables. A missing value
 * stops the server at start-up (fail hard), never later at first use.
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SnapshotSchedule } from './database/snapshots.ts';

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

/**
 * The nightly database snapshot (SPEC-HOSTING H3): BMUSTER_BACKUP_TIME is
 * HH:MM in the server's time zone (TZ), 03:00 when left out;
 * BMUSTER_BACKUP_KEEP is how many daily snapshots to keep, 14 when left
 * out, and 0 turns snapshots off.
 */
function backupSchedule(): SnapshotSchedule {
	const keepText = optional('BMUSTER_BACKUP_KEEP') ?? '14';
	if (!/^\d{1,4}$/.test(keepText)) {
		throw new Error(
			`BMUSTER_BACKUP_KEEP must be a whole number (0 turns snapshots off), not ${keepText}`
		);
	}
	const keep = Number.parseInt(keepText, 10);
	const timeText = optional('BMUSTER_BACKUP_TIME') ?? '03:00';
	const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeText);
	if (time === null) {
		throw new Error(`BMUSTER_BACKUP_TIME must be HH:MM (24-hour), not ${timeText}`);
	}
	if (keep === 0) {
		return { kind: 'off' };
	}
	return {
		kind: 'daily',
		hour: Number.parseInt(time[1] ?? '', 10),
		minute: Number.parseInt(time[2] ?? '', 10),
		keep
	};
}

function secretsKey(): Buffer {
	const key = Buffer.from(required('SECRETS_KEY'), 'base64');
	if (key.length !== 32) {
		throw new Error('SECRETS_KEY must be 32 random bytes in base64 (openssl rand -base64 32)');
	}
	return key;
}

export type LauncherConfig =
	| { kind: 'source' | 'docker' }
	| {
			kind: 'installed';
			dataDir: string;
			version: string;
			target: 'x86_64-unknown-linux-gnu' | 'aarch64-unknown-linux-gnu' | 'x86_64-pc-windows-msvc';
			nonce: string;
	  };

function launcherConfig(): LauncherConfig {
	const kind = optional('BMUSTER_DEPLOYMENT') ?? 'source';
	const dataDir = optional('BMUSTER_UPDATE_DATA');
	const version = optional('BMUSTER_LAUNCHER_VERSION');
	const target = optional('BMUSTER_LAUNCHER_TARGET');
	const nonce = optional('BMUSTER_READINESS_NONCE');
	if (kind === 'source' || kind === 'docker') {
		if ([dataDir, version, target, nonce].some((value) => value !== undefined))
			throw new Error('Launcher settings require BMUSTER_DEPLOYMENT=installed');
		return { kind };
	}
	if (
		kind !== 'installed' ||
		dataDir === undefined ||
		!isAbsolute(dataDir) ||
		version === undefined ||
		!/^\d+\.\d+\.\d+$/.test(version) ||
		nonce === undefined ||
		!/^[a-f0-9]{64}$/.test(nonce) ||
		(target !== 'x86_64-unknown-linux-gnu' &&
			target !== 'aarch64-unknown-linux-gnu' &&
			target !== 'x86_64-pc-windows-msvc')
	)
		throw new Error('Installed server launcher settings are incomplete or invalid');
	return { kind, dataDir, version, target, nonce };
}

export const env = {
	launcher: launcherConfig(),
	/** Path to the SQLite database file, e.g. ./data/bmuster.db */
	databasePath: required('DATABASE_PATH'),
	/** Encrypts secrets at rest (the server's signing key, provider secrets). */
	secretsKey: secretsKey(),
	/** Folder of agent builds: <version>/<target>/bmuster-agent[.exe] */
	releasesPath: required('RELEASES_PATH'),
	/** Optional: the admin to create on a server with no users (S18). */
	firstAdmin: firstAdmin(),
	/** Optional: turn local network mode on for a server with no users (I12). */
	localNetworkModeAtFirstRun: localNetworkModeAtFirstRun(),
	/** Optional: when and how many nightly database snapshots (H3). */
	backupSchedule: backupSchedule()
};
