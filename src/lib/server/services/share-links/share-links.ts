import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { hasPermission, type Permission } from '#lib/domain/access/access.ts';
import type { OsFamily } from '#lib/domain/machines/machine.ts';
import {
	linkLabel,
	MAX_ACTIVE_LINKS_PER_MACHINE,
	shareDurationLabel,
	shareDurationMs,
	sharePermissionsFrom,
	sharePermissionsLabel,
	type GuestView,
	type ShareLinkLastUse,
	type ShareLinkPermission,
	type ShareLinkView
} from '#lib/domain/share-links/share-links.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import {
	storedSharePermissionsSchema,
	type CreateShareLinkRequest
} from '#lib/schemas/share-links/share-links.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { machines, shareLinks, users } from '../../database/schema.ts';
import { permissionsFor } from '../access/access.ts';
import { recordAudit } from '../audit/audit.ts';
import type { SignInClient } from '../auth/client.ts';
import { activeMachineBasics } from '../machines/machine-views.ts';
import type { Relay } from '../sessions/relay.ts';
import { findUserById, toConsoleUser } from '../users/users.ts';

/**
 * Share links (SPEC-SHARE-LINKS, docs/access-and-sign-in.md 3): someone
 * without an account may reach one machine for a limited time. A link is a
 * key: 32 random bytes, shown once, of which only the SHA-256 is kept. It
 * carries at most what its creator holds on that machine, and is checked
 * again on every use: when the creator is disabled or loses any of it, or
 * the machine is removed, the link ends for good (D2). Every permission
 * check goes through the access service.
 */

type ShareLinkRow = typeof shareLinks.$inferSelect;

/** base64url of 32 bytes: 43 characters, nothing else is ever looked up. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hashOf(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

function permissionsOf(row: ShareLinkRow): ShareLinkPermission[] {
	return storedSharePermissionsSchema.parse(JSON.parse(row.permissions));
}

/** Everything the link needs from its creator: `share-links`, and each of its own permissions. */
function neededFromCreator(permissions: readonly ShareLinkPermission[]): Permission[] {
	return ['share-links', ...permissions];
}

export type ShareRefusal = { kind: 'refused'; status: 400 | 403 | 404 | 409; message: string };

const NO_MACHINE: ShareRefusal = {
	kind: 'refused',
	status: 404,
	message: 'No machine with this id.'
};

/** The person may share this machine: they see it and hold `share-links` there. */
function sharerAccess(
	database: Queryable,
	user: ConsoleUser,
	machineId: string
):
	{ kind: 'ok'; machine: { name: string; osFamily: OsFamily }; held: Permission[] } | ShareRefusal {
	const grants = permissionsFor(database, user, machineId);
	const machine = activeMachineBasics(database, machineId);
	if (machine === undefined || !hasPermission(grants, 'view')) {
		return NO_MACHINE;
	}
	if (!hasPermission(grants, 'share-links')) {
		return {
			kind: 'refused',
			status: 403,
			message: "You don't have permission to share this machine."
		};
	}
	return { kind: 'ok', machine, held: grants.map((grant) => grant.permission) };
}

function viewOf(row: ShareLinkRow, machineName: string, createdByName: string): ShareLinkView {
	return {
		id: row.id,
		machineId: row.machineId,
		machineName,
		recipient: row.recipient,
		permissions: permissionsOf(row),
		createdByName,
		createdIso: row.createdAt.toISOString(),
		expiresIso: row.expiresAt.toISOString(),
		lastUse: lastUseOf(row)
	};
}

/** D17: the last guest session's typed name and company, address and time, once there was one. */
function lastUseOf(row: ShareLinkRow): ShareLinkLastUse {
	if (row.lastUsedAt === null || row.lastGuestName === null) {
		return { kind: 'never' };
	}
	return {
		kind: 'used',
		name: row.lastGuestName,
		company: row.lastGuestCompany ?? '',
		address: row.lastGuestAddress ?? '',
		atIso: row.lastUsedAt.toISOString()
	};
}

export type CreatedShareLink = { kind: 'created'; link: ShareLinkView; token: string };

/** SL1–SL4, SL16: a new link, its token shown this once. */
export function createShareLink(
	database: AppDatabase,
	user: ConsoleUser,
	machineId: string,
	request: CreateShareLinkRequest,
	now: number
): CreatedShareLink | ShareRefusal {
	const access = sharerAccess(database, user, machineId);
	if (access.kind === 'refused') {
		return access;
	}
	const permissions = sharePermissionsFrom(request);
	const missing = permissions.filter((permission) => !access.held.includes(permission));
	if (missing.length > 0) {
		return {
			kind: 'refused',
			status: 403,
			message: `You can only share what you may do yourself on this machine (not: ${sharePermissionsLabel(missing)}).`
		};
	}
	const active = activeRows(database, machineId, now);
	if (active.length >= MAX_ACTIVE_LINKS_PER_MACHINE) {
		return {
			kind: 'refused',
			status: 409,
			message: `This machine already has ${MAX_ACTIVE_LINKS_PER_MACHINE} active share links. End one first.`
		};
	}
	const token = randomBytes(32).toString('base64url');
	const row: ShareLinkRow = {
		id: crypto.randomUUID(),
		machineId,
		tokenHash: hashOf(token),
		recipient: request.recipient,
		permissions: JSON.stringify(permissions),
		createdBy: user.id,
		createdAt: new Date(now),
		expiresAt: new Date(now + shareDurationMs(request.duration)),
		endedAt: null,
		endedBy: null,
		lastGuestName: null,
		lastGuestCompany: null,
		lastGuestAddress: null,
		lastUsedAt: null
	};
	database.insert(shareLinks).values(row).run();
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: user.id },
			kind: 'share-link-created',
			target: access.machine.name,
			machineId,
			detail: {
				for: row.recipient,
				allows: sharePermissionsLabel(permissions),
				lasts: shareDurationLabel(request.duration),
				ends: row.expiresAt.toISOString(),
				'share link': row.id
			}
		},
		now
	);
	return { kind: 'created', link: viewOf(row, access.machine.name, user.name), token };
}

function activeRows(database: Queryable, machineId: string, now: number): ShareLinkRow[] {
	return database
		.select()
		.from(shareLinks)
		.where(
			and(
				eq(shareLinks.machineId, machineId),
				isNull(shareLinks.endedAt),
				gt(shareLinks.expiresAt, new Date(now))
			)
		)
		.orderBy(asc(shareLinks.expiresAt))
		.all();
}

export type MachineShareLinks = {
	kind: 'ok';
	links: ShareLinkView[];
	canTick: { control: boolean; files: boolean };
};

/** SL15: a machine's active links, for people who may share it, and what they may tick. */
export function listMachineShareLinks(
	database: AppDatabase,
	user: ConsoleUser,
	machineId: string,
	now: number
): MachineShareLinks | ShareRefusal {
	const access = sharerAccess(database, user, machineId);
	if (access.kind === 'refused') {
		return access;
	}
	const rows = database
		.select({ link: shareLinks, createdByName: users.name })
		.from(shareLinks)
		.innerJoin(users, eq(users.id, shareLinks.createdBy))
		.where(
			and(
				eq(shareLinks.machineId, machineId),
				isNull(shareLinks.endedAt),
				gt(shareLinks.expiresAt, new Date(now))
			)
		)
		.orderBy(asc(shareLinks.expiresAt))
		.all();
	return {
		kind: 'ok',
		links: rows.map(({ link, createdByName }) => viewOf(link, access.machine.name, createdByName)),
		canTick: {
			control: access.held.includes('desktop-control') && access.held.includes('desktop-view'),
			files: access.held.includes('files')
		}
	};
}

/** SL15: every active link on the server, for the admins' list (the route is admins only). */
export function listAllActiveShareLinks(database: Queryable, now: number): ShareLinkView[] {
	return database
		.select({ link: shareLinks, createdByName: users.name, machineName: machines.name })
		.from(shareLinks)
		.innerJoin(users, eq(users.id, shareLinks.createdBy))
		.innerJoin(machines, eq(machines.id, shareLinks.machineId))
		.where(
			and(
				isNull(shareLinks.endedAt),
				gt(shareLinks.expiresAt, new Date(now)),
				isNull(machines.removedAt)
			)
		)
		.orderBy(asc(shareLinks.expiresAt))
		.all()
		.map(({ link, createdByName, machineName }) => viewOf(link, machineName, createdByName));
}

/** How a link stopped, for its audit entry and its sessions. */
type EndCause =
	| { kind: 'ended-by'; user: ConsoleUser }
	| { kind: 'expired' }
	| { kind: 'creator-lost-access'; reason: string };

/** Marks the link ended (once), audits why, and ends its running session at once. */
function endLink(
	database: AppDatabase,
	relay: Relay,
	row: ShareLinkRow,
	cause: EndCause,
	now: number
): void {
	const endedAt = cause.kind === 'expired' ? row.expiresAt : new Date(now);
	const changed = database
		.update(shareLinks)
		.set({ endedAt, endedBy: cause.kind === 'ended-by' ? cause.user.id : null })
		.where(and(eq(shareLinks.id, row.id), isNull(shareLinks.endedAt)))
		.run();
	if (changed.changes > 0) {
		const machineName =
			database
				.select({ name: machines.name })
				.from(machines)
				.where(eq(machines.id, row.machineId))
				.get()?.name ?? row.machineId;
		recordAudit(
			database,
			{
				actor:
					cause.kind === 'ended-by' ? { kind: 'user', userId: cause.user.id } : { kind: 'system' },
				kind: cause.kind === 'expired' ? 'share-link-expired' : 'share-link-ended',
				target: machineName,
				machineId: row.machineId,
				detail: {
					for: row.recipient,
					'share link': row.id,
					...(cause.kind === 'creator-lost-access' ? { why: cause.reason } : {})
				}
			},
			now
		);
	}
	for (const sessionId of relay.sessionsOf(row.id)) {
		relay.end(sessionId, 'share-link-ended', 'The share link ended.');
	}
}

export type EndShareLinkResult = { kind: 'ended' } | ShareRefusal;

/** SL7: End now, by anyone who may share the link's machine (admins included). */
export function endShareLink(
	database: AppDatabase,
	relay: Relay,
	user: ConsoleUser,
	linkId: string,
	now: number
): EndShareLinkResult {
	const row = database.select().from(shareLinks).where(eq(shareLinks.id, linkId)).get();
	const notFound: ShareRefusal = {
		kind: 'refused',
		status: 404,
		message: 'No share link with this id.'
	};
	if (row === undefined) {
		return notFound;
	}
	const access = sharerAccess(database, user, row.machineId);
	if (access.kind === 'refused') {
		return access.status === 404 ? notFound : access;
	}
	if (row.endedAt !== null || row.expiresAt.getTime() <= now) {
		return { kind: 'refused', status: 409, message: 'This share link has already ended.' };
	}
	endLink(database, relay, row, { kind: 'ended-by', user }, now);
	return { kind: 'ended' };
}

/** What a valid token grants: one machine, these permissions, until then. */
export type GuestGrant = {
	linkId: string;
	machineId: string;
	machineName: string;
	osFamily: OsFamily;
	recipient: string;
	permissions: ShareLinkPermission[];
	sharedBy: { id: string; name: string };
	expiresAt: number;
};

export function guestViewOf(grant: GuestGrant): GuestView {
	return {
		machineName: grant.machineName,
		osFamily: grant.osFamily,
		recipient: grant.recipient,
		sharedByName: grant.sharedBy.name,
		permissions: grant.permissions,
		expiresIso: new Date(grant.expiresAt).toISOString()
	};
}

type CreatorCheck =
	| { kind: 'ok'; machine: { name: string; osFamily: OsFamily }; creator: ConsoleUser }
	| { kind: 'lost'; reason: string };

/** D2: the creator is enabled and still holds everything the link carries; the machine is enrolled. */
function creatorStillAllows(database: Queryable, row: ShareLinkRow): CreatorCheck {
	const machine = activeMachineBasics(database, row.machineId);
	if (machine === undefined) {
		return { kind: 'lost', reason: 'The machine was removed.' };
	}
	const creatorRow = findUserById(database, row.createdBy);
	if (creatorRow?.disabledAt !== null) {
		return { kind: 'lost', reason: 'The person who shared it was disabled.' };
	}
	const creator = toConsoleUser(creatorRow);
	const grants = permissionsFor(database, creator, row.machineId);
	const lacking = neededFromCreator(permissionsOf(row)).filter(
		(permission) => !hasPermission(grants, permission)
	);
	if (lacking.length > 0) {
		return {
			kind: 'lost',
			reason: 'The person who shared it no longer has that access to this machine.'
		};
	}
	return { kind: 'ok', machine, creator };
}

export type GuestResolution = { kind: 'active'; grant: GuestGrant } | { kind: 'ended' };

/**
 * SL5, SL6: the link behind a token, re-checked now. A wrong, malformed, expired or ended
 * token is `ended`, all alike. A link whose creator lost access is ended here and then.
 * The lookup is by the token's SHA-256 (the guesser cannot choose the hash, so the index
 * leaks nothing), and the stored hash is compared again in constant time.
 */
export function resolveShareToken(
	database: AppDatabase,
	relay: Relay,
	token: string,
	now: number
): GuestResolution {
	if (!TOKEN_PATTERN.test(token)) {
		return { kind: 'ended' };
	}
	const hash = hashOf(token);
	const row = database.select().from(shareLinks).where(eq(shareLinks.tokenHash, hash)).get();
	if (row === undefined) {
		return { kind: 'ended' };
	}
	const stored = Buffer.from(row.tokenHash, 'utf8');
	const given = Buffer.from(hash, 'utf8');
	if (stored.length !== given.length || !timingSafeEqual(stored, given)) {
		return { kind: 'ended' };
	}
	if (row.endedAt !== null) {
		return { kind: 'ended' };
	}
	if (row.expiresAt.getTime() <= now) {
		endLink(database, relay, row, { kind: 'expired' }, now);
		return { kind: 'ended' };
	}
	const check = creatorStillAllows(database, row);
	if (check.kind === 'lost') {
		endLink(database, relay, row, { kind: 'creator-lost-access', reason: check.reason }, now);
		return { kind: 'ended' };
	}
	return {
		kind: 'active',
		grant: {
			linkId: row.id,
			machineId: row.machineId,
			machineName: check.machine.name,
			osFamily: check.machine.osFamily,
			recipient: row.recipient,
			permissions: permissionsOf(row),
			sharedBy: { id: check.creator.id, name: check.creator.name },
			expiresAt: row.expiresAt.getTime()
		}
	};
}

/** SL14: the guest page was loaded by a browser without this link's guest cookie. */
export function auditGuestOpened(
	database: Queryable,
	grant: GuestGrant,
	client: SignInClient,
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'system' },
			kind: 'share-link-opened',
			target: grant.machineName,
			machineId: grant.machineId,
			detail: {
				guest: linkLabel(grant.recipient, grant.sharedBy.name),
				'share link': grant.linkId,
				from: client.ip,
				browser: client.userAgent
			}
		},
		now
	);
}

/**
 * SL8, D7: links that ran out are marked ended (audited once) and their sessions end; links
 * whose creator lost access end too. Runs every few seconds, and at a session's exact end.
 */
export function sweepShareLinks(database: AppDatabase, relay: Relay, now: number): void {
	const active = database.select().from(shareLinks).where(isNull(shareLinks.endedAt)).all();
	for (const row of active) {
		if (row.expiresAt.getTime() <= now) {
			endLink(database, relay, row, { kind: 'expired' }, now);
			continue;
		}
		const check = creatorStillAllows(database, row);
		if (check.kind === 'lost') {
			endLink(database, relay, row, { kind: 'creator-lost-access', reason: check.reason }, now);
		}
	}
}

/** How often the sweep runs (D7). */
const SWEEP_EVERY_MS = 10_000;

/** Starts the sweep; the server runs it for as long as it runs. */
export function scheduleShareLinkSweeps(
	database: AppDatabase,
	relay: Relay,
	onError: (error: unknown) => void
): void {
	const timer = setInterval(() => {
		try {
			sweepShareLinks(database, relay, Date.now());
		} catch (caught) {
			onError(caught);
		}
	}, SWEEP_EVERY_MS);
	timer.unref();
}
