import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { agentConnected, agentDisconnected, type LivePeer } from '../agents/live-agents.ts';
import { listAudit } from '../audit/audit.ts';
import { createRelay, RELAY_LIMITS, type RelayPeer } from '../sessions/relay.ts';
import { toConsoleUser } from '../users/users.ts';
import { guestBrowserTicket, openGuestDesktop } from './guest-sessions.ts';
import {
	createShareLink,
	endShareLink,
	resolveShareToken,
	sweepShareLinks
} from './share-links.ts';

/**
 * The guest's session once BMuster can ask the person at the screen (SPEC-DESKTOP phase 5).
 * Until then every guest session is refused (share-links.test.ts, SL12); these tests lift
 * that one gate to prove what happens after it, so the day it opens nothing else changes.
 */
vi.mock(import('../sessions/sessions.ts'), async (importOriginal) => ({
	...(await importOriginal()),
	canAskAtScreen: () => true
}));

const SECRETS_KEY = Buffer.alloc(32, 5);
const CONTROL = {
	recipient: 'Dave, Acme Printers',
	duration: '15m',
	control: true,
	files: false
} as const;

const connected: { machineId: string; peer: LivePeer }[] = [];

afterEach(() => {
	for (const { machineId, peer } of connected.splice(0)) {
		agentDisconnected(machineId, peer);
	}
});

async function setUp() {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const machineId = enrolFakeAgent(database, NOW).machineId;
	const sent: ServerSocketMessage[] = [];
	const peer: LivePeer = { send: (message) => sent.push(message), close: () => undefined };
	agentConnected(machineId, peer);
	connected.push({ machineId, peer });
	const relay = createRelay(RELAY_LIMITS);
	const made = createShareLink(database, admin, machineId, CONTROL, NOW);
	if (made.kind !== 'created') throw new Error(made.message);
	const resolved = resolveShareToken(database, relay, made.token, NOW);
	if (resolved.kind !== 'active') throw new Error('The link should be active');
	return { database, admin, machineId, sent, relay, link: made.link, grant: resolved.grant };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

function open(setup: Setup, mode: 'watch' | 'control') {
	const result = openGuestDesktop(
		setup.database,
		setup.relay,
		SECRETS_KEY,
		setup.grant,
		mode,
		'198.51.100.7',
		NOW
	);
	if (result.kind !== 'opened') throw new Error(result.message);
	return result.reply;
}

function ticketOf(message: ServerSocketMessage | undefined): unknown {
	if (message?.type !== 'session-open') throw new Error('Expected a session-open');
	return JSON.parse(Buffer.from(message.ticket, 'base64').toString('utf8'));
}

describe('a guest session, once the person at the screen can be asked', () => {
	it('SL11: the signed ticket names the guest, only the link permissions, and asks first', async () => {
		const setup = await setUp();
		open(setup, 'control');
		expect(ticketOf(setup.sent[0])).toMatchObject({
			machineId: setup.machineId,
			user: { id: setup.link.id, name: 'Dave, Acme Printers (shared by ada)' },
			permissions: ['desktop-view', 'desktop-control'],
			purpose: { kind: 'desktop', consent: 'ask' }
		});
	});

	it('SL13: one session per link: opening again ends the first; a reload gets a ticket for it', async () => {
		const setup = await setUp();
		const first = open(setup, 'watch');
		expect(guestBrowserTicket(setup.relay, setup.grant, first.sessionId).kind).toBe('issued');
		const second = open(setup, 'control');
		expect(setup.relay.sessionsOf(setup.link.id)).toEqual([second.sessionId]);
		expect(guestBrowserTicket(setup.relay, setup.grant, first.sessionId)).toEqual({
			kind: 'ended',
			message: 'The link was opened in another window.'
		});
	});

	it("a guest gets no ticket for someone else's session", async () => {
		const setup = await setUp();
		open(setup, 'watch');
		const otherSession = crypto.randomUUID();
		setup.relay.start(
			{
				id: otherSession,
				machineId: setup.machineId,
				userId: setup.admin.id,
				userName: 'ada',
				viewer: { kind: 'user' },
				kind: 'desktop',
				mode: 'control',
				ip: '192.0.2.1',
				openedAt: NOW
			},
			() => undefined,
			() => undefined
		);
		expect(guestBrowserTicket(setup.relay, setup.grant, otherSession)).toEqual({
			kind: 'ended',
			message: 'This session has ended.'
		});
	});

	it('SL7: End now closes the open session at once', async () => {
		const setup = await setUp();
		const reply = open(setup, 'control');
		expect(endShareLink(setup.database, setup.relay, setup.admin, setup.link.id, NOW)).toEqual({
			kind: 'ended'
		});
		expect(setup.relay.isRunning(reply.sessionId)).toBe(false);
		expect(setup.relay.endedSession(reply.sessionId)?.reason).toBe('share-link-ended');
	});

	it('SL8: when the link runs out the session ends', async () => {
		const setup = await setUp();
		const reply = open(setup, 'watch');
		sweepShareLinks(setup.database, setup.relay, NOW + 15 * 60_000);
		expect(setup.relay.isRunning(reply.sessionId)).toBe(false);
		expect(listAudit(setup.database, 100).map((entry) => entry.kind)).toContain(
			'share-link-expired'
		);
	});

	it('SL14: the session is audited as the guest, with the link, under System', async () => {
		const setup = await setUp();
		const reply = open(setup, 'control');
		endShareLink(setup.database, setup.relay, setup.admin, setup.link.id, NOW);
		const entries = listAudit(setup.database, 100);
		for (const kind of ['session-opened', 'session-ended'] as const) {
			expect(entries.find((entry) => entry.kind === kind)).toMatchObject({
				actorUserId: null,
				machineId: setup.machineId,
				detail: {
					type: 'desktop',
					mode: 'control',
					consent: 'ask',
					guest: 'Dave, Acme Printers (shared by ada)',
					'share link': setup.link.id,
					session: reply.sessionId
				}
			});
		}
		expect(entries.find((entry) => entry.kind === 'session-ended')?.detail['ended']).toBe(
			'The share link ended'
		);
	});
	it('a guest copy or paste is audited under System, naming the guest and the link', async () => {
		const setup = await setUp();
		const reply = open(setup, 'control');
		const agent: RelayPeer = {
			sendText: () => undefined,
			sendBytes: (_data, sent) => {
				sent();
			},
			pause: () => undefined,
			resume: () => undefined,
			close: () => undefined
		};
		setup.relay.attachAgent(reply.sessionId, setup.machineId, agent);
		setup.relay.agentText(reply.sessionId, agent, '{"type":"clipboard-sent","bytes":5}');
		expect(
			listAudit(setup.database, 100).find((entry) => entry.kind === 'desktop-clipboard')
		).toMatchObject({
			actorUserId: null,
			detail: {
				direction: 'to the machine',
				bytes: '5',
				guest: 'Dave, Acme Printers (shared by ada)',
				'share link': setup.link.id,
				session: reply.sessionId
			}
		});
	});
});
