import { afterEach, describe, expect, it } from 'vitest';
import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { agentLogPageSchema, serverLogPageSchema } from '#lib/schemas/logs/logs.ts';
import { database } from '#lib/server/database/app-database.ts';
import { machineInventory, serverLogRecords } from '#lib/server/database/schema.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { createDiagnosticsToken } from '#lib/server/services/auth/diagnostics-tokens.ts';
import { resetLogRates, storeLogBatch } from '#lib/server/services/logs/agent-logs.ts';
import { enrolFakeAgent, SAMPLE_INVENTORY } from '#tests/helpers/fake-agent.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { GET as machinesGet } from './machines/+server.ts';
import { GET as logsGet } from './machines/[id]/logs/+server.ts';
import { GET as reportGet } from './machines/[id]/report/+server.ts';
import { GET as serverLogsGet } from './server/logs/+server.ts';
import { GET as checksGet } from './machines/[id]/checks/+server.ts';
import { GET as sessionsGet } from './machines/[id]/sessions/+server.ts';
import { POST as runChecksPost } from '../machines/[id]/checks/+server.ts';
import { machineChecksSchema, machineSessionsSchema } from '#lib/schemas/logs/checks.ts';
import { recordAudit } from '#lib/server/services/audit/audit.ts';
import { storeCheckResults } from '#lib/server/services/logs/machine-checks.ts';

const INSTANCE = '22222222-2222-4222-8222-222222222222';
const now = Date.now();

async function setUp() {
	const admin = await addTestUser(database, {
		email: `api-${crypto.randomUUID()}@example.com`,
		role: 'admin',
		password: null
	});
	const { token } = createDiagnosticsToken(
		database,
		{ name: 'api test', days: 1, userId: admin.id },
		now
	);
	const machineId = enrolFakeAgent(database, now).machineId;
	const records = [
		{ level: 'info', source: 'agent', text: 'Live socket connected.' },
		{ level: 'debug', source: 'agent', text: 'verbose detail' },
		{ level: 'warn', source: 'helper', text: 'pipewiresrc: no stream' },
		{ level: 'info', source: 'journal', text: 'bmuster-terminal-1.service: exit 208' },
		{ level: 'error', source: 'agent', text: 'Session failed: secret detail' }
	] as const;
	storeLogBatch(
		database,
		machineId,
		{
			type: 'log-batch',
			instance: INSTANCE,
			records: records.map((record, index) => ({
				seq: index + 1,
				at: now - 50_000 + index * 10_000,
				target: record.source === 'helper' ? 'wayland-helper' : 'bmuster_agent::sessions',
				...record
			}))
		},
		now
	);
	return { admin, token, machineId };
}

type Params = Record<string, string>;

function request(path: string, token: string, params: Params): RequestEvent {
	const url = new URL(`https://bmuster.test${path}`);
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request' | 'params'> = {
		locals: { session: { kind: 'none' } },
		url,
		request: new Request(url, { headers: { authorization: `Bearer ${token}` } }),
		params
	};
	return partial as RequestEvent;
}

async function logs(token: string, machineId: string, query: string) {
	const event = request(`/api/diagnostics/machines/${machineId}/logs${query}`, token, {
		id: machineId
	});
	const response = await logsGet(event as Parameters<typeof logsGet>[0]);
	return {
		status: response.status,
		cache: response.headers.get('cache-control'),
		json: (await response.json()) as unknown
	};
}

async function page(token: string, machineId: string, query: string) {
	const { status, cache, json } = await logs(token, machineId, query);
	expect(status).toBe(200);
	expect(cache).toBe('no-store');
	return agentLogPageSchema.parse(json);
}

describe('diagnostics endpoints (SPEC-AGENT-LOGS AL11)', () => {
	afterEach(() => {
		resetLogRates();
	});

	it('AL11: machine logs filter by level, source and time, newest first', async () => {
		const { token, machineId } = await setUp();
		const all = await page(token, machineId, '');
		expect(all.records.map((record) => record.seq)).toEqual([5, 4, 3, 2, 1]);
		const warn = await page(token, machineId, '?level=warn');
		expect(warn.records.map((record) => record.level)).toEqual(['error', 'warn']);
		const info = await page(token, machineId, '?level=info');
		expect(info.records.map((record) => record.seq)).toEqual([5, 4, 3, 1]);
		const journal = await page(token, machineId, '?source=journal');
		expect(journal.records.map((record) => record.text)).toEqual([
			'bmuster-terminal-1.service: exit 208'
		]);
		const since = new Date(now - 30_000).toISOString();
		const until = new Date(now - 15_000).toISOString();
		const window = await page(token, machineId, `?since=${since}&until=${until}`);
		expect(window.records.map((record) => record.seq)).toEqual([4, 3]);
		expect((await logs(token, machineId, '?level=loud')).status).toBe(400);
		expect((await logs(token, machineId, '?cursor=made-up')).status).toBe(400);
	});

	it('AL11: pages back with a cursor and follows newer records, late backlog included', async () => {
		const { token, machineId } = await setUp();
		const first = await page(token, machineId, '?limit=2');
		expect(first.records.map((record) => record.seq)).toEqual([5, 4]);
		if (first.older.kind !== 'cursor') throw new Error('expected more');
		const second = await page(token, machineId, `?limit=2&cursor=${first.older.cursor}`);
		expect(second.records.map((record) => record.seq)).toEqual([3, 2]);
		if (second.older.kind !== 'cursor') throw new Error('expected more');
		const third = await page(token, machineId, `?limit=2&cursor=${second.older.cursor}`);
		expect(third.records.map((record) => record.seq)).toEqual([1]);
		expect(third.older).toEqual({ kind: 'none' });

		// A backlog from an earlier agent process arrives later, with older times.
		storeLogBatch(
			database,
			machineId,
			{
				type: 'log-batch',
				instance: '33333333-3333-4333-8333-333333333333',
				records: [
					{
						seq: 1,
						at: now - 3_600_000,
						level: 'warn',
						source: 'agent',
						target: 'bmuster_agent::worker',
						text: 'from before the restart'
					}
				]
			},
			now
		);
		const followed = await page(token, machineId, `?cursor=${first.newer}`);
		expect(followed.records.map((record) => record.text)).toEqual(['from before the restart']);
		const idle = await page(token, machineId, `?cursor=${followed.newer}`);
		expect(idle.records).toEqual([]);
		expect(idle.newer).toBe(followed.newer);
	});

	it('AL17: reads from since forward, oldest first, paging on with a later cursor', async () => {
		const { token, machineId } = await setUp();
		// An outage: 300 identical warnings in the last hour, after the records that matter.
		storeLogBatch(
			database,
			machineId,
			{
				type: 'log-batch',
				instance: '55555555-5555-4555-8555-555555555555',
				records: Array.from({ length: 300 }, (_, index) => ({
					seq: index + 1,
					at: now - 5_000 + index * 10,
					level: 'warn' as const,
					source: 'agent' as const,
					target: 'bmuster_agent::socket',
					text: 'Live socket: HTTP 502 Bad Gateway from the server or its proxy'
				}))
			},
			now
		);
		const since = new Date(now - 60_000).toISOString();
		const first = await page(token, machineId, `?since=${since}&order=oldest&limit=3`);
		expect(first.records.map((record) => record.text)).toEqual([
			'Live socket connected.',
			'verbose detail',
			'pipewiresrc: no stream'
		]);
		expect(first.older).toEqual({ kind: 'none' });
		if (first.later.kind !== 'cursor') throw new Error('expected more');
		expect(first.later.cursor).toMatch(/^a-\d+-\d+$/);

		const texts: string[] = first.records.map((record) => record.text);
		let cursor: string = first.later.cursor;
		for (;;) {
			const next = await page(token, machineId, `?since=${since}&limit=100&cursor=${cursor}`);
			texts.push(...next.records.map((record) => record.text));
			if (next.later.kind === 'none') break;
			cursor = next.later.cursor;
		}
		expect(texts).toHaveLength(305);
		expect(texts[4]).toBe('Session failed: secret detail');
		expect(texts.filter((text) => text.startsWith('Live socket: HTTP 502'))).toHaveLength(300);

		// Newest first is still the default, and pages back past the outage to the start.
		const newest = await page(token, machineId, '?limit=200');
		expect(newest.later).toEqual({ kind: 'none' });
		if (newest.older.kind !== 'cursor') throw new Error('expected more');
		const back = await page(token, machineId, `?limit=200&cursor=${newest.older.cursor}`);
		expect(back.records.map((record) => record.text).slice(-5)).toEqual([
			'Session failed: secret detail',
			'bmuster-terminal-1.service: exit 208',
			'pipewiresrc: no stream',
			'verbose detail',
			'Live socket connected.'
		]);
		expect(back.older).toEqual({ kind: 'none' });
		expect((await logs(token, machineId, '?order=sideways')).status).toBe(400);
	});

	it('AL17: the server log reads oldest first from since too', async () => {
		const { token } = await setUp();
		const instance = crypto.randomUUID();
		database
			.insert(serverLogRecords)
			.values(
				[1, 2, 3].map((seq) => ({
					instance,
					seq,
					at: new Date(now - 10_000 + seq * 1000),
					level: 'info' as const,
					area: 'paging',
					machineId: null,
					text: `server ${seq}`
				}))
			)
			.run();
		const read = async (query: string) => {
			const response = await serverLogsGet(
				request(
					`/api/diagnostics/server/logs?area=paging&limit=2${query}`,
					token,
					{}
				) as Parameters<typeof serverLogsGet>[0]
			);
			return serverLogPageSchema.parse(await response.json());
		};
		const since = new Date(now - 60_000).toISOString();
		const first = await read(`&since=${since}&order=oldest`);
		expect(first.records.map((record) => record.text)).toEqual(['server 1', 'server 2']);
		expect(first.older).toEqual({ kind: 'none' });
		if (first.later.kind !== 'cursor') throw new Error('expected more');
		const second = await read(`&since=${since}&cursor=${first.later.cursor}`);
		expect(second.records.map((record) => record.text)).toEqual(['server 3']);
		expect(second.later).toEqual({ kind: 'none' });
	});

	it('AL11: caps the limit at 2000', async () => {
		const { token, machineId } = await setUp();
		for (let batch = 0; batch < 5; batch += 1) {
			storeLogBatch(
				database,
				machineId,
				{
					type: 'log-batch',
					instance: '44444444-4444-4444-8444-444444444444',
					records: Array.from({ length: 500 }, (_, index) => ({
						seq: batch * 500 + index + 1,
						at: now - 100_000,
						level: 'info' as const,
						source: 'agent' as const,
						target: 't',
						text: 'bulk'
					}))
				},
				now
			);
		}
		const capped = await page(token, machineId, '?limit=50000');
		expect(capped.records).toHaveLength(2000);
		expect(capped.older.kind).toBe('cursor');
	});

	it('AL11: audits reads with source, filter and count, never contents; following is not audited', async () => {
		const { admin, token, machineId } = await setUp();
		const read = await page(token, machineId, '?level=warn&source=agent');
		await page(token, machineId, `?cursor=${read.newer}`);
		const mine = listAudit(database, 50).filter(
			(entry) => entry.kind === 'agent-logs-viewed' && entry.actorUserId === admin.id
		);
		expect(mine).toHaveLength(1);
		expect(mine[0]?.detail).toEqual({
			source: 'agent',
			level: 'warn',
			since: 'any',
			until: 'any',
			order: 'newest',
			records: '1',
			via: 'token api test'
		});
		expect(JSON.stringify(mine)).not.toContain('secret detail');
		const missing = await logs(token, crypto.randomUUID(), '').catch((error: unknown) => error);
		expect(isHttpError(missing, 404)).toBe(true);
	});

	it('AL11: lists machines, reports one, and reads the server log by area', async () => {
		const { token, machineId } = await setUp();
		database
			.insert(machineInventory)
			.values({
				machineId,
				hash: 'a'.repeat(64),
				data: JSON.stringify(SAMPLE_INVENTORY),
				updatedAt: new Date(now)
			})
			.run();
		const listed = await machinesGet(
			request('/api/diagnostics/machines', token, {}) as Parameters<typeof machinesGet>[0]
		);
		expect(JSON.stringify(await listed.json())).toContain(`"id":"${machineId}"`);
		const report = await reportGet(
			request(`/api/diagnostics/machines/${machineId}/report`, token, {
				id: machineId
			}) as Parameters<typeof reportGet>[0]
		);
		expect(await report.json()).toMatchObject({
			machine: { id: machineId, inventory: { display: { kind: 'linux' } } },
			inventory: { display: { kind: 'linux', seat: { sessionType: 'wayland' } } },
			verboseUntilIso: null
		});

		const instance = crypto.randomUUID();
		database
			.insert(serverLogRecords)
			.values([
				{
					instance,
					seq: 1,
					at: new Date(now),
					level: 'info',
					area: 'agents',
					machineId,
					text: 'a'
				},
				{
					instance,
					seq: 2,
					at: new Date(now),
					level: 'warn',
					area: 'relay',
					machineId: null,
					text: 'b'
				}
			])
			.run();
		const server = await serverLogsGet(
			request('/api/diagnostics/server/logs?area=relay', token, {}) as Parameters<
				typeof serverLogsGet
			>[0]
		);
		const parsed = serverLogPageSchema.parse(await server.json());
		expect(parsed.records.map((record) => record.text)).toEqual(['b']);
		expect(
			listAudit(database, 5).find((entry) => entry.kind === 'server-logs-viewed')
		).toMatchObject({ detail: { area: 'relay', records: '1', via: 'token api test' } });
	});

	it('D9: tokens read the latest check results but can never run checks', async () => {
		const { token, machineId } = await setUp();
		const read = async () =>
			machineChecksSchema.parse(
				await (
					await checksGet(
						request(`/api/diagnostics/machines/${machineId}/checks`, token, {
							id: machineId
						}) as Parameters<typeof checksGet>[0]
					)
				).json()
			);
		expect(await read()).toEqual({ kind: 'unreported' });
		storeCheckResults(
			database,
			machineId,
			[
				{
					id: 'terminal-pty',
					title: 'Terminal on a pty',
					status: 'fail',
					detail: 'Failed to set up standard input: Permission denied',
					durationMs: 40,
					checkedAt: now
				}
			],
			now
		);
		expect(await read()).toMatchObject({
			kind: 'results',
			results: [{ id: 'terminal-pty', status: 'fail' }]
		});

		const url = `https://bmuster.test/api/machines/${machineId}/checks`;
		const partial: Pick<RequestEvent, 'locals' | 'url' | 'request' | 'params'> = {
			locals: { session: { kind: 'none' } },
			url: new URL(url),
			request: new Request(url, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` }
			}),
			params: { id: machineId }
		};
		const refused = await Promise.resolve()
			.then(() => runChecksPost(partial as Parameters<typeof runChecksPost>[0]))
			.catch((error: unknown) => error);
		expect(
			refused instanceof Response ? refused.status : isHttpError(refused) ? refused.status : 0
		).toBeGreaterThanOrEqual(400);
		expect(listAudit(database, 20).some((entry) => entry.kind === 'agent-checks-requested')).toBe(
			false
		);
	});

	it('D9: sessions join the server entries to the shipped timeline and figures, audited', async () => {
		const { admin, token, machineId } = await setUp();
		const sessionId = crypto.randomUUID();
		const detail = { type: 'desktop', mode: 'control', session: sessionId };
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: admin.id },
				kind: 'session-opened',
				target: 'Test machine',
				machineId,
				detail
			},
			now - 40_000
		);
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: admin.id },
				kind: 'session-ended',
				target: 'Test machine',
				machineId,
				detail: { ...detail, ended: 'Closed by the viewer' }
			},
			now - 5_000
		);
		const failedId = crypto.randomUUID();
		const timeline = (id: string, kind: string, outcome: string) =>
			JSON.stringify({
				sessionId: id,
				kind,
				startedAt: now - 40_000,
				outcome,
				reason: outcome === 'failed' ? 'exit 208' : 'closed',
				steps: [
					{ t: 0, step: 'ticket-checked', detail: '' },
					{ t: 120, step: 'unit-started', detail: 'bmuster-terminal-1.service' }
				],
				omitted: 0
			});
		storeLogBatch(
			database,
			machineId,
			{
				type: 'log-batch',
				instance: '55555555-5555-4555-8555-555555555555',
				records: [
					{ target: 'session-timeline', text: timeline(sessionId, 'desktop', 'ended') },
					{
						target: 'session-stats',
						text: JSON.stringify({
							sessionId,
							intervalMs: 30_000,
							framesSent: 600,
							captureMsAvg: 4.5,
							encodeMsAvg: 7.25,
							bytesPerSecond: 250_000,
							droppedFrames: 3,
							tiles: 9000,
							backend: 'kms'
						})
					},
					{ target: 'session-timeline', text: timeline(failedId, 'terminal', 'failed') },
					{ target: 'session-timeline', text: '[redacted diagnostic line]' }
				].map((record, index) => ({
					seq: index + 1,
					at: now - 4_000 + index,
					level: 'info' as const,
					source: 'agent' as const,
					...record
				}))
			},
			now
		);
		const response = await sessionsGet(
			request(`/api/diagnostics/machines/${machineId}/sessions?limit=10`, token, {
				id: machineId
			}) as Parameters<typeof sessionsGet>[0]
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const { sessions } = machineSessionsSchema.parse(await response.json());
		expect(sessions).toHaveLength(2);
		const desktop = sessions.find((session) => session.sessionId === sessionId);
		expect(desktop).toMatchObject({
			kind: 'desktop',
			server: {
				kind: 'known',
				userName: admin.name,
				ended: { kind: 'ended', how: 'Closed by the viewer' }
			},
			timeline: { kind: 'shipped', outcome: 'ended' },
			stats: [{ backend: 'kms', framesSent: 600 }]
		});
		expect(sessions.find((session) => session.sessionId === failedId)).toMatchObject({
			kind: 'terminal',
			server: { kind: 'unknown' },
			timeline: { kind: 'shipped', outcome: 'failed', reason: 'exit 208' },
			stats: []
		});
		expect(
			listAudit(database, 5).find((entry) => entry.kind === 'agent-sessions-viewed')
		).toMatchObject({ detail: { sessions: '2', via: 'token api test' } });
	});
});
