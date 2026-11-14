import { beforeAll, describe, expect, it } from 'vitest';
import { database } from '#lib/server/database/app-database.ts';
import { isBearerPath } from '#lib/server/guards/bearer-paths.ts';
import { route } from '#lib/server/guards/route.ts';
import { isCrossOriginWrite } from '#lib/server/hooks/origin-check.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { connectAssistant, enableMcp, invoke, ORIGIN, rpcReply } from '#tests/helpers/mcp.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { GET as diagnosticsMachines } from '../../src/routes/api/diagnostics/machines/+server.ts';
import { GET as mcpGet, POST as mcpPost } from '../../src/routes/mcp/+server.ts';

/**
 * SPEC-MCP M4: /mcp takes a bearer token and nothing else; the console cookie is not read there,
 * and an MCP token opens no other route.
 */

const ADDRESS = '203.0.113.30';
let admin: ReturnType<typeof toConsoleUser>;
let accessToken: string;

beforeAll(async () => {
	admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	enableMcp(database, admin.id, [admin.id]);
	accessToken = (await connectAssistant(database, admin.id, 'claude-code', Date.now())).accessToken;
});

const INITIALIZE = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-11-25',
		capabilities: {},
		clientInfo: { name: 'bmuster-test', version: '1' }
	}
});

async function post(headers: Record<string, string>, signedIn: boolean): Promise<Response> {
	return await invoke(
		mcpPost,
		'/mcp',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				...headers
			},
			body: INITIALIZE,
			session: signedIn ? { kind: 'signed-in', user: admin } : { kind: 'none' },
			address: ADDRESS
		},
		{}
	);
}

describe('the MCP endpoint (SPEC-MCP M4)', () => {
	it('M4: a missing or bad token gets 401 with the discovery challenge, signed-in console or not', async () => {
		for (const headers of [
			{},
			{ authorization: 'Bearer bmat_wrong' },
			{ authorization: 'Basic eDp5' }
		]) {
			const answer = await post(headers, true);
			expect(answer.status).toBe(401);
			expect(answer.headers.get('www-authenticate')).toContain(
				`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
			);
			expect(answer.headers.get('www-authenticate')).toContain(
				'scope="machines:read commands:run offline_access"'
			);
		}
	});

	it('M4: a live token is served, over the 2025-11-25 handshake', async () => {
		const answer = await post({ authorization: `Bearer ${accessToken}` }, false);
		expect(answer.status).toBe(200);
		expect(await rpcReply(answer)).toMatchObject({
			result: { protocolVersion: '2025-11-25', serverInfo: { name: 'BMuster' } }
		});
	});

	it('M4: a page on another site is refused; GET answers 405', async () => {
		const foreign = await post(
			{ authorization: `Bearer ${accessToken}`, origin: 'https://evil.example' },
			false
		);
		expect(foreign.status).toBe(403);
		const same = await post({ authorization: `Bearer ${accessToken}`, origin: ORIGIN }, false);
		expect(same.status).toBe(200);
		const listening = await invoke(
			mcpGet,
			'/mcp',
			{
				method: 'GET',
				headers: { authorization: `Bearer ${accessToken}` },
				body: null,
				session: { kind: 'none' },
				address: ADDRESS
			},
			{}
		);
		expect(listening.status).toBe(405);
	});

	it('M4: the console cookie is not read on /mcp, and the origin hook leaves it to its guard', () => {
		expect(isBearerPath('/mcp')).toBe(true);
		expect(isBearerPath('/oauth/token')).toBe(true);
		expect(isBearerPath('/oauth/authorize')).toBe(false);
		expect(
			isCrossOriginWrite(
				new Request(`${ORIGIN}/oauth/authorize`, { method: 'POST' }),
				new URL(`${ORIGIN}/oauth/authorize`)
			)
		).toBe(true);
	});

	it('M4: an MCP token is refused on every other route', async () => {
		const options = {
			method: 'GET' as const,
			headers: { authorization: `Bearer ${accessToken}` },
			body: null,
			session: { kind: 'none' as const },
			address: ADDRESS
		};
		const user = route.user(() => Response.json({ ok: true }));
		expect((await invoke(user, '/api/anything', options, {})).status).toBe(401);
		expect(
			(await invoke(diagnosticsMachines, '/api/diagnostics/machines', options, {})).status
		).toBe(401);
	});
});
