import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { POST as install } from '../../../../routes/api/server-updates/install/+server.ts';
import { isCrossOriginWrite } from '../../hooks/origin-check.ts';
import { listAudit } from '../audit/audit.ts';
import { REINSTALL_ONCE, ServerUpdates, UPDATE_FLAG, UPDATE_STATUS } from './service.ts';

const TARGET = 'x86_64-unknown-linux-gnu' as const;
const release = {
	version: '0.4.1',
	notes: 'A tested update.',
	publishedAtIso: '2026-11-09T00:00:00.000Z',
	manifest: {
		schemaVersion: 1 as const,
		version: '0.4.1',
		target: TARGET,
		archive: `bmuster-app-${TARGET}.tar.gz`,
		bytes: 100,
		sha256: 'a'.repeat(64),
		minimumLauncher: '0.4.0',
		nodeMajor: 26,
		rollbackFrom: ['0.4.0']
	}
};

function installed(dataDir: string) {
	return { kind: 'installed' as const, dataDir, target: TARGET, nonce: 'a'.repeat(64) };
}

async function withChecked(
	current: string,
	offered: typeof release,
	run: (service: ServerUpdates, folder: string, adminId: string) => void
): Promise<void> {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: `guards-${crypto.randomUUID()}@example.com`,
		role: 'admin',
		password: null
	});
	const folder = mkdtempSync(join(tmpdir(), 'bmuster-update-guards-'));
	try {
		const service = new ServerUpdates(database, installed(folder), current, () =>
			Promise.resolve(offered)
		);
		await service.check(null, NOW);
		run(service, folder, admin.id);
		expect(listAudit(database, 10).map((entry) => entry.kind)).toEqual(
			readdirSync(folder).includes(UPDATE_FLAG) ? ['server-update-requested'] : []
		);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

type InstallEvent = RequestEvent<Record<string, never>, '/api/server-updates/install'>;

function event(user: ConsoleUser | null): InstallEvent {
	const url = new URL('https://bmuster.test/api/server-updates/install');
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request'> = {
		locals: { session: user === null ? { kind: 'none' } : { kind: 'signed-in', user } },
		url,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: url.origin },
			body: JSON.stringify({ version: '0.4.1' })
		})
	};
	return partial as InstallEvent;
}

describe('Update now (SPEC-SERVER-UPDATES SU2)', () => {
	it('writes only the empty flag, and audits who asked', async () => {
		await withChecked('0.4.0', release, (service, folder, adminId) => {
			service.request('0.4.1', adminId, NOW);
			expect(readdirSync(folder).sort()).toEqual(['check.json', UPDATE_FLAG]);
			expect(statSync(join(folder, UPDATE_FLAG)).size).toBe(0);
			expect(service.view().operation.phase).toBe('requested');
			expect(service.view().install).toEqual({
				allowed: false,
				reason: 'A server update is already in progress.'
			});
			// A second request while one waits is refused.
			expect(() => {
				service.request('0.4.1', adminId, NOW);
			}).toThrow();
		});
	});

	it('refuses a version other than the one on offer, and a release that needs the installer', async () => {
		await withChecked('0.4.0', release, (service, _folder, adminId) => {
			expect(() => {
				service.request('9.9.9', adminId, NOW);
			}).toThrow();
		});
		await withChecked(
			'0.3.3',
			{ ...release, manifest: { ...release.manifest, minimumLauncher: '0.4.0' } },
			(service, folder, adminId) => {
				expect(service.view().install).toEqual({ allowed: false, reason: REINSTALL_ONCE });
				expect(() => {
					service.request('0.4.1', adminId, NOW);
				}).toThrow(REINSTALL_ONCE);
				expect(readdirSync(folder)).not.toContain(UPDATE_FLAG);
			}
		);
	});

	it('is refused for Docker and source runs, which have no updater', async () => {
		const database = testDatabase();
		for (const kind of ['docker', 'source'] as const) {
			const service = new ServerUpdates(database, { kind }, '0.4.0', () =>
				Promise.resolve(release)
			);
			await service.check(null, NOW);
			expect(service.view().install.allowed).toBe(false);
			expect(() => {
				service.request('0.4.1', 'someone', NOW);
			}).toThrow();
		}
	});

	it('shows the updater status, and a result older than the request is not mistaken for it', async () => {
		await withChecked('0.4.0', release, (service, folder) => {
			writeFileSync(
				join(folder, UPDATE_STATUS),
				JSON.stringify({
					phase: 'rolled-back',
					from: '0.4.0',
					to: '0.4.1',
					message: 'BMuster 0.4.1 did not report ready within 120 s.',
					atMs: NOW
				})
			);
			expect(service.view().operation).toEqual({
				phase: 'rolled-back',
				from: '0.4.0',
				to: '0.4.1',
				message: 'BMuster 0.4.1 did not report ready within 120 s.',
				atIso: new Date(NOW).toISOString()
			});
			expect(service.view().install.allowed).toBe(true);
			// The app never writes the status file itself.
			expect(JSON.parse(readFileSync(join(folder, UPDATE_STATUS), 'utf8'))).toMatchObject({
				phase: 'rolled-back'
			});
		});
	});

	it('is admin-only and origin-checked', async () => {
		const member: ConsoleUser = { id: 'm', name: 'Mo', email: 'mo@example.com', role: 'member' };
		expect((await install(event(null))).status).toBe(401);
		expect((await install(event(member))).status).toBe(403);
		const url = new URL('https://bmuster.test/api/server-updates/install');
		expect(
			isCrossOriginWrite(
				new Request(url, { method: 'POST', headers: { origin: 'https://evil.example' } }),
				url
			)
		).toBe(true);
	});
});
