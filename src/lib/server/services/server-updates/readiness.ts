import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGELOG } from '#lib/domain/releases/changelog.ts';
import type { LauncherConfig } from '../../env.ts';

/**
 * Once the server listens: tells the root updater this release is ready, with the nonce its
 * launcher passed and the version it runs (SPEC-SERVER-UPDATES). Nothing outside an install.
 */
export function publishReady(config: LauncherConfig): void {
	if (config.kind !== 'installed') return;
	const path = join(config.dataDir, 'ready.json');
	writeFileSync(
		`${path}.new`,
		JSON.stringify({ nonce: config.nonce, version: CHANGELOG[0].version }),
		{ mode: 0o600 }
	);
	renameSync(`${path}.new`, path);
}
