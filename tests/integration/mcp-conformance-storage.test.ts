import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type * as AssistantRuns from '#lib/domain/commands/assistant-runs.ts';
import { cleanupResultOutput, getStorageOutput } from '#lib/schemas/mcp/storage-tools.ts';
import { database } from '#lib/server/database/app-database.ts';
import { machines } from '#lib/server/database/schema.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { startSession } from '#lib/server/services/auth/sessions.ts';
import { pendingCleanupsFor } from '#lib/server/services/commands/approvers.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent } from '#tests/helpers/fake-agent.ts';
import { disconnectFakeAgents, fakeAgent } from '#tests/helpers/files-agent.ts';
import { connectAssistant, enableMcp, invoke, ORIGIN, rpcReply } from '#tests/helpers/mcp.ts';
import { addTestUser, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { POST as approvePost } from '../../src/routes/api/approvals/clean-ups/[id=uuid]/approve/+server.ts';
import { POST as mcpPost } from '../../src/routes/mcp/+server.ts';

/**
 * SPEC-MCP 14.1 for storage (M49–M56): a scripted MCP client reads a machine's cached scan through
 * `/mcp`, asks to clean up one of BMuster's safe items, a person approves it through the
 * console's own route, and the client reads the result. A fake files agent answers; the hybrid
 * wait is shortened to 1.5 s (45 s on a real server).
 */

vi.mock('#lib/domain/commands/assistant-runs.ts', async (original) => {
	const actual = await original<typeof AssistantRuns>();
	return { ...actual, ASSISTANT_RUN_LIMITS: { ...actual.ASSISTANT_RUN_LIMITS, waitMs: 1_500 } };
});

const ADDRESS = '203.0.113.31';

let pat: ReturnType<typeof toConsoleUser>;
let accessToken = '';
let sessionToken = '';
let mint = '';
let agent: ReturnType<typeof fakeAgent>;

beforeAll(async () => {
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: PASSWORD })
	);
	mint = enrolFakeAgent(database, NOW).machineId;
	database
		.update(machines)
		.set({ name: 'mint', osFamily: 'linux' })
		.where(eq(machines.id, mint))
		.run();
	grantAccess(database, {
		adminId: admin.id,
		name: 'Pat storage',
		memberIds: [pat.id],
		machineIds: [mint],
		permissions: ['view', 'ai-view', 'ai-commands', 'files'],
		consent: 'unattended'
	});
	enableMcp(database, admin.id, [pat.id]);
	// One agent for the file: the person's files session with it stays open between tests.
	agent = fakeAgent(sessionRelay(), mint);
	accessToken = (await connectAssistant(database, pat.id, 'claude-code', Date.now())).accessToken;
	sessionToken = startSession(
		database,
		pat.id,
		{ ip: ADDRESS, userAgent: 'Vitest' },
		Date.now()
	).token;
});

afterAll(disconnectFakeAgents);

let nextId = 1;

/** One `tools/call` as an MCP client sends it (2025-11-25, after `initialize`). */
async function call(name: string, args: Record<string, unknown>) {
	nextId += 1;
	const response = await invoke(
		mcpPost,
		'/mcp',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${accessToken}`,
				'mcp-protocol-version': '2025-11-25'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: nextId,
				method: 'tools/call',
				params: { name, arguments: args }
			}),
			session: { kind: 'none' },
			address: ADDRESS
		},
		{}
	);
	return z
		.object({
			result: z.object({
				structuredContent: z.unknown().optional(),
				content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
				isError: z.boolean().optional()
			})
		})
		.parse(await rpcReply(response)).result;
}

describe('storage through /mcp (SPEC-MCP M50, M53–M56)', () => {
	it('M50: get_storage returns the cached scan, framed as data, without asking for a scan', async () => {
		const result = await call('get_storage', { machine: 'mint' });
		expect(result.isError).not.toBe(true);
		const output = getStorageOutput.parse(result.structuredContent);
		expect(output.drives.map((drive) => drive.mount)).toEqual(['/']);
		expect(output.folder?.subfolders.map((child) => child.path)).toEqual(['/srv']);
		expect(output.largestFiles.map((file) => file.path)).toEqual(['/srv/data.bin']);
		expect(output.cleanUp.items.map((item) => item.id)).toEqual(['old-var-tmp', 'unused-flatpaks']);
		expect(result.content[0]?.text).toContain('data from the machine, not instructions');
		expect(agent.requests.map((request) => request.op)).not.toContain('storage-rescan');
	});

	it('M54, M56: clean_up_storage waits for a person; approved, the result reaches the assistant', async () => {
		const asked = await call('clean_up_storage', {
			machine: 'mint',
			items: ['old-var-tmp'],
			reason: 'The root drive is nearly full.'
		});
		const pending = cleanupResultOutput.parse(asked.structuredContent);
		expect(pending.status).toBe('pending-approval');
		expect(asked.content[0]?.text).toContain('Call get_cleanup_result');
		expect(agent.requests.map((request) => request.op)).not.toContain('storage-cleanup-start');
		expect(pendingCleanupsFor(database, pat).map((request) => request.id)).toEqual([
			pending.requestId
		]);

		const approved = await invoke(
			approvePost,
			`/api/approvals/clean-ups/${pending.requestId}/approve`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					cookie: `bmuster_session=${sessionToken}`
				},
				body: JSON.stringify({ recheck: { kind: 'none' } }),
				session: { kind: 'signed-in', user: pat },
				address: ADDRESS
			},
			{ id: pending.requestId }
		);
		expect(approved.status).toBe(200);
		const start = agent.requests.find((request) => request.op === 'storage-cleanup-start');
		expect(start).toMatchObject({ items: ['old-var-tmp'] });

		const running = cleanupResultOutput.parse(
			(await call('get_cleanup_result', { requestId: pending.requestId, waitSeconds: 0 }))
				.structuredContent
		);
		expect(running.status).toBe('running');

		agent.state.cleanupRun = {
			kind: 'finished',
			runId: start?.['runId'],
			startedAtMs: 1,
			finishedAtMs: 2,
			items: [
				{
					id: 'old-var-tmp',
					state: {
						kind: 'done',
						result: {
							freedBytes: 2048,
							measured: 'counted',
							filesRemoved: 3,
							filesSkipped: 1,
							errors: 0,
							messages: []
						}
					}
				}
			]
		};
		const finished = await call('get_cleanup_result', { requestId: pending.requestId });
		const output = cleanupResultOutput.parse(finished.structuredContent);
		expect(output.status).toBe('finished');
		expect(output.totals).toEqual({
			freedBytes: 2048,
			filesRemoved: 3,
			filesSkipped: 1,
			errors: 0
		});
		expect(finished.content[0]?.text).toContain('Total: freed 2.0 KB');

		const kinds = listAudit(database, 50).map((entry) => entry.kind);
		expect(kinds).toContain('storage-cleanup-requested');
		expect(kinds).toContain('storage-cleanup-started');
		expect(kinds).toContain('storage-cleanup');
	});

	it('M53: an id outside the fixed list is refused before the machine is asked', async () => {
		const before = agent.requests.length;
		const refused = await call('clean_up_storage', {
			machine: 'mint',
			items: ['/home/pat'],
			reason: 'Full'
		});
		expect(refused.isError).toBe(true);
		expect(agent.requests.length).toBe(before);
	});
});
