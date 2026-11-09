import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGELOG } from '#lib/domain/releases/changelog.ts';
import { compareAgentVersions } from '#lib/domain/machines/agent-version.ts';
import {
	updateCacheSchema,
	updaterStatusSchema,
	type ServerUpdateOperation,
	type UpdateCache,
	type ServerUpdateView
} from '#lib/schemas/releases/server-updates.ts';
import type { AppDatabase } from '../../database/connection.ts';
import type { LauncherConfig } from '../../env.ts';
import { recordAudit } from '../audit/audit.ts';
import { getSetting } from '../settings/settings.ts';
import { download, newestRelease, RELEASE_PUBLIC_KEY } from './release.ts';
import { readBounded } from './files.ts';

const DAY = 24 * 60 * 60 * 1000;
const FAILED_CHECK_RETRY = 5 * 60 * 1000;
/**
 * The request for the root updater (SPEC-SERVER-UPDATES). It is always empty: the updater never
 * reads it, and installs only the newest release signed with the key compiled into it.
 */
export const UPDATE_FLAG = 'update-requested';
/** Written only by the root updater. */
export const UPDATE_STATUS = 'update-status.json';
const EMPTY: UpdateCache = {
	checkedAtIso: null,
	lastSuccessAtIso: null,
	release: null,
	problem: null
};
const IDLE: ServerUpdateOperation = {
	phase: 'idle',
	from: null,
	to: null,
	message: '',
	atIso: null
};
const IN_PROGRESS = new Set<ServerUpdateOperation['phase']>([
	'requested',
	'checking',
	'downloading',
	'switching',
	'starting'
]);
export const REINSTALL_ONCE =
	'This release cannot update this server by itself. Re-run the installer once (install.sh on Linux, install.ps1 on Windows); from then on the whole server, including Node, updates itself.';

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

type Latest = () => Promise<UpdateCache['release']>;
export class ServerUpdates {
	readonly #database: AppDatabase;
	readonly #config: LauncherConfig;
	readonly #current: string;
	readonly #latest: Latest;
	#cache: UpdateCache;
	#pending: Promise<void> | undefined;
	constructor(database: AppDatabase, config: LauncherConfig, current: string, latest: Latest) {
		this.#database = database;
		this.#config = config;
		this.#current = current;
		this.#latest = latest;
		this.#cache = { ...EMPTY };
		if (config.kind === 'installed') {
			try {
				this.#cache = updateCacheSchema.parse(
					JSON.parse(readBounded(join(config.dataDir, 'check.json'), 512 * 1024).toString('utf8'))
				);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
	}
	/** The request waiting for the updater, else the updater's last status. */
	#operation(): ServerUpdateOperation {
		const config = this.#config;
		if (config.kind !== 'installed') return IDLE;
		try {
			const flag = lstatSync(join(config.dataDir, UPDATE_FLAG));
			return {
				phase: 'requested',
				from: this.#current,
				to: null,
				message: 'Waiting for the updater to start.',
				atIso: flag.mtime.toISOString()
			};
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		try {
			const status = updaterStatusSchema.parse(
				JSON.parse(readBounded(join(config.dataDir, UPDATE_STATUS), 32 * 1024).toString('utf8'))
			);
			return {
				phase: status.phase,
				from: status.from,
				to: status.to,
				message: status.message,
				atIso: new Date(status.atMs).toISOString()
			};
		} catch (error) {
			if (isMissing(error)) return IDLE;
			throw error;
		}
	}
	view(): ServerUpdateView {
		const config = this.#config;
		const operation = this.#operation();
		let reason =
			config.kind === 'docker'
				? 'Deploy the new image tag in Docker or Coolify.'
				: config.kind === 'source'
					? 'This is a source development run. Install a release to use server self-update.'
					: '';
		const release =
			this.#cache.release !== null &&
			compareAgentVersions(this.#cache.release.version, this.#current) > 0
				? this.#cache.release
				: null;
		if (reason === '' && release === null)
			reason =
				this.#cache.problem === null
					? 'No newer signed release is available.'
					: 'Could not confirm whether a newer signed release is available. Check for updates again.';
		if (
			reason === '' &&
			release !== null &&
			compareAgentVersions(release.manifest.minimumLauncher, this.#current) > 0
		)
			reason = REINSTALL_ONCE;
		if (IN_PROGRESS.has(operation.phase)) reason = 'A server update is already in progress.';
		return {
			installedVersion: this.#current,
			deployment: config.kind,
			...this.#cache,
			release,
			install: { allowed: reason === '', reason },
			operation
		};
	}
	check(userId: string | null, now: number): Promise<void> {
		if (this.#pending !== undefined) return this.#pending;
		this.#pending = this.#performCheck(userId, now).finally(() => {
			this.#pending = undefined;
		});
		return this.#pending;
	}
	async #performCheck(userId: string | null, now: number): Promise<void> {
		try {
			const release = await this.#latest();
			this.#cache = {
				checkedAtIso: new Date(now).toISOString(),
				lastSuccessAtIso: new Date(now).toISOString(),
				release,
				problem: null
			};
		} catch (error) {
			this.#cache = {
				...this.#cache,
				checkedAtIso: new Date(now).toISOString(),
				problem: error instanceof Error ? error.message : String(error)
			};
		}
		if (this.#config.kind === 'installed') {
			mkdirSync(this.#config.dataDir, { recursive: true });
			const path = join(this.#config.dataDir, 'check.json');
			writeFileSync(`${path}.new`, JSON.stringify(this.#cache), { mode: 0o600 });
			renameSync(`${path}.new`, path);
		}
		if (userId !== null)
			recordAudit(
				this.#database,
				{
					actor: { kind: 'user', userId },
					kind: 'server-update-checked',
					target: 'BMuster server',
					machineId: null,
					detail: { result: this.#cache.problem ?? 'Checked successfully' }
				},
				now
			);
	}
	/**
	 * Asks the root updater for an update: an empty flag file and nothing else. `version` is what
	 * the admin confirmed; the updater picks the newest signed release itself.
	 */
	request(version: string, userId: string, now: number): void {
		const view = this.view();
		if (
			this.#config.kind !== 'installed' ||
			!view.install.allowed ||
			view.release?.version !== version
		)
			throw new Error(
				view.install.reason === ''
					? 'Check for updates again before installing this version.'
					: view.install.reason
			);
		writeFileSync(join(this.#config.dataDir, UPDATE_FLAG), '', { flag: 'wx', mode: 0o600 });
		recordAudit(
			this.#database,
			{
				actor: { kind: 'user', userId },
				kind: 'server-update-requested',
				target: 'BMuster server',
				machineId: null,
				detail: { version }
			},
			now
		);
	}
	due(now: number): boolean {
		const checkedAt = this.#cache.checkedAtIso;
		return (
			getSetting(this.#database, 'serverUpdateChecks') &&
			(checkedAt === null ||
				now - Date.parse(checkedAt) >= (this.#cache.problem === null ? DAY : FAILED_CHECK_RETRY))
		);
	}
}

export function makeServerUpdates(database: AppDatabase, config: LauncherConfig): ServerUpdates {
	const target =
		config.kind === 'installed'
			? config.target
			: process.platform === 'win32'
				? 'x86_64-pc-windows-msvc'
				: process.arch === 'arm64'
					? 'aarch64-unknown-linux-gnu'
					: 'x86_64-unknown-linux-gnu';
	return new ServerUpdates(database, config, CHANGELOG[0].version, () =>
		newestRelease(CHANGELOG[0].version, target, download, RELEASE_PUBLIC_KEY)
	);
}
