import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { agentConnected, agentDisconnected, type LivePeer } from '../agents/live-agents.ts';
import { serverKey } from '../agents/server-keys.ts';
import { verifySignature } from '../agents/signing.ts';
import { listAudit } from '../audit/audit.ts';
import { toConsoleUser } from '../users/users.ts';
import { createRelay, RELAY_LIMITS, type RelayPeer } from './relay.ts';
import { browserTicketFor, openTerminalSession } from './sessions.ts';

const SECRETS_KEY = Buffer.alloc(32, 3);
const TERMINAL = { kind: 'terminal', shell: 'bash', cols: 80, rows: 24 } as const;

const connected: { machineId: string; peer: LivePeer }[] = [];

afterEach(() => {
	for (const { machineId, peer } of connected.splice(0)) {
		agentDisconnected(machineId, peer);
	}
	vi.useRealTimers();
});

/** Connects a pretend live socket for the machine; returns what the server sends it. */
function connect(machineId: string): ServerSocketMessage[] {
	const sent: ServerSocketMessage[] = [];
	const peer: LivePeer = {
		send: (message) => sent.push(message),
		close: () => undefined
	};
	agentConnected(machineId, peer);
	connected.push({ machineId, peer });
	return sent;
}

async function setUp() {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	const machineId = enrolFakeAgent(database, NOW).machineId;
	const relay = createRelay(RELAY_LIMITS);
	return { database, admin, pat, machineId, relay };
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

describe('who may open a terminal (T2)', () => {
	it('admins always', async () => {
		const { database, admin, machineId, relay } = await setUp();
		connect(machineId);
		const result = openTerminalSession(
			database,
			relay,
			SECRETS_KEY,
			admin,
			machineId,
			TERMINAL,
			'192.0.2.1',
			NOW
		);
		expect(result.kind).toBe('opened');
	});

	it('members with the terminal permission; others are told why, and hidden machines stay hidden', async () => {
		const { database, admin, pat, machineId, relay } = await setUp();
		connect(machineId);
		const open = () =>
			openTerminalSession(database, relay, SECRETS_KEY, pat, machineId, TERMINAL, '192.0.2.1', NOW);
		expect(open()).toMatchObject({ kind: 'refused', status: 404 });
		grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files'],
			consent: 'unattended'
		});
		expect(open()).toMatchObject({
			kind: 'refused',
			status: 403,
			message: "You don't have permission to open a terminal on this machine."
		});
		grantAccess(database, {
			adminId: admin.id,
			name: 'Engineers',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'terminal'],
			consent: 'unattended'
		});
		expect(open().kind).toBe('opened');
	});

	it('refuses an offline machine and a shell the machine does not offer', async () => {
		const { database, admin, machineId, relay } = await setUp();
		expect(
			openTerminalSession(database, relay, SECRETS_KEY, admin, machineId, TERMINAL, 'ip', NOW)
		).toMatchObject({ kind: 'refused', status: 409, message: 'This machine is offline.' });
		connect(machineId);
		expect(
			openTerminalSession(
				database,
				relay,
				SECRETS_KEY,
				admin,
				machineId,
				{ ...TERMINAL, shell: 'powershell' },
				'ip',
				NOW
			)
		).toMatchObject({ kind: 'refused', status: 400 });
	});
});

describe('the signed ticket (T3)', () => {
	it('goes to the agent on its live socket, signed by the server key it learnt at enrolment', async () => {
		const { database, admin, machineId, relay } = await setUp();
		const sent = connect(machineId);
		const result = openTerminalSession(
			database,
			relay,
			SECRETS_KEY,
			admin,
			machineId,
			TERMINAL,
			'192.0.2.1',
			NOW
		);
		if (result.kind !== 'opened') throw new Error(result.message);
		const message = sent.find((item) => item.type === 'session-open');
		if (message?.type !== 'session-open') throw new Error('no session-open sent');

		const json = Buffer.from(message.ticket, 'base64');
		const signed = Buffer.concat([Buffer.from('BMUSTER-TICKET-1\n'), json]);
		const { publicKeyBase64 } = serverKey(database, SECRETS_KEY, NOW);
		expect(verifySignature(publicKeyBase64, signed, Buffer.from(message.signature, 'base64'))).toBe(
			true
		);
		expect(JSON.parse(json.toString('utf8'))).toEqual({
			sessionId: result.reply.sessionId,
			machineId,
			user: { id: admin.id, name: admin.name },
			permissions: ['view', 'terminal', 'desktop-view', 'desktop-control', 'files', 'share-links'],
			runAs: { kind: 'admin' },
			issuedAtMs: NOW,
			expiresAtMs: NOW + 60_000,
			purpose: { kind: 'terminal', shell: 'bash', cols: 80, rows: 24 }
		});
	});
});

describe('browser tickets for reloads (T4)', () => {
	it('are given only to the person whose session it is, and say how it ended afterwards', async () => {
		const { database, admin, pat, machineId, relay } = await setUp();
		connect(machineId);
		const result = openTerminalSession(
			database,
			relay,
			SECRETS_KEY,
			admin,
			machineId,
			TERMINAL,
			'ip',
			NOW
		);
		if (result.kind !== 'opened') throw new Error(result.message);
		const sessionId = result.reply.sessionId;
		expect(browserTicketFor(relay, admin, sessionId).kind).toBe('issued');
		expect(browserTicketFor(relay, pat, sessionId)).toEqual({
			kind: 'ended',
			message: 'This session has ended.'
		});
		relay.end(sessionId, 'idle', 'The session ended after 60 minutes with no input.');
		expect(browserTicketFor(relay, admin, sessionId)).toEqual({
			kind: 'ended',
			message: 'The session ended after 60 minutes with no input.'
		});
	});
});

describe('audit (T7)', () => {
	it('records who opened which shell from where, and how and when it ended, never its content', async () => {
		vi.useFakeTimers({ now: NOW });
		const { database, admin, machineId, relay } = await setUp();
		connect(machineId);
		const result = openTerminalSession(
			database,
			relay,
			SECRETS_KEY,
			admin,
			machineId,
			TERMINAL,
			'192.0.2.1',
			NOW
		);
		if (result.kind !== 'opened') throw new Error(result.message);
		const sessionId = result.reply.sessionId;
		const agent = quietPeer();
		const browser = quietPeer();
		relay.attachAgent(sessionId, machineId, agent);
		relay.redeemBrowserTicket(sessionId, result.reply.browserTicket);
		relay.attachBrowser(sessionId, browser);
		relay.fromBrowser(sessionId, browser, Buffer.from('cat /etc/shadow\r'));
		relay.fromAgent(sessionId, agent, Buffer.from('secret output'));
		vi.advanceTimersByTime(125_000);
		relay.agentText(sessionId, agent, '{"type":"exited","code":0}');

		const entries = listAudit(database, 10).filter((entry) => entry.kind.startsWith('session-'));
		expect(entries.map((entry) => entry.kind)).toEqual(['session-ended', 'session-opened']);
		expect(entries[1]).toMatchObject({
			actorUserId: admin.id,
			target: 'Test machine',
			detail: {
				type: 'terminal',
				shell: 'bash',
				'run as': 'Administrator (root or SYSTEM)',
				from: '192.0.2.1'
			}
		});
		expect(entries[0]).toMatchObject({
			actorUserId: admin.id,
			detail: {
				duration: '2 min 5 s',
				ended: 'The shell exited',
				'bytes in': '16',
				'bytes out': '13'
			}
		});
		const everything = JSON.stringify(listAudit(database, 100));
		expect(everything).not.toContain('shadow');
		expect(everything).not.toContain('secret output');
	});
});
