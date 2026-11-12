import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import {
	createShareLinkRequestSchema,
	guestSessionRequestSchema
} from '#lib/schemas/share-links/share-links.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { shareLinks } from '../../database/schema.ts';
import { setGroupMembers } from '../access/groups.ts';
import { agentConnected, agentDisconnected, type LivePeer } from '../agents/live-agents.ts';
import { listAudit } from '../audit/audit.ts';
import { removeMachine } from '../machines/machine-views.ts';
import { updateSetting } from '../settings/settings.ts';
import { createRelay, RELAY_LIMITS } from '../sessions/relay.ts';
import { disableUser, toConsoleUser } from '../users/users.ts';
import { guestDesktopTerms, openGuestDesktop } from './guest-sessions.ts';
import {
	auditGuestOpened,
	createShareLink,
	endShareLink,
	listAllActiveShareLinks,
	listMachineShareLinks,
	resolveShareToken,
	sweepShareLinks,
	type GuestGrant
} from './share-links.ts';

const SECRETS_KEY = Buffer.alloc(32, 5);
const GUEST = { name: 'Alex Smith', company: 'Acme' };
const GUEST_CLIENT = { ip: '203.0.113.5', userAgent: 'Firefox' };
const HOUR = 60 * 60_000;
const WATCH = {
	recipient: 'Dave, Acme Printers',
	duration: '1h',
	control: false,
	files: false
} as const;
const CONTROL = { ...WATCH, control: true } as const;

const connected: { machineId: string; peer: LivePeer }[] = [];

afterEach(() => {
	for (const { machineId, peer } of connected.splice(0)) {
		agentDisconnected(machineId, peer);
	}
});

function connect(machineId: string): ServerSocketMessage[] {
	const sent: ServerSocketMessage[] = [];
	const peer: LivePeer = { send: (message) => sent.push(message), close: () => undefined };
	agentConnected(machineId, peer);
	connected.push({ machineId, peer });
	return sent;
}

async function setUp() {
	const database = testDatabase();
	const adminRow = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const admin = toConsoleUser(adminRow);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	const kim = toConsoleUser(
		await addTestUser(database, { email: 'kim@example.com', role: 'member', password: null })
	);
	const machineId = enrolFakeAgent(database, NOW).machineId;
	const otherMachineId = enrolFakeAgent(database, NOW).machineId;
	// Pat may watch and share, but not control or use files; Kim may only see the machine.
	const patAccess = grantAccess(database, {
		adminId: admin.id,
		name: 'Sharers',
		memberIds: [pat.id],
		machineIds: [machineId],
		permissions: ['view', 'desktop-view', 'share-links'],
		consent: 'unattended'
	});
	grantAccess(database, {
		adminId: admin.id,
		name: 'Viewers',
		memberIds: [kim.id],
		machineIds: [machineId],
		permissions: ['view', 'desktop-view'],
		consent: 'unattended'
	});
	const relay = createRelay(RELAY_LIMITS);
	return { database, admin, pat, kim, machineId, otherMachineId, patAccess, relay };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

function created(result: ReturnType<typeof createShareLink>) {
	if (result.kind !== 'created') throw new Error(result.message);
	return result;
}

function grantOf(setup: Setup, token: string, now: number): GuestGrant {
	const resolved = resolveShareToken(setup.database, setup.relay, token, now);
	if (resolved.kind !== 'active') throw new Error('The link should be active');
	return resolved.grant;
}

function auditKinds(setup: Setup): string[] {
	return listAudit(setup.database, 100).map((entry) => entry.kind);
}

describe('making a link (SL1–SL4, SL16)', () => {
	it('SL1: the token is 32 random bytes, only its SHA-256 is stored, and it appears once', async () => {
		const setup = await setUp();
		const result = created(
			createShareLink(setup.database, setup.admin, setup.machineId, WATCH, NOW)
		);
		expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(result.token, 'base64url')).toHaveLength(32);
		const row = setup.database.select().from(shareLinks).get();
		expect(row?.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
		expect(JSON.stringify(row)).not.toContain(result.token);
		expect(JSON.stringify(listAudit(setup.database, 100))).not.toContain(result.token);
		expect(JSON.stringify(result.link)).not.toContain(result.token);
		const again = created(
			createShareLink(setup.database, setup.admin, setup.machineId, WATCH, NOW)
		);
		expect(again.token).not.toBe(result.token);
	});

	it('SL2: needs share-links on the machine; a hidden machine is 404; nothing is stored', async () => {
		const setup = await setUp();
		expect(createShareLink(setup.database, setup.kim, setup.machineId, WATCH, NOW)).toMatchObject({
			kind: 'refused',
			status: 403
		});
		expect(
			createShareLink(setup.database, setup.pat, setup.otherMachineId, WATCH, NOW)
		).toMatchObject({ kind: 'refused', status: 404 });
		expect(
			createShareLink(setup.database, setup.pat, crypto.randomUUID(), WATCH, NOW)
		).toMatchObject({ kind: 'refused', status: 404 });
		expect(setup.database.select().from(shareLinks).all()).toEqual([]);
		expect(
			created(createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW)).link
		).toMatchObject({ recipient: 'Dave, Acme Printers', permissions: ['desktop-view'] });
	});

	it('SL3: a link carries only what its creator holds; watching is always on; never a terminal', async () => {
		const setup = await setUp();
		expect(createShareLink(setup.database, setup.pat, setup.machineId, CONTROL, NOW)).toMatchObject(
			{
				kind: 'refused',
				status: 403
			}
		);
		expect(
			createShareLink(setup.database, setup.pat, setup.machineId, { ...WATCH, files: true }, NOW)
		).toMatchObject({ kind: 'refused', status: 403 });
		const admin = created(
			createShareLink(
				setup.database,
				setup.admin,
				setup.machineId,
				{ ...CONTROL, files: true },
				NOW
			)
		);
		expect(admin.link.permissions).toEqual(['desktop-view', 'desktop-control', 'files']);
		const parsed = createShareLinkRequestSchema.safeParse({ ...WATCH, terminal: true });
		expect(parsed.success && 'terminal' in parsed.data).toBe(false);
	});

	it('SL4: only 15 min, 1 h, 4 h, 8 h, 24 h, 48 h and 7 days; 7 days is the most', async () => {
		const setup = await setUp();
		for (const duration of ['15m', '1h', '4h', '8h', '24h', '48h', '7d']) {
			expect(createShareLinkRequestSchema.safeParse({ ...WATCH, duration }).success).toBe(true);
		}
		for (const duration of ['30m', '25h', '72h', '8d', '14d', '', 3600]) {
			expect(createShareLinkRequestSchema.safeParse({ ...WATCH, duration }).success).toBe(false);
		}
		const lasting = (duration: '24h' | '48h' | '7d') =>
			Date.parse(
				created(
					createShareLink(setup.database, setup.admin, setup.machineId, { ...WATCH, duration }, NOW)
				).link.expiresIso
			) - NOW;
		expect(lasting('24h')).toBe(24 * HOUR);
		expect(lasting('48h')).toBe(48 * HOUR);
		expect(lasting('7d')).toBe(7 * 24 * HOUR);
	});

	it('refuses labels that are empty, too long or have control characters', () => {
		for (const recipient of ['', '   ', 'x'.repeat(81), 'Dave\nFake line', 'Dave\u0007']) {
			expect(createShareLinkRequestSchema.safeParse({ ...WATCH, recipient }).success).toBe(false);
		}
	});

	it('SL20: a guest must give a name (1–80 characters) and may give a company (0–80), plain text, trimmed', () => {
		const parse = (body: Record<string, unknown>) =>
			guestSessionRequestSchema.safeParse({ mode: 'watch', ...body });
		expect(parse({ name: '  Alex Smith  ', company: '  Acme ' })).toMatchObject({
			success: true,
			data: { mode: 'watch', name: 'Alex Smith', company: 'Acme' }
		});
		expect(parse({ name: 'Alex', company: '' }).success).toBe(true);
		expect(parse({ name: 'x'.repeat(80), company: 'y'.repeat(80) }).success).toBe(true);
		for (const name of ['', '   ', 'x'.repeat(81), 'Alex\nFake line', 'Alex\u0007', 42]) {
			expect(parse({ name, company: '' }).success).toBe(false);
		}
		for (const company of ['y'.repeat(81), 'Acme\r\nFake', undefined]) {
			expect(parse({ name: 'Alex', company }).success).toBe(false);
		}
	});

	it('SL16: at most 20 active links per machine', async () => {
		const setup = await setUp();
		for (let index = 0; index < 20; index += 1) {
			created(createShareLink(setup.database, setup.admin, setup.machineId, WATCH, NOW));
		}
		expect(createShareLink(setup.database, setup.admin, setup.machineId, WATCH, NOW)).toMatchObject(
			{
				kind: 'refused',
				status: 409
			}
		);
		// An ended one makes room.
		const first = listMachineShareLinks(setup.database, setup.admin, setup.machineId, NOW);
		const id = first.kind === 'ok' ? (first.links[0]?.id ?? '') : '';
		expect(endShareLink(setup.database, setup.relay, setup.admin, id, NOW)).toEqual({
			kind: 'ended'
		});
		expect(createShareLink(setup.database, setup.admin, setup.machineId, WATCH, NOW).kind).toBe(
			'created'
		);
	});
});

describe('using a link (SL5, SL6)', () => {
	it('SL5: a valid token gives the grant; wrong, malformed, expired or ended tokens all say ended', async () => {
		const setup = await setUp();
		const { token, link } = created(
			createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW)
		);
		expect(grantOf(setup, token, NOW + 1000)).toMatchObject({
			linkId: link.id,
			machineId: setup.machineId,
			recipient: 'Dave, Acme Printers',
			permissions: ['desktop-view'],
			sharedBy: { id: setup.pat.id, name: 'pat' }
		});
		const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
		for (const attempt of [wrong, 'short', `${token}x`, '../../etc/passwd', '']) {
			expect(resolveShareToken(setup.database, setup.relay, attempt, NOW)).toEqual({
				kind: 'ended'
			});
		}
		expect(resolveShareToken(setup.database, setup.relay, token, NOW + HOUR)).toEqual({
			kind: 'ended'
		});
		const second = created(createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW));
		endShareLink(setup.database, setup.relay, setup.pat, second.link.id, NOW);
		expect(resolveShareToken(setup.database, setup.relay, second.token, NOW + 1)).toEqual({
			kind: 'ended'
		});
	});

	it('SL6: the link ends for good when its creator loses share-links on the machine', async () => {
		const setup = await setUp();
		const { token } = created(
			createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW)
		);
		setGroupMembers(setup.database, 'user', setup.admin.id, setup.patAccess.userGroupId, [], NOW);
		expect(resolveShareToken(setup.database, setup.relay, token, NOW + 1)).toEqual({
			kind: 'ended'
		});
		const ended = listAudit(setup.database, 100).find((entry) => entry.kind === 'share-link-ended');
		expect(ended?.detail['why']).toBe(
			'The person who shared it no longer has that access to this machine.'
		);
		// Giving the access back does not bring the link back.
		setGroupMembers(
			setup.database,
			'user',
			setup.admin.id,
			setup.patAccess.userGroupId,
			[setup.pat.id],
			NOW
		);
		expect(resolveShareToken(setup.database, setup.relay, token, NOW + 2)).toEqual({
			kind: 'ended'
		});
	});

	it('SL6: the link ends when its creator is disabled, or the machine is removed', async () => {
		const setup = await setUp();
		const byPat = created(createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW));
		const byAdmin = created(
			createShareLink(setup.database, setup.admin, setup.machineId, WATCH, NOW)
		);
		expect(disableUser(setup.database, setup.admin.id, setup.pat.id, NOW).kind).toBe('done');
		expect(resolveShareToken(setup.database, setup.relay, byPat.token, NOW + 1)).toEqual({
			kind: 'ended'
		});
		expect(grantOf(setup, byAdmin.token, NOW + 1).linkId).toBe(byAdmin.link.id);
		removeMachine(setup.database, setup.machineId, setup.admin.id, NOW);
		expect(resolveShareToken(setup.database, setup.relay, byAdmin.token, NOW + 2)).toEqual({
			kind: 'ended'
		});
	});

	it('SL6: a creator who loses only a permission the link carries ends it too', async () => {
		const setup = await setUp();
		const controller = toConsoleUser(
			await addTestUser(setup.database, { email: 'cy@example.com', role: 'member', password: null })
		);
		const access = grantAccess(setup.database, {
			adminId: setup.admin.id,
			name: 'Controllers',
			memberIds: [controller.id],
			machineIds: [setup.machineId],
			permissions: ['view', 'desktop-view', 'desktop-control', 'share-links'],
			consent: 'unattended'
		});
		const { token } = created(
			createShareLink(setup.database, controller, setup.machineId, CONTROL, NOW)
		);
		expect(grantOf(setup, token, NOW).permissions).toEqual(['desktop-view', 'desktop-control']);
		setGroupMembers(setup.database, 'user', setup.admin.id, access.userGroupId, [], NOW);
		grantAccess(setup.database, {
			adminId: setup.admin.id,
			name: 'Watchers again',
			memberIds: [controller.id],
			machineIds: [setup.machineId],
			permissions: ['view', 'desktop-view', 'share-links'],
			consent: 'unattended'
		});
		expect(resolveShareToken(setup.database, setup.relay, token, NOW + 1)).toEqual({
			kind: 'ended'
		});
	});
});

describe('ending a link (SL7, SL8)', () => {
	it('SL7: End now records who and when, and is audited; others are refused', async () => {
		const setup = await setUp();
		const { link } = created(
			createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW)
		);
		expect(endShareLink(setup.database, setup.relay, setup.kim, link.id, NOW)).toMatchObject({
			kind: 'refused',
			status: 403
		});
		expect(
			endShareLink(setup.database, setup.relay, setup.pat, crypto.randomUUID(), NOW)
		).toMatchObject({ kind: 'refused', status: 404 });
		expect(endShareLink(setup.database, setup.relay, setup.admin, link.id, NOW + 5)).toEqual({
			kind: 'ended'
		});
		const row = setup.database.select().from(shareLinks).get();
		expect(row?.endedAt?.getTime()).toBe(NOW + 5);
		expect(row?.endedBy).toBe(setup.admin.id);
		expect(endShareLink(setup.database, setup.relay, setup.admin, link.id, NOW + 6)).toMatchObject({
			kind: 'refused',
			status: 409
		});
		const entry = listAudit(setup.database, 100).find((each) => each.kind === 'share-link-ended');
		expect(entry).toMatchObject({ actorUserId: setup.admin.id, machineId: setup.machineId });
		expect(entry?.detail).toMatchObject({ for: 'Dave, Acme Printers', 'share link': link.id });
	});

	it('SL7: a link on a machine the person cannot see is 404, as if it did not exist', async () => {
		const setup = await setUp();
		const { link } = created(
			createShareLink(setup.database, setup.admin, setup.otherMachineId, WATCH, NOW)
		);
		expect(endShareLink(setup.database, setup.relay, setup.pat, link.id, NOW)).toMatchObject({
			kind: 'refused',
			status: 404,
			message: 'No share link with this id.'
		});
	});

	it('SL8: the sweep marks expired links ended, audits it once, and leaves live ones', async () => {
		const setup = await setUp();
		const short = created(
			createShareLink(
				setup.database,
				setup.pat,
				setup.machineId,
				{ ...WATCH, duration: '15m' },
				NOW
			)
		);
		const long = created(createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW));
		sweepShareLinks(setup.database, setup.relay, NOW + 16 * 60_000);
		sweepShareLinks(setup.database, setup.relay, NOW + 17 * 60_000);
		expect(auditKinds(setup).filter((kind) => kind === 'share-link-expired')).toHaveLength(1);
		const rows = setup.database.select().from(shareLinks).all();
		const shortRow = rows.find((row) => row.id === short.link.id);
		expect(shortRow?.endedAt?.getTime()).toBe(Date.parse(short.link.expiresIso));
		expect(shortRow?.endedBy).toBeNull();
		expect(rows.find((row) => row.id === long.link.id)?.endedAt).toBeNull();
	});

	it('SL8: the sweep ends links whose creator was disabled', async () => {
		const setup = await setUp();
		created(createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW));
		disableUser(setup.database, setup.admin.id, setup.pat.id, NOW);
		sweepShareLinks(setup.database, setup.relay, NOW + 1);
		expect(setup.database.select().from(shareLinks).get()?.endedAt).not.toBeNull();
		expect(auditKinds(setup)).toContain('share-link-ended');
	});
});

describe('the guest on the desktop (SL11, SL12)', () => {
	it('SL11: the ticket names only the link permissions, asks nobody, always notifies, and control only when allowed', async () => {
		const setup = await setUp();
		const watchOnly = grantOf(
			setup,
			created(createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW)).token,
			NOW
		);
		expect(guestDesktopTerms(watchOnly, 'control')).toEqual({
			permissions: ['desktop-view'],
			purpose: { kind: 'desktop', consent: 'unattended', notice: true }
		});
		const control = grantOf(
			setup,
			created(createShareLink(setup.database, setup.admin, setup.machineId, CONTROL, NOW)).token,
			NOW
		);
		expect(guestDesktopTerms(control, 'control')).toEqual({
			permissions: ['desktop-view', 'desktop-control'],
			purpose: { kind: 'desktop', consent: 'unattended', notice: true }
		});
		expect(guestDesktopTerms(control, 'watch').permissions).toEqual(['desktop-view']);
	});

	it('SL12: a guest connects without a consent prompt, with the notice on even when the setting is off', async () => {
		const setup = await setUp();
		updateSetting(setup.database, setup.admin.id, 'connectedNotice', false, NOW);
		const sent = connect(setup.machineId);
		const grant = grantOf(
			setup,
			created(createShareLink(setup.database, setup.admin, setup.machineId, CONTROL, NOW)).token,
			NOW
		);
		const result = openGuestDesktop(
			setup.database,
			setup.relay,
			SECRETS_KEY,
			grant,
			{ mode: 'control', identity: GUEST },
			GUEST_CLIENT,
			NOW
		);
		expect(result.kind).toBe('opened');
		const open = sent.find((message) => message.type === 'session-open');
		if (open?.type !== 'session-open') throw new Error('Expected a session-open');
		const ticket: unknown = JSON.parse(Buffer.from(open.ticket, 'base64').toString('utf8'));
		expect(ticket).toMatchObject({
			user: { id: grant.linkId, name: 'Alex Smith (Acme) via a link from ada' },
			purpose: { kind: 'desktop', consent: 'unattended', notice: true }
		});
	});

	it('a watch-only link refuses a request to control', async () => {
		const setup = await setUp();
		const grant = grantOf(
			setup,
			created(createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW)).token,
			NOW
		);
		expect(
			openGuestDesktop(
				setup.database,
				setup.relay,
				SECRETS_KEY,
				grant,
				{ mode: 'control', identity: GUEST },
				GUEST_CLIENT,
				NOW
			)
		).toMatchObject({ kind: 'refused', status: 403 });
	});
});

describe('audit and lists (SL14, SL15)', () => {
	it('SL14: created and opened are audited with who, what, address and browser', async () => {
		const setup = await setUp();
		const { token, link } = created(
			createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW)
		);
		auditGuestOpened(
			setup.database,
			grantOf(setup, token, NOW),
			{ ip: '198.51.100.7', userAgent: 'Firefox' },
			NOW
		);
		const entries = listAudit(setup.database, 100);
		expect(entries.find((entry) => entry.kind === 'share-link-created')).toMatchObject({
			actorUserId: setup.pat.id,
			machineId: setup.machineId,
			detail: {
				for: 'Dave, Acme Printers',
				allows: 'Watch desktop',
				lasts: '1 hour',
				'share link': link.id
			}
		});
		expect(entries.find((entry) => entry.kind === 'share-link-opened')).toMatchObject({
			actorUserId: null,
			machineId: setup.machineId,
			detail: {
				guest: 'Dave, Acme Printers (shared by pat)',
				from: '198.51.100.7',
				browser: 'Firefox'
			}
		});
	});

	it('SL15: a machine lists its active links to people who may share it; admins see every one', async () => {
		const setup = await setUp();
		created(createShareLink(setup.database, setup.pat, setup.machineId, WATCH, NOW));
		created(createShareLink(setup.database, setup.admin, setup.otherMachineId, CONTROL, NOW));
		const forPat = listMachineShareLinks(setup.database, setup.pat, setup.machineId, NOW);
		expect(forPat).toMatchObject({
			kind: 'ok',
			links: [{ recipient: 'Dave, Acme Printers', createdByName: 'pat' }],
			canTick: { control: false, files: false }
		});
		expect(listMachineShareLinks(setup.database, setup.kim, setup.machineId, NOW)).toMatchObject({
			kind: 'refused',
			status: 403
		});
		expect(
			listMachineShareLinks(setup.database, setup.pat, setup.otherMachineId, NOW)
		).toMatchObject({ kind: 'refused', status: 404 });
		expect(listMachineShareLinks(setup.database, setup.admin, setup.machineId, NOW)).toMatchObject({
			canTick: { control: true, files: true }
		});
		expect(listAllActiveShareLinks(setup.database, NOW)).toHaveLength(2);
		expect(listAllActiveShareLinks(setup.database, NOW + 2 * HOUR)).toHaveLength(0);
	});
});
