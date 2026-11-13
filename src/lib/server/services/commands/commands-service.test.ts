import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import type { StartRunRequest } from '#lib/schemas/commands/commands.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW, PASSWORD } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { commandRunMachines, machines } from '../../database/schema.ts';
import { agentConnected, agentDisconnected, type LivePeer } from '../agents/live-agents.ts';
import { listAudit } from '../audit/audit.ts';
import { startSession } from '../auth/sessions.ts';
import { signInPause } from '../auth/sign-in-limits.ts';
import { createRelay, RELAY_LIMITS, type RelayPeer } from '../sessions/relay.ts';
import { toConsoleUser } from '../users/users.ts';
import { closeRunsCutByRestart, pruneCommandOutput } from './command-retention.ts';
import { createCommandRunner } from './command-runner.ts';
import { cancelRun, planRun, startRun, type CommandContext } from './commands.ts';
import { listRunsFor, runOutputFor, runViewFor } from './run-views.ts';

const SECRETS_KEY = Buffer.alloc(32, 3);
const MINUTE = 60_000;

const connected: { machineId: string; peer: LivePeer }[] = [];

afterEach(() => {
	for (const { machineId, peer } of connected.splice(0)) {
		agentDisconnected(machineId, peer);
	}
});

/** The parts of an exec ticket these tests read. */
const ticketSchema = z.object({
	sessionId: z.string(),
	machineId: z.string(),
	permissions: z.array(z.string()),
	user: z.object({ id: z.string(), name: z.string() }),
	purpose: z.object({
		kind: z.string(),
		shell: z.string(),
		command: z.string(),
		timeoutMs: z.number(),
		maxOutputBytes: z.number()
	})
});

type Ticket = z.infer<typeof ticketSchema>;

/** A live agent socket that keeps the tickets it is sent. */
function connect(machineId: string): Ticket[] {
	const tickets: Ticket[] = [];
	const peer: LivePeer = {
		send: (message: ServerSocketMessage) => {
			if (message.type === 'session-open') {
				tickets.push(
					ticketSchema.parse(JSON.parse(Buffer.from(message.ticket, 'base64').toString('utf8')))
				);
			}
		},
		close: () => undefined
	};
	agentConnected(machineId, peer);
	connected.push({ machineId, peer });
	return tickets;
}

function quietPeer(): RelayPeer {
	return {
		sendText: () => undefined,
		sendBytes: (_data, sent) => {
			sent();
		},
		pause: () => undefined,
		resume: () => undefined,
		close: () => undefined
	};
}

function enrol(
	database: AppDatabase,
	name: string,
	osFamily: 'linux' | 'windows' | 'macos',
	version = '0.4.26'
) {
	const machineId = enrolFakeAgent(database, NOW).machineId;
	database
		.update(machines)
		.set({ name, osFamily, agentVersion: version })
		.where(eq(machines.id, machineId))
		.run();
	return machineId;
}

async function setUp() {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: PASSWORD })
	);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	const relay = createRelay(RELAY_LIMITS);
	const clock = { now: NOW + MINUTE };
	const runner = createCommandRunner({
		database,
		relay,
		secretsKey: SECRETS_KEY,
		clock: () => clock.now
	});
	const adminToken = startSession(
		database,
		admin.id,
		{ ip: '192.0.2.1', userAgent: 'Vitest' },
		NOW
	).token;
	const patToken = startSession(
		database,
		pat.id,
		{ ip: '192.0.2.2', userAgent: 'Vitest' },
		NOW
	).token;
	const context = (who: 'admin' | 'pat', at = clock.now): CommandContext => ({
		database,
		runner,
		user: who === 'admin' ? admin : pat,
		sessionToken: who === 'admin' ? adminToken : patToken,
		ip: '192.0.2.1',
		now: at
	});
	return { database, admin, pat, relay, clock, runner, context };
}

function request(machineIds: string[], overrides: Partial<StartRunRequest> = {}): StartRunRequest {
	return {
		machineIds,
		scripts: [{ osFamily: 'linux', shell: 'sh', command: 'systemctl restart cups' }],
		timeoutMs: 60_000,
		confirmCount: machineIds.length,
		password: { kind: 'none' },
		rerunOf: null,
		...overrides
	};
}

/** The agent's side of one exec session: attach, send output frames, then the result. */
function agentAnswers(
	relay: ReturnType<typeof createRelay>,
	ticket: Ticket,
	result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
) {
	const peer = quietPeer();
	expect(relay.attachAgent(ticket.sessionId, ticket.machineId, peer)).toEqual({ kind: 'attached' });
	relay.fromAgent(
		ticket.sessionId,
		peer,
		Buffer.concat([Buffer.from([1]), Buffer.from(result.stdout)])
	);
	relay.fromAgent(
		ticket.sessionId,
		peer,
		Buffer.concat([Buffer.from([2]), Buffer.from(result.stderr)])
	);
	relay.agentText(
		ticket.sessionId,
		peer,
		JSON.stringify({
			type: 'exec-done',
			exitCode: result.exitCode,
			durationMs: 1200,
			truncated: false,
			timedOut: result.timedOut
		})
	);
}

function statuses(database: AppDatabase) {
	return Object.fromEntries(
		database
			.select({ machineId: commandRunMachines.machineId, status: commandRunMachines.status })
			.from(commandRunMachines)
			.all()
			.map((row) => [row.machineId, row.status])
	);
}

describe('recent sign-in (C10)', () => {
	it('C10: within 10 minutes of signing in a run starts; after that it needs the password', async () => {
		const { database, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		connect(office);
		expect(planRun(context('admin', NOW + 9 * MINUTE), [office])).toMatchObject({
			signIn: { kind: 'recent' }
		});
		expect(await startRun(context('admin', NOW + 9 * MINUTE), request([office]))).toMatchObject({
			kind: 'started'
		});

		const later = NOW + 11 * MINUTE;
		expect(planRun(context('admin', later), [office])).toMatchObject({
			signIn: { kind: 'password' }
		});
		expect(await startRun(context('admin', later), request([office]))).toEqual({
			kind: 'refused',
			status: 403,
			message: 'You signed in more than 10 minutes ago. Type your password to run it.'
		});
		const started = await startRun(
			context('admin', later),
			request([office], { password: { kind: 'given', password: PASSWORD } })
		);
		expect(started.kind).toBe('started');
		// The password check is fresh for the next 10 minutes.
		expect(planRun(context('admin', later + 9 * MINUTE), [office])).toMatchObject({
			signIn: { kind: 'recent' }
		});
		expect(listAudit(database, 50).some((entry) => entry.kind === 'password-confirmed')).toBe(true);
	});

	it('C10: a wrong password is refused and counts toward the sign-in pauses', async () => {
		const { database, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		connect(office);
		const later = NOW + 30 * MINUTE;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(
				await startRun(
					context('admin', later),
					request([office], { password: { kind: 'given', password: 'wrong' } })
				)
			).toMatchObject({ kind: 'refused', status: 403, message: 'That password is not right.' });
		}
		expect(
			signInPause(database, { email: 'ada@example.com', address: 'elsewhere' }, later).kind
		).toBe('paused');
		// Paused: even the right password waits, as at the sign-in page.
		expect(
			await startRun(
				context('admin', later),
				request([office], { password: { kind: 'given', password: PASSWORD } })
			)
		).toMatchObject({ kind: 'refused', status: 429 });
		const failures = listAudit(database, 50).filter((entry) => entry.kind === 'sign-in-failed');
		expect(failures.length).toBeGreaterThanOrEqual(5);
	});

	it('C10: someone who signs in only through a provider is asked to sign in again', async () => {
		const { database, admin, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		connect(office);
		grantAccess(database, {
			adminId: admin.id,
			name: 'Fleet',
			memberIds: [context('pat').user.id],
			machineIds: [office],
			permissions: ['view', 'run-commands'],
			consent: 'unattended'
		});
		const later = NOW + 11 * MINUTE;
		expect(planRun(context('pat', later), [office])).toMatchObject({
			signIn: { kind: 'sign-in-again' }
		});
		expect(
			await startRun(
				context('pat', later),
				request([office], { password: { kind: 'given', password: 'anything' } })
			)
		).toEqual({
			kind: 'refused',
			status: 403,
			message: 'You signed in more than 10 minutes ago. Sign out and sign in again, then run it.'
		});
	});
});

describe('checks at the start (C9, C12)', () => {
	it('C12: a selection with a machine the person may not run on is refused whole, naming it', async () => {
		const { database, admin, pat, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		const lab = enrol(database, 'Lab 3', 'linux');
		connect(office);
		connect(lab);
		grantAccess(database, {
			adminId: admin.id,
			name: 'Fleet',
			memberIds: [pat.id],
			machineIds: [office],
			permissions: ['view', 'run-commands'],
			consent: 'unattended'
		});
		grantAccess(database, {
			adminId: admin.id,
			name: 'Lab',
			memberIds: [pat.id],
			machineIds: [lab],
			permissions: ['view', 'terminal'],
			consent: 'unattended'
		});
		expect(await startRun(context('pat'), request([office, lab]))).toEqual({
			kind: 'refused',
			status: 403,
			message: 'You cannot run commands on Lab 3. Take them out of the selection and try again.'
		});
		expect(statuses(database)).toEqual({});
		// Review says so before anything is sent.
		expect(planRun(context('pat'), [office, lab])).toMatchObject({
			machines: [
				{ name: 'Office', plan: { kind: 'runs' } },
				{ name: 'Lab 3', plan: { kind: 'skipped', reason: 'no-permission' } }
			]
		});
		// A machine they cannot see at all is not named.
		const hidden = enrol(database, 'Payroll', 'linux');
		expect(await startRun(context('pat'), request([office, hidden]))).toEqual({
			kind: 'refused',
			status: 404,
			message: 'No machine with this id.'
		});
		expect((await startRun(context('pat'), request([office]))).kind).toBe('started');
	});

	it('C9: above 10 machines the typed count must match, checked by the server', async () => {
		const { database, context } = await setUp();
		const ids = Array.from({ length: 11 }, (_, index) => enrol(database, `PC ${index}`, 'linux'));
		expect(await startRun(context('admin'), request(ids, { confirmCount: 10 }))).toEqual({
			kind: 'refused',
			status: 400,
			message: 'Type 11, the number of machines, to confirm.'
		});
		expect((await startRun(context('admin'), request(ids, { confirmCount: 11 }))).kind).toBe(
			'started'
		);
	});

	it('C6: each system in the selection needs its command, and no others', async () => {
		const { database, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		const desk = enrol(database, 'Desk', 'windows');
		expect(await startRun(context('admin'), request([office, desk]))).toMatchObject({
			kind: 'refused',
			message: 'Write a command for the Windows machines.'
		});
		expect(
			await startRun(
				context('admin'),
				request([desk], {
					scripts: [
						{ osFamily: 'linux', shell: 'sh', command: 'uptime' },
						{ osFamily: 'windows', shell: 'cmd', command: 'ver' }
					]
				})
			)
		).toMatchObject({ kind: 'refused', message: 'No machine in the selection runs Linux.' });
	});
});

describe('running (C13–C17)', () => {
	it('C14: at most 10 machines run at once; the next starts as each finishes', async () => {
		const { database, relay, context } = await setUp();
		const ids = Array.from({ length: 12 }, (_, index) =>
			enrol(database, `PC ${String(index).padStart(2, '0')}`, 'linux')
		);
		const tickets = ids.map((id) => connect(id));
		const started = await startRun(context('admin'), request(ids, { confirmCount: 12 }));
		if (started.kind !== 'started') throw new Error(started.message);
		const sent = () => tickets.filter((list) => list.length > 0).length;
		expect(sent()).toBe(10);
		expect(Object.values(statuses(database)).filter((status) => status === 'waiting')).toHaveLength(
			2
		);
		const first = tickets[0]?.[0];
		if (first === undefined) throw new Error('no ticket');
		agentAnswers(relay, first, { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false });
		expect(sent()).toBe(11);
		expect(runViewFor(database, context('admin').user, started.runId)?.counts).toMatchObject({
			succeeded: 1,
			running: 10,
			waiting: 1
		});
	});

	it('C15: offline machines and old agents are skipped, not queued', async () => {
		const { database, context } = await setUp();
		const online = enrol(database, 'Online', 'linux');
		const offline = enrol(database, 'Offline', 'linux');
		const old = enrol(database, 'Old', 'linux', '0.4.25');
		const mac = enrol(database, 'Mac', 'macos');
		const onlineTickets = connect(online);
		const oldTickets = connect(old);
		expect(planRun(context('admin'), [online, offline, old, mac])).toMatchObject({
			machines: [
				{ plan: { kind: 'runs' } },
				{ plan: { kind: 'skipped', reason: 'offline' } },
				{ plan: { kind: 'skipped', reason: 'agent-too-old' } },
				{ plan: { kind: 'skipped', reason: 'unsupported-system' } }
			]
		});
		const started = await startRun(context('admin'), request([online, offline, old, mac]));
		if (started.kind !== 'started') throw new Error(started.message);
		expect(onlineTickets).toHaveLength(1);
		expect(oldTickets).toHaveLength(0);
		const view = runViewFor(database, context('admin').user, started.runId);
		expect(view?.machines.map((row) => [row.machineName, row.status, row.reason])).toEqual([
			['Online', 'running', ''],
			['Offline', 'offline', ''],
			['Old', 'skipped', 'Agent too old (update first)'],
			['Mac', 'skipped', 'Commands run on Windows and Linux only']
		]);
	});

	it('C13: each machine gets its own ticket: that machine, the person, the exact command and run-commands', async () => {
		const { database, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		const desk = enrol(database, 'Desk', 'windows');
		const officeTickets = connect(office);
		const deskTickets = connect(desk);
		await startRun(
			context('admin'),
			request([office, desk], {
				scripts: [
					{ osFamily: 'linux', shell: 'bash', command: 'systemctl restart cups' },
					{ osFamily: 'windows', shell: 'powershell', command: 'Restart-Service Spooler' }
				],
				timeoutMs: 30_000
			})
		);
		expect(officeTickets[0]).toMatchObject({
			machineId: office,
			user: { name: 'ada' },
			purpose: {
				kind: 'exec',
				shell: 'bash',
				command: 'systemctl restart cups',
				timeoutMs: 30_000,
				maxOutputBytes: 2 * 1024 * 1024
			}
		});
		expect(officeTickets[0]?.permissions).toContain('run-commands');
		expect(deskTickets[0]).toMatchObject({
			machineId: desk,
			purpose: { shell: 'powershell', command: 'Restart-Service Spooler' }
		});
		expect(deskTickets[0]?.sessionId).not.toBe(officeTickets[0]?.sessionId);
	});

	it('C16: results end as succeeded, failed, timed out or lost; output is kept 30 days', async () => {
		const { database, relay, clock, context } = await setUp();
		const ids = ['Good', 'Bad', 'Slow', 'Gone', 'Refused'].map((name) =>
			enrol(database, name, 'linux')
		);
		const tickets = ids.map((id) => connect(id));
		const started = await startRun(context('admin'), request(ids));
		if (started.kind !== 'started') throw new Error(started.message);
		const ticket = (index: number) => {
			const found = tickets[index]?.[0];
			if (found === undefined) throw new Error('no ticket');
			return found;
		};
		agentAnswers(relay, ticket(0), {
			stdout: 'restarted\n',
			stderr: '',
			exitCode: 0,
			timedOut: false
		});
		agentAnswers(relay, ticket(1), {
			stdout: '',
			stderr: 'no such unit\n',
			exitCode: 5,
			timedOut: false
		});
		agentAnswers(relay, ticket(2), { stdout: 'partial', stderr: '', exitCode: -1, timedOut: true });
		const gone = quietPeer();
		relay.attachAgent(ticket(3).sessionId, ticket(3).machineId, gone);
		relay.agentClosed(ticket(3).sessionId, gone);
		relay.refusedByAgent(
			ticket(4).sessionId,
			ticket(4).machineId,
			'the ticket does not carry the run-commands permission'
		);

		const user = context('admin').user;
		const view = runViewFor(database, user, started.runId);
		expect(view?.machines.map((row) => [row.machineName, row.status, row.exitCode])).toEqual([
			['Good', 'succeeded', 0],
			['Bad', 'failed', 5],
			['Slow', 'timed-out', null],
			['Gone', 'lost', null],
			['Refused', 'failed', null]
		]);
		expect(view?.status).toBe('finished');
		expect(view?.endedIso).not.toBeNull();
		expect(view?.machines[4]?.reason).toBe('the ticket does not carry the run-commands permission');
		expect(runOutputFor(database, user, started.runId, ids[1] ?? '')).toEqual({
			kind: 'kept',
			stdout: '',
			stderr: 'no such unit\n',
			stdoutTruncated: false,
			stderrTruncated: false
		});

		// 30 days on, the output goes; the rows and exit codes stay.
		expect(pruneCommandOutput(database, clock.now + 29 * 24 * 60 * MINUTE)).toBe(0);
		expect(pruneCommandOutput(database, clock.now + 31 * 24 * 60 * MINUTE)).toBe(5);
		expect(runOutputFor(database, user, started.runId, ids[1] ?? '')).toEqual({ kind: 'deleted' });
		const after = runViewFor(database, user, started.runId);
		expect(after?.machines[1]).toMatchObject({
			status: 'failed',
			exitCode: 5,
			output: { kind: 'deleted' }
		});
	});

	it('C16: output beyond 1 MB per stream is cut off and marked', async () => {
		const { database, relay, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		const tickets = connect(office);
		const started = await startRun(context('admin'), request([office]));
		if (started.kind !== 'started') throw new Error(started.message);
		const ticket = tickets[0];
		if (ticket === undefined) throw new Error('no ticket');
		agentAnswers(relay, ticket, {
			stdout: 'x'.repeat(1024 * 1024 + 10),
			stderr: 'small',
			exitCode: 0,
			timedOut: false
		});
		const output = runOutputFor(database, context('admin').user, started.runId, office);
		expect(output).toMatchObject({ kind: 'kept', stdoutTruncated: true, stderrTruncated: false });
		expect(output?.kind === 'kept' ? output.stdout.length : 0).toBe(1024 * 1024);
	});

	it('C16: a run the server restart cut off is closed: running machines lost, waiting ones skipped', async () => {
		const { database, context } = await setUp();
		const ids = Array.from({ length: 11 }, (_, index) =>
			enrol(database, `PC ${String(index).padStart(2, '0')}`, 'linux')
		);
		for (const id of ids) connect(id);
		const started = await startRun(context('admin'), request(ids, { confirmCount: 11 }));
		if (started.kind !== 'started') throw new Error(started.message);
		expect(closeRunsCutByRestart(database, NOW + 5 * MINUTE)).toBe(1);
		const view = runViewFor(database, context('admin').user, started.runId);
		expect(view?.status).toBe('finished');
		expect(view?.counts).toMatchObject({ lost: 10, skipped: 1 });
	});

	it('C17: Cancel run stops machines that have not started; running ones finish', async () => {
		const { database, relay, admin, pat, context } = await setUp();
		const ids = Array.from({ length: 12 }, (_, index) =>
			enrol(database, `PC ${String(index).padStart(2, '0')}`, 'linux')
		);
		const tickets = ids.map((id) => connect(id));
		const started = await startRun(context('admin'), request(ids, { confirmCount: 12 }));
		if (started.kind !== 'started') throw new Error(started.message);
		grantAccess(database, {
			adminId: admin.id,
			name: 'Fleet',
			memberIds: [pat.id],
			machineIds: ids,
			permissions: ['view', 'run-commands'],
			consent: 'unattended'
		});
		// Only the person who started it (or an admin) may cancel it.
		expect(cancelRun(context('pat'), started.runId)).toMatchObject({
			kind: 'refused',
			status: 404
		});
		expect(cancelRun(context('admin'), started.runId)).toEqual({
			kind: 'cancelled',
			notStarted: 2
		});
		expect(runViewFor(database, admin, started.runId)?.counts).toMatchObject({
			running: 10,
			cancelled: 2
		});
		for (const list of tickets.slice(0, 10)) {
			const ticket = list[0];
			if (ticket === undefined) throw new Error('no ticket');
			agentAnswers(relay, ticket, { stdout: '', stderr: '', exitCode: 0, timedOut: false });
		}
		expect(tickets.slice(10).every((list) => list.length === 0)).toBe(true);
		const view = runViewFor(database, admin, started.runId);
		expect(view?.status).toBe('cancelled');
		expect(view?.endedIso).not.toBeNull();
		expect(view?.counts).toMatchObject({ succeeded: 10, cancelled: 2 });
		expect(cancelRun(context('admin'), started.runId)).toMatchObject({
			kind: 'refused',
			status: 400
		});
	});
});

describe('the record (C19, C20)', () => {
	it('C19: the start, each result with its output size and hash (never the output), a cancel and the end', async () => {
		const { database, relay, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		const desk = enrol(database, 'Desk', 'windows');
		const officeTickets = connect(office);
		const started = await startRun(
			context('admin'),
			request([office, desk], {
				scripts: [
					{ osFamily: 'linux', shell: 'sh', command: 'cat /etc/secret' },
					{ osFamily: 'windows', shell: 'cmd', command: 'ver' }
				]
			})
		);
		if (started.kind !== 'started') throw new Error(started.message);
		const ticket = officeTickets[0];
		if (ticket === undefined) throw new Error('no ticket');
		agentAnswers(relay, ticket, { stdout: 'hunter2\n', stderr: '', exitCode: 0, timedOut: false });

		const entries = listAudit(database, 50).reverse();
		const start = entries.find((entry) => entry.kind === 'command-run-started');
		expect(start?.detail).toMatchObject({
			run: started.runId,
			'Linux command': 'cat /etc/secret',
			'Linux shell': 'sh',
			'Windows command': 'ver',
			'Windows shell': 'cmd',
			'time limit': '60 s',
			machines: '2',
			skipped: '0'
		});
		const results = entries.filter((entry) => entry.kind === 'command-run-machine');
		expect(results.map((entry) => [entry.target, entry.detail['result']])).toEqual([
			['Desk', 'Offline'],
			['Office', 'Succeeded']
		]);
		expect(results[1]?.machineId).toBe(office);
		expect(results[1]?.detail).toMatchObject({
			'exit code': '0',
			duration: '1.2 s',
			'output bytes': '8',
			'output SHA-256': createHash('sha256').update('hunter2\n').digest('hex')
		});
		expect(JSON.stringify(entries)).not.toContain('hunter2');
		const end = entries.find((entry) => entry.kind === 'command-run-ended');
		expect(end?.detail).toMatchObject({ run: started.runId, totals: '1 succeeded · 1 offline' });
	});

	it('C19: a cancel is audited with how many machines did not start', async () => {
		const { database, context } = await setUp();
		const ids = Array.from({ length: 11 }, (_, index) => enrol(database, `PC ${index}`, 'linux'));
		for (const id of ids) connect(id);
		const started = await startRun(context('admin'), request(ids, { confirmCount: 11 }));
		if (started.kind !== 'started') throw new Error(started.message);
		cancelRun(context('admin'), started.runId);
		const cancel = listAudit(database, 50).find((entry) => entry.kind === 'command-run-cancelled');
		expect(cancel?.detail).toEqual({ run: started.runId, 'machines not started': '1' });
	});

	it('C20: a person sees runs only through the machines they can view', async () => {
		const { database, admin, pat, context } = await setUp();
		const office = enrol(database, 'Office', 'linux');
		const payroll = enrol(database, 'Payroll', 'linux');
		connect(office);
		connect(payroll);
		const both = await startRun(context('admin'), request([office, payroll]));
		const hidden = await startRun(context('admin'), request([payroll]));
		if (both.kind !== 'started' || hidden.kind !== 'started') throw new Error('not started');
		grantAccess(database, {
			adminId: admin.id,
			name: 'Office',
			memberIds: [pat.id],
			machineIds: [office],
			permissions: ['view'],
			consent: 'unattended'
		});
		expect(
			listRunsFor(database, admin)
				.map((run) => run.id)
				.sort()
		).toEqual([both.runId, hidden.runId].sort());
		expect(listRunsFor(database, pat).map((run) => run.id)).toEqual([both.runId]);
		expect(runViewFor(database, pat, both.runId)?.machines.map((row) => row.machineName)).toEqual([
			'Office'
		]);
		expect(runViewFor(database, pat, hidden.runId)).toBeUndefined();
		expect(runOutputFor(database, pat, both.runId, payroll)).toBeUndefined();
	});
});
