import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGELOG } from '#lib/domain/releases/changelog.ts';
import { compareAgentVersions } from '#lib/domain/machines/agent-version.ts';
import {
	serverUpdateStateSchema,
	updateCacheSchema,
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
const EMPTY: UpdateCache = {
	checkedAtIso: null,
	lastSuccessAtIso: null,
	release: null,
	problem: null
};
const IDLE = { current: null, previous: null, pending: null, phase: 'idle', message: '' } as const;

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
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
			}
		}
	}
	view(): ServerUpdateView {
		const config = this.#config;
		let operation: ServerUpdateView['operation'] = { ...IDLE };
		if (config.kind === 'installed') {
			try {
				operation = serverUpdateStateSchema.parse(
					JSON.parse(readBounded(join(config.dataDir, 'state.json'), 32 * 1024).toString('utf8'))
				);
			} catch (error) {
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
			}
		}
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
		if (reason === '' && release !== null && config.kind === 'installed') {
			if (compareAgentVersions(release.manifest.minimumLauncher, config.version) > 0)
				reason = 'This release needs a newer launcher. Rerun the administrator installer.';
			else if (!release.manifest.rollbackFrom.includes(this.#current))
				reason =
					'This release has no tested schema-compatible rollback to this version. Rerun the administrator installer.';
		}
		if (['downloading', 'preparing', 'starting'].includes(operation.phase))
			reason = 'A server update is already in progress.';
		return {
			installedVersion: this.#current,
			deployment: config.kind,
			launcherVersion: config.kind === 'installed' ? config.version : null,
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
		writeFileSync(join(this.#config.dataDir, 'request.json'), JSON.stringify({ version }), {
			flag: 'wx',
			mode: 0o600
		});
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
