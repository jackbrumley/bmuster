import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { CHANGELOG } from '#lib/domain/releases/changelog.ts';
import type { AppDatabase } from '../../database/connection.ts';
import type { LauncherConfig } from '../../env.ts';
import type { Relay } from '../sessions/relay.ts';
import { readBounded } from './files.ts';

const prepareSchema = z.strictObject({ nonce: z.string().regex(/^[a-f0-9]{64}$/) });
function write(path: string, data: unknown): void {
	writeFileSync(`${path}.new`, JSON.stringify(data), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

export function publishReady(config: LauncherConfig): void {
	if (config.kind !== 'installed') return;
	write(join(config.dataDir, 'ready.json'), {
		nonce: config.nonce,
		version: CHANGELOG[0].version,
		processId: process.pid
	});
}

export function startPreparation(
	database: AppDatabase,
	databasePath: string,
	config: LauncherConfig,
	relay: Relay,
	log: (line: string) => void
): () => void {
	if (config.kind !== 'installed') return () => undefined;
	let running = false;
	let handled: string | null = null;
	const poll = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			let bytes: Buffer;
			try {
				bytes = readBounded(join(config.dataDir, 'prepare.json'), 4096);
			} catch (error) {
				if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
					handled = null;
					relay.resumeAfterServerUpdate();
					return;
				}
				throw error;
			}
			const request = prepareSchema.parse(JSON.parse(bytes.toString('utf8')));
			if (request.nonce !== config.nonce || handled === request.nonce) return;
			handled = request.nonce;
			try {
				if (databasePath === ':memory:')
					throw new Error('Installed servers require a persistent database before updating.');
				const backups = join(dirname(databasePath), 'backups');
				mkdirSync(backups, { recursive: true });
				await database.$client.backup(join(backups, `before-server-update-${request.nonce}.db`));
				// Cancellation during backup must not leave the still-running server quiesced.
				if (
					prepareSchema.parse(
						JSON.parse(readBounded(join(config.dataDir, 'prepare.json'), 4096).toString('utf8'))
					).nonce !== request.nonce
				)
					return;
				relay.prepareForServerUpdate();
				write(join(config.dataDir, 'prepared.json'), { nonce: request.nonce, error: null });
			} catch (error) {
				write(join(config.dataDir, 'prepared.json'), {
					nonce: request.nonce,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		} catch (error) {
			log(
				`Server update preparation failed: ${error instanceof Error ? error.message : String(error)}`
			);
		} finally {
			running = false;
		}
	};
	const timer = setInterval(() => {
		void poll();
	}, 250);
	timer.unref();
	return () => {
		clearInterval(timer);
	};
}
