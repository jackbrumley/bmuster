import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

describe('environment (S15)', () => {
	it('starts without CONSOLE_AUTH', async () => {
		vi.stubEnv('CONSOLE_AUTH', undefined);
		vi.resetModules();
		const { env } = await import('#lib/server/env.ts');
		expect(env.databasePath).toBe(':memory:');
		expect(Object.keys(env)).toEqual([
			'launcher',
			'databasePath',
			'secretsKey',
			'releasesPath',
			'firstAdmin',
			'localNetworkModeAtFirstRun',
			'backupSchedule'
		]);
		expect(env.firstAdmin).toEqual({ kind: 'none' });
	});

	it('reads the optional first admin (S18): both or neither of email and password', async () => {
		vi.stubEnv('BMUSTER_ADMIN_EMAIL', 'root@example.com');
		vi.stubEnv('BMUSTER_ADMIN_PASSWORD', 'correct horse battery');
		vi.resetModules();
		const both = await import('#lib/server/env.ts');
		expect(both.env.firstAdmin).toEqual({
			kind: 'set',
			name: 'Administrator',
			email: 'root@example.com',
			password: 'correct horse battery'
		});

		vi.stubEnv('BMUSTER_ADMIN_PASSWORD', '');
		vi.resetModules();
		await expect(import('#lib/server/env.ts')).rejects.toThrow(
			'Set both BMUSTER_ADMIN_EMAIL and BMUSTER_ADMIN_PASSWORD, or neither'
		);
	});

	it('reads BMUSTER_LOCAL_NETWORK_MODE (SPEC-SERVER-INSTALL I12): on or nothing', async () => {
		vi.resetModules();
		expect((await import('#lib/server/env.ts')).env.localNetworkModeAtFirstRun).toBe(false);

		vi.stubEnv('BMUSTER_LOCAL_NETWORK_MODE', 'on');
		vi.resetModules();
		expect((await import('#lib/server/env.ts')).env.localNetworkModeAtFirstRun).toBe(true);

		vi.stubEnv('BMUSTER_LOCAL_NETWORK_MODE', 'yes');
		vi.resetModules();
		await expect(import('#lib/server/env.ts')).rejects.toThrow(
			'BMUSTER_LOCAL_NETWORK_MODE must be on or left out, not yes'
		);
	});

	it('reads the nightly snapshot settings (SPEC-HOSTING H3)', async () => {
		vi.resetModules();
		expect((await import('#lib/server/env.ts')).env.backupSchedule).toEqual({
			kind: 'daily',
			hour: 3,
			minute: 0,
			keep: 14
		});

		vi.stubEnv('BMUSTER_BACKUP_TIME', '23:45');
		vi.stubEnv('BMUSTER_BACKUP_KEEP', '7');
		vi.resetModules();
		expect((await import('#lib/server/env.ts')).env.backupSchedule).toEqual({
			kind: 'daily',
			hour: 23,
			minute: 45,
			keep: 7
		});

		vi.stubEnv('BMUSTER_BACKUP_KEEP', '0');
		vi.resetModules();
		expect((await import('#lib/server/env.ts')).env.backupSchedule).toEqual({ kind: 'off' });

		vi.stubEnv('BMUSTER_BACKUP_TIME', '3am');
		vi.resetModules();
		await expect(import('#lib/server/env.ts')).rejects.toThrow(
			'BMUSTER_BACKUP_TIME must be HH:MM (24-hour), not 3am'
		);

		vi.stubEnv('BMUSTER_BACKUP_TIME', '03:00');
		vi.stubEnv('BMUSTER_BACKUP_KEEP', 'all');
		vi.resetModules();
		await expect(import('#lib/server/env.ts')).rejects.toThrow(
			'BMUSTER_BACKUP_KEEP must be a whole number (0 turns snapshots off), not all'
		);
	});

	it('no longer lists CONSOLE_AUTH for installers', () => {
		expect(readFileSync('.env.example', 'utf8')).not.toContain('CONSOLE_AUTH');
	});
});
