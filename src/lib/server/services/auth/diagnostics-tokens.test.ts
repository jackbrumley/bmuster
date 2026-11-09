import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diagnosticsTokens } from '#lib/server/database/schema.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { disableUser, setRole } from '../users/users.ts';
import {
	authenticateDiagnosticsToken,
	createDiagnosticsToken,
	listDiagnosticsTokens,
	revokeDiagnosticsToken
} from './diagnostics-tokens.ts';

const DAY = 24 * 60 * 60 * 1000;

async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const other = await addTestUser(database, {
		email: 'grace@example.com',
		role: 'admin',
		password: null
	});
	return { database, admin, other };
}

describe('diagnostics tokens (SPEC-AGENT-LOGS AL10)', () => {
	it('AL10: a token is shown once, stored only as its SHA-256 and audited when made', async () => {
		const { database, admin } = await setUp();
		const created = createDiagnosticsToken(
			database,
			{ name: 'Claude Code', days: 7, userId: admin.id },
			NOW
		);
		expect(created.token).toMatch(/^bmd_[A-Za-z0-9_-]{43}$/);
		expect(created.expiresAt).toEqual(new Date(NOW + 7 * DAY));
		const [row] = database.select().from(diagnosticsTokens).all();
		expect(row?.tokenHash).toBe(createHash('sha256').update(created.token).digest('hex'));
		expect(JSON.stringify(row)).not.toContain(created.token);
		expect(JSON.stringify(listDiagnosticsTokens(database, NOW))).not.toContain(created.token);
		expect(listDiagnosticsTokens(database, NOW)).toEqual([
			expect.objectContaining({ name: 'Claude Code', ownerName: 'ada', state: 'active' })
		]);
		const audit = listAudit(database, 10);
		expect(audit[0]).toMatchObject({ kind: 'diagnostics-token-created', target: 'Claude Code' });
		expect(JSON.stringify(audit)).not.toContain(created.token);
	});

	it('AL10: a token works until it expires', async () => {
		const { database, admin } = await setUp();
		const { token } = createDiagnosticsToken(
			database,
			{ name: 'one day', days: 1, userId: admin.id },
			NOW
		);
		expect(authenticateDiagnosticsToken(database, token, NOW + DAY - 1)).toMatchObject({
			kind: 'valid',
			user: { id: admin.id, role: 'admin' }
		});
		expect(authenticateDiagnosticsToken(database, token, NOW + DAY)).toEqual({ kind: 'invalid' });
		expect(listDiagnosticsTokens(database, NOW + DAY)[0]?.state).toBe('expired');
		expect(authenticateDiagnosticsToken(database, `${token}x`, NOW)).toEqual({ kind: 'invalid' });
		expect(authenticateDiagnosticsToken(database, 'bmd_guess', NOW)).toEqual({ kind: 'invalid' });
	});

	it('AL10: a revoked token stops at once, and revocation is audited', async () => {
		const { database, admin, other } = await setUp();
		const { id, token } = createDiagnosticsToken(
			database,
			{ name: 'laptop', days: 30, userId: admin.id },
			NOW
		);
		expect(revokeDiagnosticsToken(database, id, other.id, NOW + 1)).toBe('revoked');
		expect(revokeDiagnosticsToken(database, id, other.id, NOW + 2)).toBe('already-ended');
		expect(revokeDiagnosticsToken(database, crypto.randomUUID(), other.id, NOW)).toBe('not-found');
		expect(authenticateDiagnosticsToken(database, token, NOW + 3)).toEqual({ kind: 'invalid' });
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'diagnostics-token-revoked',
			actorUserId: other.id
		});
	});

	it('AL10: a token dies with its admin: disabled, or no longer an admin', async () => {
		const { database, admin, other } = await setUp();
		const first = createDiagnosticsToken(
			database,
			{ name: 'a', days: 90, userId: admin.id },
			NOW
		).token;
		const second = createDiagnosticsToken(
			database,
			{ name: 'b', days: 90, userId: other.id },
			NOW
		).token;
		expect(setRole(database, other.id, admin.id, 'member', NOW)).toMatchObject({ kind: 'done' });
		expect(authenticateDiagnosticsToken(database, first, NOW)).toEqual({ kind: 'invalid' });
		const third = await addTestUser(database, {
			email: 'third@example.com',
			role: 'admin',
			password: null
		});
		expect(disableUser(database, third.id, other.id, NOW)).toMatchObject({ kind: 'done' });
		expect(authenticateDiagnosticsToken(database, second, NOW)).toEqual({ kind: 'invalid' });
	});

	it('AL10: use is recorded each time and audited at most once an hour', async () => {
		const { database, admin } = await setUp();
		const { token } = createDiagnosticsToken(
			database,
			{ name: 'cli', days: 7, userId: admin.id },
			NOW
		);
		for (const at of [NOW + 1, NOW + 2, NOW + 60_000, NOW + 3_600_001]) {
			authenticateDiagnosticsToken(database, token, at);
		}
		const uses = listAudit(database, 20).filter((entry) => entry.kind === 'diagnostics-token-used');
		expect(uses).toHaveLength(2);
		expect(listDiagnosticsTokens(database, NOW)[0]?.lastUsed).toEqual({
			kind: 'used',
			atIso: new Date(NOW + 3_600_001).toISOString()
		});
	});
});
