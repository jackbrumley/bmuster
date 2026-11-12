import { isHttpError, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { database } from '#lib/server/database/app-database.ts';
import {
	agentConnected,
	agentDisconnected,
	type LivePeer
} from '#lib/server/services/agents/live-agents.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { SHARE_LINK_LIMIT } from '#lib/server/services/share-links/share-link-limits.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent } from '#tests/helpers/fake-agent.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { GET as listGet, POST as createPost } from '../../api/machines/[id]/share-links/+server.ts';
import { GET as allGet } from '../../api/share-links/+server.ts';
import { DELETE as endDelete } from '../../api/share-links/[id=uuid]/+server.ts';
import { load } from './+page.server.ts';
import { POST as sessionPost } from './session/+server.ts';
import { GET as statusGet } from './status/+server.ts';

/**
 * The share-link routes (SPEC-SHARE-LINKS), against the server's own database: who may make,
 * list and end links, and what a guest's requests need.
 */

const now = Date.now();

/** A cookie jar standing in for the browser's. */
function jar(): Cookies & { values: Map<string, { value: string; path: string }> } {
	const values = new Map<string, { value: string; path: string }>();
	const partial: Pick<Cookies, 'get' | 'set'> & { values: typeof values } = {
		values,
		get: (name) => values.get(name)?.value,
		set: (name, value, options) => {
			values.set(name, { value, path: options?.path ?? '' });
		}
	};
	return partial as Cookies & { values: typeof values };
}

type Signed = { kind: 'signed-in'; user: ConsoleUser } | { kind: 'none' };

function consoleEvent(
	path: string,
	method: string,
	session: Signed,
	params: Record<string, string>,
	body: unknown
): RequestEvent {
	const url = new URL(`https://bmuster.test${path}`);
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request' | 'params' | 'getClientAddress'> =
		{
			locals: { session },
			url,
			params,
			request: new Request(url, {
				method,
				headers: { 'content-type': 'application/json', origin: url.origin },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			}),
			getClientAddress: () => '192.0.2.50'
		};
	return partial as RequestEvent;
}

function guestEvent(
	path: string,
	method: string,
	token: string,
	cookies: Cookies,
	address: string,
	body: unknown
): RequestEvent & { headersSet: Record<string, string> } {
	const url = new URL(`https://bmuster.test${path}`);
	const headersSet: Record<string, string> = {};
	const partial: Pick<
		RequestEvent,
		'locals' | 'url' | 'request' | 'params' | 'getClientAddress' | 'cookies' | 'setHeaders'
	> & { headersSet: Record<string, string> } = {
		locals: { session: { kind: 'none' } },
		url,
		params: { token },
		cookies,
		headersSet,
		setHeaders: (headers) => {
			Object.assign(headersSet, headers);
		},
		request: new Request(url, {
			method,
			headers: {
				'content-type': 'application/json',
				origin: url.origin,
				'user-agent': 'Guest browser'
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		}),
		getClientAddress: () => address
	};
	return partial as RequestEvent & { headersSet: Record<string, string> };
}

async function setUp() {
	const tag = crypto.randomUUID();
	const admin = toConsoleUser(
		await addTestUser(database, { email: `ada-${tag}@example.com`, role: 'admin', password: null })
	);
	const member = toConsoleUser(
		await addTestUser(database, { email: `kim-${tag}@example.com`, role: 'member', password: null })
	);
	const machineId = enrolFakeAgent(database, now).machineId;
	const otherMachineId = enrolFakeAgent(database, now).machineId;
	grantAccess(database, {
		adminId: admin.id,
		name: `Watchers ${tag}`,
		memberIds: [member.id],
		machineIds: [machineId],
		permissions: ['view', 'desktop-view'],
		consent: 'unattended'
	});
	return { admin, member, machineId, otherMachineId };
}

const WATCH = { recipient: 'Dave, Acme Printers', duration: '1h', control: false, files: false };

async function create(user: ConsoleUser, machineId: string) {
	const event = consoleEvent(
		`/api/machines/${machineId}/share-links`,
		'POST',
		{ kind: 'signed-in', user },
		{ id: machineId },
		WATCH
	);
	const response = await createPost(event as Parameters<typeof createPost>[0]);
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function linkFor(user: ConsoleUser, machineId: string) {
	const made = await create(user, machineId);
	expect(made.status).toBe(201);
	const url = String(made.json['url']);
	const token = url.slice(url.lastIndexOf('/') + 1);
	const link = made.json['link'] as { id: string };
	return { token, linkId: link.id, url };
}

type LoadEvent = Parameters<typeof load>[0];

function loadPage(token: string, cookies: Cookies, address: string) {
	const url = new URL(`https://bmuster.test/s/${token}`);
	const headersSet: Record<string, string> = {};
	const partial: Pick<
		LoadEvent,
		'locals' | 'url' | 'request' | 'params' | 'getClientAddress' | 'cookies' | 'setHeaders'
	> = {
		locals: { session: { kind: 'none' } },
		url,
		params: { token },
		cookies,
		setHeaders: (headers) => {
			Object.assign(headersSet, headers);
		},
		request: new Request(url, { headers: { 'user-agent': 'Guest browser' } }),
		getClientAddress: () => address
	};
	const event = { ...partial, headersSet };
	try {
		return { kind: 'loaded' as const, data: load(partial as LoadEvent), event };
	} catch (caught) {
		if (isHttpError(caught)) {
			return { kind: 'error' as const, status: caught.status, message: caught.body.message, event };
		}
		throw caught;
	}
}

function randomAddress(): string {
	const byte = () => String(Math.floor(Math.random() * 250) + 1);
	return `10.${byte()}.${byte()}.${byte()}`;
}

describe('console routes (SL2, SL7, SL15)', () => {
	it('SL2: a member without share-links is refused, and a hidden machine is 404', async () => {
		const { member, machineId, otherMachineId } = await setUp();
		expect((await create(member, machineId)).status).toBe(403);
		expect((await create(member, otherMachineId)).status).toBe(404);
		const signedOut = consoleEvent(
			`/api/machines/${machineId}/share-links`,
			'POST',
			{ kind: 'none' },
			{ id: machineId },
			WATCH
		);
		expect((await createPost(signedOut as Parameters<typeof createPost>[0])).status).toBe(401);
	});

	it('SL2: the reply carries the link address once, under /s/', async () => {
		const { admin, machineId } = await setUp();
		const { url } = await linkFor(admin, machineId);
		expect(url).toMatch(/^https:\/\/bmuster\.test\/s\/[A-Za-z0-9_-]{43}$/);
	});

	it('SL7: ending needs share-links on the link machine; an unknown id is 404', async () => {
		const { admin, member, machineId } = await setUp();
		const { linkId, token } = await linkFor(admin, machineId);
		const end = async (user: ConsoleUser, id: string) =>
			(
				await endDelete(
					consoleEvent(
						`/api/share-links/${id}`,
						'DELETE',
						{ kind: 'signed-in', user },
						{ id },
						undefined
					) as Parameters<typeof endDelete>[0]
				)
			).status;
		expect(await end(member, linkId)).toBe(403);
		expect(await end(admin, crypto.randomUUID())).toBe(404);
		expect(await end(admin, linkId)).toBe(200);
		expect(loadPage(token, jar(), randomAddress())).toMatchObject({ kind: 'error', status: 404 });
	});

	it('SL15: the machine list needs share-links; the server-wide list is for admins only', async () => {
		const { admin, member, machineId } = await setUp();
		await linkFor(admin, machineId);
		const list = (user: ConsoleUser) =>
			listGet(
				consoleEvent(
					`/api/machines/${machineId}/share-links`,
					'GET',
					{ kind: 'signed-in', user },
					{ id: machineId },
					undefined
				) as Parameters<typeof listGet>[0]
			);
		expect((await list(member)).status).toBe(403);
		expect((await list(admin)).status).toBe(200);
		const all = (user: ConsoleUser) =>
			allGet(
				consoleEvent(
					'/api/share-links',
					'GET',
					{ kind: 'signed-in', user },
					{},
					undefined
				) as Parameters<typeof allGet>[0]
			);
		expect((await all(member)).status).toBe(403);
		expect((await all(admin)).status).toBe(200);
	});
});

describe('the guest page and its requests (SL5, SL9, SL10, SL19)', () => {
	it('SL5, SL19: a valid link loads with safe headers, sets the guest cookie and audits the opening once', async () => {
		const { admin, machineId } = await setUp();
		const { token, linkId } = await linkFor(admin, machineId);
		const cookies = jar();
		const address = randomAddress();
		const first = loadPage(token, cookies, address);
		expect(first).toMatchObject({
			kind: 'loaded',
			data: { token, guest: { recipient: 'Dave, Acme Printers', permissions: ['desktop-view'] } }
		});
		expect(first.event.headersSet).toMatchObject({
			'referrer-policy': 'no-referrer',
			'cache-control': 'no-store'
		});
		expect(cookies.values.get('bmuster_guest')?.path).toBe(`/s/${token}`);
		loadPage(token, cookies, address);
		const opened = listAudit(database, 500).filter(
			(entry) => entry.kind === 'share-link-opened' && entry.detail['share link'] === linkId
		);
		expect(opened).toHaveLength(1);
		expect(opened[0]?.detail).toMatchObject({ from: address, browser: 'Guest browser' });
	});

	it('SL5: wrong and malformed tokens get the same plain 404', async () => {
		const { admin, machineId } = await setUp();
		const { token } = await linkFor(admin, machineId);
		const wrong = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
		for (const attempt of [wrong, 'nope']) {
			expect(loadPage(attempt, jar(), randomAddress())).toMatchObject({
				kind: 'error',
				status: 404,
				message: 'This link has ended.'
			});
		}
	});

	it('SL9: after 10 failures an address is refused (429) even with a valid token; others are not', async () => {
		const { admin, machineId } = await setUp();
		const { token } = await linkFor(admin, machineId);
		const address = randomAddress();
		for (let index = 0; index < SHARE_LINK_LIMIT.failures; index += 1) {
			loadPage(`${'x'.repeat(42)}${String(index % 10)}`, jar(), address);
		}
		expect(loadPage(token, jar(), address)).toMatchObject({ kind: 'error', status: 429 });
		expect(loadPage(token, jar(), randomAddress())).toMatchObject({ kind: 'loaded' });
	});

	it('SL10: guest requests need the guest cookie for the same link', async () => {
		const { admin, machineId } = await setUp();
		const first = await linkFor(admin, machineId);
		const second = await linkFor(admin, machineId);
		const address = randomAddress();
		const cookies = jar();
		loadPage(first.token, cookies, address);
		const status = async (token: string, jarToUse: Cookies) =>
			(
				await statusGet(
					guestEvent(
						`/s/${token}/status`,
						'GET',
						token,
						jarToUse,
						address,
						undefined
					) as Parameters<typeof statusGet>[0]
				)
			).status;
		expect(await status(first.token, cookies)).toBe(200);
		expect(await status(first.token, jar())).toBe(404);
		// The first link's cookie does not open the second link.
		expect(await status(second.token, cookies)).toBe(404);
	});

	it('SL20: the guest must give a name; the session records it with the address and browser from the request', async () => {
		const { admin, machineId } = await setUp();
		const peer: LivePeer = { send: () => undefined, close: () => undefined };
		agentConnected(machineId, peer);
		const { token, linkId } = await linkFor(admin, machineId);
		try {
			const address = randomAddress();
			const cookies = jar();
			loadPage(token, cookies, address);
			const post = (body: unknown) =>
				sessionPost(
					guestEvent(`/s/${token}/session`, 'POST', token, cookies, address, body) as Parameters<
						typeof sessionPost
					>[0]
				);
			expect((await post({ mode: 'watch', name: '   ', company: '' })).status).toBe(400);
			expect((await post({ mode: 'watch', company: 'Acme' })).status).toBe(400);
			const response = await post({ mode: 'watch', name: '  Alex Smith ', company: ' Acme ' });
			expect(response.status).toBe(200);
			const opened = listAudit(database, 500).find(
				(entry) => entry.kind === 'session-opened' && entry.detail['share link'] === linkId
			);
			expect(opened?.detail).toMatchObject({
				'says they are': 'Alex Smith',
				company: 'Acme',
				from: address,
				browser: 'Guest browser'
			});
		} finally {
			for (const sessionId of sessionRelay().sessionsOf(linkId)) {
				sessionRelay().end(sessionId, 'closed', 'The test ended.');
			}
			agentDisconnected(machineId, peer);
		}
	});
});
