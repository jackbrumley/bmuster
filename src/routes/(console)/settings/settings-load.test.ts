import { describe, expect, it } from 'vitest';
import { database } from '#lib/server/database/app-database.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { registerServedCertificate } from '#lib/server/tls/served-certificate.ts';
import { invoke, thrown } from '#tests/helpers/mcp.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { load } from './+page.server.ts';

async function signedIn(role: 'admin' | 'member') {
	const user = toConsoleUser(
		await addTestUser(database, {
			email: `recovery-${role}-${crypto.randomUUID()}@example.com`,
			role,
			password: null
		})
	);
	return {
		method: 'GET' as const,
		headers: {},
		body: null,
		session: { kind: 'signed-in' as const, user },
		address: '203.0.113.9'
	};
}

describe('the Settings page load and its Recovery panel (SPEC-SERVER-INSTALL I17)', () => {
	it('I17: members cannot see it (403)', async () => {
		const as = await signedIn('member');
		expect(await thrown(() => invoke(load, '/settings', as, {}))).toEqual({
			kind: 'error',
			status: 403
		});
	});

	it("I17: admins get this server's recovery facts, with their own email in the commands", async () => {
		registerServedCertificate({ kind: 'plain' });
		const as = await signedIn('admin');
		const shown = await thrown(() => invoke(load, '/settings', as, {}));
		if (shown.kind !== 'returned') throw new Error(JSON.stringify(shown));
		expect(shown.value).toMatchObject({
			recovery: {
				deployment: 'source',
				secrets: { kind: 'dotenv-or-environment' },
				commands: {
					resetPassword: `npm run admin:reset -- --email ${as.session.user.email}`
				}
			}
		});
	});
});
