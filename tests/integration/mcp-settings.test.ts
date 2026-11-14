import { describe, expect, it } from 'vitest';
import { database } from '#lib/server/database/app-database.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { createGroup } from '#lib/server/services/access/groups.ts';
import { saveMcpSettings } from '#lib/server/services/oauth/grants.ts';
import { readMcpSettings } from '#lib/server/services/oauth/mcp-settings.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { done } from '#tests/helpers/access.ts';
import { invoke, thrown, type EventOptions } from '#tests/helpers/mcp.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { GET as protectedResource } from '../../src/routes/.well-known/oauth-protected-resource/mcp/+server.ts';
import { GET as authorizationServer } from '../../src/routes/.well-known/oauth-authorization-server/+server.ts';
import {
	DELETE as mcpDelete,
	GET as mcpGet,
	POST as mcpPost
} from '../../src/routes/mcp/+server.ts';
import { load } from '../../src/routes/oauth/authorize/+page.server.ts';
import { POST as register } from '../../src/routes/oauth/register/+server.ts';
import { POST as revoke } from '../../src/routes/oauth/revoke/+server.ts';
import { POST as token } from '../../src/routes/oauth/token/+server.ts';

/** SPEC-MCP M1: off on a new server, invisible while off, and never on without a connect group. */

const NONE = { kind: 'none' } as const;

function plain(method: EventOptions['method']): EventOptions {
	return {
		method,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: method === 'GET' || method === 'DELETE' ? null : 'grant_type=refresh_token',
		session: NONE,
		address: '203.0.113.5'
	};
}

describe('Allow AI assistants (SPEC-MCP M1)', () => {
	it('M1: is off on a new server, and every MCP path answers 404 while it is off', async () => {
		expect(readMcpSettings(database)).toEqual({ enabled: false, userGroupId: null });
		const answers = await Promise.all([
			invoke(protectedResource, '/.well-known/oauth-protected-resource/mcp', plain('GET'), {}),
			invoke(authorizationServer, '/.well-known/oauth-authorization-server', plain('GET'), {}),
			invoke(token, '/oauth/token', plain('POST'), {}),
			invoke(register, '/oauth/register', plain('POST'), {}),
			invoke(revoke, '/oauth/revoke', plain('POST'), {}),
			invoke(mcpPost, '/mcp', plain('POST'), {}),
			invoke(mcpGet, '/mcp', plain('GET'), {}),
			invoke(mcpDelete, '/mcp', plain('DELETE'), {})
		]);
		expect(answers.map((answer) => answer.status)).toEqual([
			404, 404, 404, 404, 404, 404, 404, 404
		]);
		// The consent screen too, before it would ask anyone to sign in.
		expect(
			await thrown(() => invoke(load, '/oauth/authorize?client_id=x', plain('GET'), {}))
		).toEqual({
			kind: 'error',
			status: 404
		});
	});

	it('M1: cannot be turned on without the group of people who may connect', async () => {
		const admin = toConsoleUser(
			await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
		);
		expect(
			saveMcpSettings(database, admin.id, { enabled: true, userGroupId: null }, NOW)
		).toMatchObject({ kind: 'refused' });
		expect(
			saveMcpSettings(database, admin.id, { enabled: true, userGroupId: crypto.randomUUID() }, NOW)
		).toMatchObject({ kind: 'refused' });
		expect(readMcpSettings(database).enabled).toBe(false);
		const groupId = done(
			createGroup(database, 'user', admin.id, { name: 'AI people', description: '' }, NOW)
		);
		expect(
			saveMcpSettings(database, admin.id, { enabled: true, userGroupId: groupId }, NOW)
		).toMatchObject({ kind: 'changed', settings: { enabled: true, userGroupId: groupId } });
		expect(
			listAudit(database, 3)
				.filter((entry) => entry.kind === 'setting-changed')
				.map((entry) => entry.target)
				.sort()
		).toEqual(['Allow AI assistants (MCP)', 'People who may connect an AI assistant']);
		const metadata = await invoke(
			authorizationServer,
			'/.well-known/oauth-authorization-server',
			plain('GET'),
			{}
		);
		expect(metadata.status).toBe(200);
	});
});
