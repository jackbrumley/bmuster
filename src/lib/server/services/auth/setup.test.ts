import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { users } from '../../database/schema.ts';
import { needsSetupRedirect } from '../../hooks/setup-redirect.ts';
import { listAudit } from '../audit/audit.ts';
import { hasUsers } from '../users/users.ts';
import { signInWithPassword } from './password-sign-in.ts';
import { findSession } from './sessions.ts';
import { prepareFirstRun, setupFirstAdmin } from './setup.ts';
import { SETUP_CODE_TRIES, setupCodeKeeper, type SetupCodeKeeper } from './setup-code.ts';

/** A keeper whose printed lines the test can read, and the code from the latest banner. */
function printedKeeper(): { keeper: SetupCodeKeeper; lines: string[]; latestCode: () => string } {
	const lines: string[] = [];
	const keeper = setupCodeKeeper((line) => lines.push(line));
	return {
		keeper,
		lines,
		latestCode() {
			const match = /setup code: ([A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}) — open \/setup/.exec(
				lines.at(-1) ?? ''
			);
			if (match?.[1] === undefined) throw new Error('no setup code printed');
			return match[1];
		}
	};
}

const ADMIN_INPUT = { name: 'Jack', email: 'Jack@Example.com', password: PASSWORD };

describe('first-run setup (S1)', () => {
	it('sends every page to /setup while there are no users, and nothing afterwards', () => {
		for (const path of ['/', '/login', '/users', '/machines/abc']) {
			expect(needsSetupRedirect(path, false), path).toBe(true);
		}
		// /setup itself, the API (guards answer 401), assets and agents are left alone.
		for (const path of [
			'/setup',
			'/api/users',
			'/_app/x.js',
			'/agent/v1/check-in',
			'/install.sh'
		]) {
			expect(needsSetupRedirect(path, false), path).toBe(false);
		}
		expect(needsSetupRedirect('/', true)).toBe(false);
	});

	it('creates the first admin once, signed in, with a hashed password', async () => {
		const database = testDatabase();
		expect(hasUsers(database)).toBe(false);
		const printed = printedKeeper();
		printed.keeper.ensureIssued();
		const result = await setupFirstAdmin(
			database,
			{ ...ADMIN_INPUT, setupCode: printed.latestCode() },
			printed.keeper,
			CLIENT,
			NOW
		);
		if (result.kind !== 'created') throw new Error('setup refused');
		expect(result.user).toMatchObject({ name: 'Jack', email: 'jack@example.com', role: 'admin' });
		expect(findSession(database, result.session.token, NOW)).toEqual({
			kind: 'active',
			userId: result.user.id
		});
		const [row] = database.select().from(users).all();
		expect(row?.passwordHash?.startsWith('$argon2id$')).toBe(true);

		const again = await setupFirstAdmin(
			database,
			{ name: 'Mallory', email: 'mallory@example.com', password: PASSWORD, setupCode: '' },
			printed.keeper,
			CLIENT,
			NOW
		);
		expect(again).toEqual({ kind: 'closed' });
		expect(database.select().from(users).all()).toHaveLength(1);
	});
});

describe('setup code (S17)', () => {
	it('prints a one-time code at start-up when there are no users, and none once there are', async () => {
		const database = testDatabase();
		const printed = printedKeeper();
		await prepareFirstRun(database, { kind: 'none' }, printed.keeper, () => undefined, NOW);
		expect(printed.lines).toHaveLength(1);
		expect(printed.latestCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
		// A second call (a dev reload) keeps the waiting code.
		printed.keeper.ensureIssued();
		expect(printed.lines).toHaveLength(1);

		const withUsers = testDatabase();
		await addTestUser(withUsers, { email: 'ada@example.com', role: 'admin', password: PASSWORD });
		const quiet = printedKeeper();
		await prepareFirstRun(withUsers, { kind: 'none' }, quiet.keeper, () => undefined, NOW);
		expect(quiet.lines).toEqual([]);
	});

	it('refuses /setup without the right code, and accepts it typed loosely', async () => {
		const database = testDatabase();
		const printed = printedKeeper();
		printed.keeper.ensureIssued();
		for (const setupCode of ['', 'AAAA-AAAA-AAAA-AAAA']) {
			const refused = await setupFirstAdmin(
				database,
				{ ...ADMIN_INPUT, setupCode },
				printed.keeper,
				CLIENT,
				NOW
			);
			expect(refused).toEqual({
				kind: 'wrong-code',
				message: 'That setup code is not right. It is in the server log, where BMuster was started.'
			});
		}
		expect(hasUsers(database)).toBe(false);

		const typed = ` ${printed.latestCode().replaceAll('-', '').toLowerCase()} `;
		const created = await setupFirstAdmin(
			database,
			{ ...ADMIN_INPUT, setupCode: typed },
			printed.keeper,
			CLIENT,
			NOW
		);
		expect(created.kind).toBe('created');
	});

	it(`replaces the code after ${SETUP_CODE_TRIES} wrong tries, so guessing needs the log`, async () => {
		const database = testDatabase();
		const printed = printedKeeper();
		printed.keeper.ensureIssued();
		const first = printed.latestCode();
		const results = [];
		for (let attempt = 0; attempt < SETUP_CODE_TRIES; attempt += 1) {
			results.push(
				await setupFirstAdmin(
					database,
					{ ...ADMIN_INPUT, setupCode: 'WRONG-CODE' },
					printed.keeper,
					CLIENT,
					NOW
				)
			);
		}
		expect(results.at(-1)).toEqual({
			kind: 'wrong-code',
			message:
				'Too many wrong setup codes. The server has printed a new code to its log; enter that one.'
		});
		expect(printed.lines).toHaveLength(2);
		const second = printed.latestCode();
		expect(second).not.toBe(first);

		const old = await setupFirstAdmin(
			database,
			{ ...ADMIN_INPUT, setupCode: first },
			printed.keeper,
			CLIENT,
			NOW
		);
		expect(old.kind).toBe('wrong-code');
		const fresh = await setupFirstAdmin(
			database,
			{ ...ADMIN_INPUT, setupCode: second },
			printed.keeper,
			CLIENT,
			NOW
		);
		expect(fresh.kind).toBe('created');
	});
});

describe('admin from the environment (S18)', () => {
	const FIRST_ADMIN = {
		kind: 'set',
		name: 'Administrator',
		email: 'Root@Example.com',
		password: PASSWORD
	} as const;

	it('creates that admin at start-up, audited, with no setup code, and says to remove the variables', async () => {
		const database = testDatabase();
		const printed = printedKeeper();
		const log: string[] = [];
		await prepareFirstRun(database, FIRST_ADMIN, printed.keeper, (line) => log.push(line), NOW);

		expect(printed.lines).toEqual([]);
		const rows = database.select().from(users).all();
		expect(rows).toMatchObject([
			{ name: 'Administrator', email: 'root@example.com', role: 'admin', disabledAt: null }
		]);
		expect(log).toEqual([
			'BMuster: created the admin root@example.com from BMUSTER_ADMIN_EMAIL and BMUSTER_ADMIN_PASSWORD. Remove these variables now; they are not needed again.'
		]);
		expect(listAudit(database, 10)).toMatchObject([
			{
				kind: 'setup',
				actorUserId: null,
				target: 'root@example.com',
				detail: { source: 'BMUSTER_ADMIN_EMAIL and BMUSTER_ADMIN_PASSWORD' }
			}
		]);
		const signedIn = await signInWithPassword(
			database,
			{ email: 'root@example.com', password: PASSWORD },
			CLIENT,
			NOW
		);
		expect(signedIn.kind).toBe('signed-in');
		// /setup is closed: every page then goes to sign-in.
		expect(needsSetupRedirect('/', hasUsers(database))).toBe(false);
	});

	it('never changes an existing account', async () => {
		const database = testDatabase();
		const existing = await addTestUser(database, {
			email: 'root@example.com',
			role: 'member',
			password: 'the member own password'
		});
		const log: string[] = [];
		await prepareFirstRun(
			database,
			{ ...FIRST_ADMIN, password: 'a different password' },
			printedKeeper().keeper,
			(line) => log.push(line),
			NOW
		);
		expect(database.select().from(users).all()).toEqual([existing]);
		expect(listAudit(database, 10)).toEqual([]);
		expect(log).toEqual([
			'BMuster: BMUSTER_ADMIN_EMAIL and BMUSTER_ADMIN_PASSWORD are set, but this server already has users, so they were ignored. Remove these variables.'
		]);
	});

	it('stops start-up when the variables are not usable', async () => {
		const database = testDatabase();
		await expect(
			prepareFirstRun(
				database,
				{ ...FIRST_ADMIN, password: 'short' },
				printedKeeper().keeper,
				() => undefined,
				NOW
			)
		).rejects.toThrow('BMUSTER_ADMIN_PASSWORD: Use at least 12 characters.');
		expect(hasUsers(database)).toBe(false);
	});
});
