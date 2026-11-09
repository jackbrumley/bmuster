import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { ServerUpdates } from './service.ts';

const release = {
	version: '0.3.1',
	notes: 'A tested update.',
	publishedAtIso: '2026-11-08T00:00:00.000Z',
	manifest: {
		schemaVersion: 1 as const,
		version: '0.3.1',
		target: 'x86_64-unknown-linux-gnu' as const,
		archive: 'bmuster-app-x86_64-unknown-linux-gnu.tar.gz',
		bytes: 100,
		sha256: 'a'.repeat(64),
		minimumLauncher: '0.3.0',
		nodeMajor: 26,
		rollbackFrom: ['0.3.0']
	}
};

describe('server update service (SPEC-SERVER-UPDATES SU1)', () => {
	it('checks on demand, coalesces requests and records the last successful check', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'server-update@example.com',
			role: 'admin',
			password: null
		});
		const folder = mkdtempSync(join(tmpdir(), 'bmuster-update-check-'));
		try {
			let checks = 0;
			const service = new ServerUpdates(
				database,
				{
					kind: 'installed',
					dataDir: folder,
					target: release.manifest.target,
					nonce: 'a'.repeat(64)
				},
				'0.3.0',
				() => {
					checks += 1;
					return Promise.resolve(release);
				}
			);
			const [first, second] = await Promise.all([
				service.check(admin.id, NOW),
				service.check(admin.id, NOW)
			]);
			expect(first).toBeUndefined();
			expect(second).toBeUndefined();
			expect(checks).toBe(1);
			expect(service.view()).toMatchObject({
				release: { version: '0.3.1' },
				lastSuccessAtIso: new Date(NOW).toISOString(),
				install: { allowed: true }
			});
			expect(listAudit(database, 10)).toHaveLength(1);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it('hides a cached release after this server has already installed it', () => {
		const database = testDatabase();
		const folder = mkdtempSync(join(tmpdir(), 'bmuster-update-current-'));
		try {
			writeFileSync(
				join(folder, 'check.json'),
				JSON.stringify({
					checkedAtIso: '2026-11-08T00:00:00.000Z',
					lastSuccessAtIso: '2026-11-08T00:00:00.000Z',
					release,
					problem: null
				})
			);
			const service = new ServerUpdates(
				database,
				{
					kind: 'installed',
					dataDir: folder,
					target: release.manifest.target,
					nonce: 'b'.repeat(64)
				},
				'0.3.1',
				() => Promise.resolve(null)
			);
			expect(service.view().release).toBeNull();
			expect(service.view().install.allowed).toBe(false);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it('does not claim that no update exists when the latest check failed', async () => {
		const database = testDatabase();
		const folder = mkdtempSync(join(tmpdir(), 'bmuster-update-failed-check-'));
		try {
			const service = new ServerUpdates(
				database,
				{
					kind: 'installed',
					dataDir: folder,
					target: release.manifest.target,
					nonce: 'c'.repeat(64)
				},
				'0.3.0',
				() => Promise.reject(new Error('Update check returned HTTP 504.'))
			);
			await service.check(null, NOW);
			expect(service.due(NOW + 5 * 60 * 1000 - 1)).toBe(false);
			expect(service.due(NOW + 5 * 60 * 1000)).toBe(true);
			expect(service.view()).toMatchObject({
				problem: 'Update check returned HTTP 504.',
				install: {
					allowed: false,
					reason:
						'Could not confirm whether a newer signed release is available. Check for updates again.'
				}
			});
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
