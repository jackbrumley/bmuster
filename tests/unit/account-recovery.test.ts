/**
 * Account recovery from the server's shell (SPEC-SERVER-INSTALL I15, SPEC-SIGN-IN S19,
 * SPEC-TWO-FACTOR TF15): the command line in scripts/account-recovery/cli.ts, and the release
 * bundle's app/account-recovery.js, which `bmuster-server reset-password | reset-two-factor` and
 * the image's `bmuster-server` run, against a database file the way an installed server keeps it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS_FOLDER } from '#lib/server/database/connection.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { verifyPassword } from '#lib/server/services/auth/passwords.ts';
import { isTwoFactorOn } from '#lib/server/services/auth/two-factor.ts';
import { findUserByEmail } from '#lib/server/services/users/users.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { turnOnTwoFactor } from '#tests/helpers/two-factor.ts';
import { runAccountRecovery } from '../../scripts/account-recovery/cli.ts';
import { APP_ENTRIES, bundleAppEntries } from '../../scripts/release/app-entries.ts';

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function captured() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }
	};
}

describe('the account recovery command line (SPEC-SERVER-INSTALL I15)', () => {
	it('shows the usage, and opens no database, for a missing or unknown command or email', async () => {
		for (const argv of [
			[],
			['reset-everything', '--email', 'ada@example.com'],
			['reset-two-factor'],
			['reset-two-factor', '--email', '  '],
			['reset-password', 'ada@example.com'],
			['reset-password', '--email', 'ada@example.com', '--force']
		]) {
			const { out, err, io } = captured();
			const code = await runAccountRecovery(
				argv,
				() => {
					throw new Error('opened the database');
				},
				io,
				NOW
			);
			expect(code, argv.join(' ')).toBe(1);
			expect(out).toEqual([]);
			expect(err.join('\n')).toContain('bmuster-server reset-two-factor --email <email>');
		}
	});

	it('turns off two-factor for the account, audited as system (TF15)', async () => {
		const database = testDatabase();
		const ada = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: PASSWORD
		});
		await turnOnTwoFactor(database, ada, NOW);
		const { out, err, io } = captured();
		const code = await runAccountRecovery(
			['reset-two-factor', '--email', ' Ada@Example.com '],
			() => database,
			io,
			NOW
		);
		expect(err).toEqual([]);
		expect(code).toBe(0);
		expect(out).toEqual([
			'Two-factor sign-in is off for ada@example.com. They sign in with their password; if the server requires two-factor, they set it up again straight away.'
		]);
		expect(isTwoFactorOn(database, ada.id)).toBe(false);
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'two-factor-reset',
			actorUserId: null,
			target: 'ada@example.com'
		});
	});

	it('prints an admin’s new password once and refuses an unknown email, changing nothing (S19)', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: PASSWORD });
		const reset = captured();
		expect(
			await runAccountRecovery(
				['reset-password', '--email', 'ada@example.com'],
				() => database,
				reset.io,
				NOW
			)
		).toBe(0);
		const password = reset.out[2]?.trim() ?? '';
		expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/);
		const hash = findUserByEmail(database, 'ada@example.com')?.passwordHash ?? '';
		expect(await verifyPassword(hash, password)).toBe(true);

		const before = listAudit(database, 50).length;
		const unknown = captured();
		expect(
			await runAccountRecovery(
				['reset-two-factor', '--email', 'nobody@example.com'],
				() => database,
				unknown.io,
				NOW
			)
		).toBe(1);
		expect(unknown.err).toEqual(['reset-two-factor: No account has the email nobody@example.com.']);
		expect(listAudit(database, 50)).toHaveLength(before);
	});
});

describe('the release bundle carries the account recovery entry (SPEC-SERVER-INSTALL I15)', () => {
	it('names the file the launcher runs', () => {
		expect(Object.keys(APP_ENTRIES)).toEqual(['server', 'account-recovery']);
		const launcher = readFileSync('agent/crates/server/src/recovery.rs', 'utf8');
		expect(launcher).toContain('pub const ENTRY: &str = "account-recovery.js";');
	});

	it('bundles app/account-recovery.js, which resets two-factor in a database file as the server keeps it', async () => {
		const root = mkdtempSync(join(tmpdir(), 'bmuster-recovery-'));
		folders.push(root);
		// app/ as the release lays it out: the bundled entries, node_modules and the migrations.
		const app = join(root, 'app');
		await bundleAppEntries(app);
		symlinkSync(resolve('node_modules'), join(app, 'node_modules'), 'junction');
		mkdirSync(join(app, MIGRATIONS_FOLDER, '..'), { recursive: true });
		symlinkSync(resolve(MIGRATIONS_FOLDER), join(app, MIGRATIONS_FOLDER), 'junction');

		const databasePath = join(root, 'data', 'bmuster.db');
		const database = openDatabase(databasePath);
		const ada = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: PASSWORD
		});
		await turnOnTwoFactor(database, ada, NOW);
		database.$client.close();

		const result = spawnSync(
			process.execPath,
			['account-recovery.js', 'reset-two-factor', '--email', 'ada@example.com'],
			{
				cwd: app,
				encoding: 'utf8',
				env: {
					PATH: process.env['PATH'],
					DATABASE_PATH: databasePath,
					SECRETS_KEY: Buffer.alloc(32, 1).toString('base64'),
					RELEASES_PATH: join(root, 'releases')
				}
			}
		);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Two-factor sign-in is off for ada@example.com.');

		const after = openDatabase(databasePath);
		expect(isTwoFactorOn(after, ada.id)).toBe(false);
		expect(listAudit(after, 1)[0]).toMatchObject({
			kind: 'two-factor-reset',
			actorUserId: null,
			detail: { how: 'from the server command line' }
		});
		after.$client.close();
	}, 120_000);
});
