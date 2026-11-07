import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { ConsoleRole, ConsoleUser, UserView } from '#lib/domain/users/user.ts';
import { identityProviders, userIdentities, users } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { endSessionsForUser } from '../auth/sessions.ts';
import { hashPassword } from '../auth/passwords.ts';

/** People who can sign in (SPEC-SIGN-IN S1, S12). Emails are kept in lower case. */
export type UserRow = typeof users.$inferSelect;

export function hasUsers(database: Queryable): boolean {
	return database.select({ id: users.id }).from(users).limit(1).get() !== undefined;
}

export function findUserById(database: Queryable, id: string): UserRow | undefined {
	return database.select().from(users).where(eq(users.id, id)).get();
}

export function findUserByEmail(database: Queryable, email: string): UserRow | undefined {
	return database.select().from(users).where(eq(users.email, email.toLowerCase())).get();
}

export function toConsoleUser(row: UserRow): ConsoleUser {
	return { id: row.id, name: row.name, email: row.email, role: row.role };
}

export type NewUser = {
	name: string;
	email: string;
	role: ConsoleRole;
	passwordHash: string | null;
};

/** Inserts a user. The caller audits it (setup, an admin, or a provider's auto-create). */
export function insertUser(database: Queryable, user: NewUser, now: number): UserRow {
	const row: UserRow = {
		id: crypto.randomUUID(),
		name: user.name,
		email: user.email.toLowerCase(),
		role: user.role,
		passwordHash: user.passwordHash,
		disabledAt: null,
		createdAt: new Date(now),
		lastSignInAt: null
	};
	database.insert(users).values(row).run();
	return row;
}

export function markSignedIn(database: Queryable, userId: string, now: number): void {
	database
		.update(users)
		.set({ lastSignInAt: new Date(now) })
		.where(eq(users.id, userId))
		.run();
}

/** Every user for the Users page, admins first, then by name. */
export function listUsers(database: Queryable): UserView[] {
	const rows = database.select().from(users).orderBy(users.role, users.name).all();
	const links = database
		.select({ userId: userIdentities.userId, providerName: identityProviders.name })
		.from(userIdentities)
		.innerJoin(identityProviders, eq(identityProviders.id, userIdentities.providerId))
		.all();
	return rows.map((row) => toUserView(row, links));
}

function toUserView(row: UserRow, links: { userId: string; providerName: string }[]): UserView {
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		role: row.role,
		status:
			row.disabledAt === null
				? { kind: 'active' }
				: { kind: 'disabled', disabledIso: row.disabledAt.toISOString() },
		hasPassword: row.passwordHash !== null,
		providerNames: links.filter((link) => link.userId === row.id).map((link) => link.providerName),
		lastSignIn:
			row.lastSignInAt === null
				? { kind: 'never' }
				: { kind: 'at', iso: row.lastSignInAt.toISOString() },
		createdIso: row.createdAt.toISOString()
	};
}

function userView(database: Queryable, id: string): UserView {
	const row = findUserById(database, id);
	if (row === undefined) {
		throw new Error(`No user ${id}`);
	}
	const links = database
		.select({ userId: userIdentities.userId, providerName: identityProviders.name })
		.from(userIdentities)
		.innerJoin(identityProviders, eq(identityProviders.id, userIdentities.providerId))
		.where(eq(userIdentities.userId, id))
		.all();
	return toUserView(row, links);
}

/** Names for the Activity page, by id. */
export function userNames(database: Queryable, ids: string[]): Map<string, string> {
	if (ids.length === 0) {
		return new Map();
	}
	const rows = database
		.select({ id: users.id, name: users.name })
		.from(users)
		.where(inArray(users.id, ids))
		.all();
	return new Map(rows.map((row) => [row.id, row.name]));
}

export type UserChange =
	{ kind: 'done'; user: UserView } | { kind: 'refused'; status: 404 | 409; message: string };

/** An admin adds (invites) someone. With no password they sign in through a provider. */
export async function addUser(
	database: AppDatabase,
	actorUserId: string,
	input: { name: string; email: string; role: ConsoleRole; password: string | null },
	now: number
): Promise<UserChange> {
	const passwordHash = input.password === null ? null : await hashPassword(input.password);
	return database.transaction((transaction) => {
		if (findUserByEmail(transaction, input.email) !== undefined) {
			return {
				kind: 'refused',
				status: 409,
				message: 'Someone with that email is already a user.'
			};
		}
		const row = insertUser(
			transaction,
			{ name: input.name, email: input.email, role: input.role, passwordHash },
			now
		);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'user-added',
				target: row.email,
				detail: { role: row.role, password: passwordHash === null ? 'none' : 'set' }
			},
			now
		);
		return { kind: 'done', user: userView(transaction, row.id) };
	});
}

/** Active admins other than `exceptUserId`: the last-admin protection (S12). */
function otherActiveAdmins(database: Queryable, exceptUserId: string): number {
	const row = database
		.select({ total: count() })
		.from(users)
		.where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, exceptUserId)))
		.get();
	return row?.total ?? 0;
}

/**
 * An admin changes someone's name and email (S12). The email of someone
 * linked to a provider is the provider's to change, so it is refused here.
 */
export function setDetails(
	database: AppDatabase,
	actorUserId: string,
	userId: string,
	details: { name: string; email: string },
	now: number
): UserChange {
	return database.transaction((transaction) => {
		const row = findUserById(transaction, userId);
		if (row === undefined) {
			return { kind: 'refused', status: 404, message: 'No user with this id.' };
		}
		const email = details.email.toLowerCase();
		if (email !== row.email) {
			const linked = transaction
				.select({ id: userIdentities.id })
				.from(userIdentities)
				.where(eq(userIdentities.userId, userId))
				.get();
			if (linked !== undefined) {
				return {
					kind: 'refused',
					status: 409,
					message: 'This person signs in through a provider, which keeps their email.'
				};
			}
			const taken = findUserByEmail(transaction, email);
			if (taken !== undefined) {
				return {
					kind: 'refused',
					status: 409,
					message: 'Someone with that email is already a user.'
				};
			}
		}
		if (email === row.email && details.name === row.name) {
			return { kind: 'done', user: userView(transaction, userId) };
		}
		transaction.update(users).set({ name: details.name, email }).where(eq(users.id, userId)).run();
		const detail: Record<string, string> = {};
		if (details.name !== row.name) {
			detail['name'] = `${row.name} → ${details.name}`;
		}
		if (email !== row.email) {
			detail['email'] = `${row.email} → ${email}`;
		}
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'user-details-changed',
				target: email,
				detail
			},
			now
		);
		return { kind: 'done', user: userView(transaction, userId) };
	});
}

const LAST_ADMIN =
	'This is the last active admin. Make someone else an admin first, so the server is never left without one.';

export function setRole(
	database: AppDatabase,
	actorUserId: string,
	userId: string,
	role: ConsoleRole,
	now: number
): UserChange {
	return database.transaction((transaction) => {
		const row = findUserById(transaction, userId);
		if (row === undefined) {
			return { kind: 'refused', status: 404, message: 'No user with this id.' };
		}
		if (row.role === role) {
			return { kind: 'done', user: userView(transaction, userId) };
		}
		if (
			row.role === 'admin' &&
			row.disabledAt === null &&
			otherActiveAdmins(transaction, userId) === 0
		) {
			return { kind: 'refused', status: 409, message: LAST_ADMIN };
		}
		transaction.update(users).set({ role }).where(eq(users.id, userId)).run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'user-role-changed',
				target: row.email,
				detail: { from: row.role, to: role }
			},
			now
		);
		return { kind: 'done', user: userView(transaction, userId) };
	});
}

/** Disables someone and ends every session they have, at once (S6). */
export function disableUser(
	database: AppDatabase,
	actorUserId: string,
	userId: string,
	now: number
): UserChange {
	return database.transaction((transaction) => {
		const row = findUserById(transaction, userId);
		if (row === undefined) {
			return { kind: 'refused', status: 404, message: 'No user with this id.' };
		}
		if (row.disabledAt !== null) {
			return { kind: 'done', user: userView(transaction, userId) };
		}
		if (row.role === 'admin' && otherActiveAdmins(transaction, userId) === 0) {
			return { kind: 'refused', status: 409, message: LAST_ADMIN };
		}
		transaction
			.update(users)
			.set({ disabledAt: new Date(now) })
			.where(eq(users.id, userId))
			.run();
		endSessionsForUser(transaction, userId);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'user-disabled',
				target: row.email,
				detail: {}
			},
			now
		);
		return { kind: 'done', user: userView(transaction, userId) };
	});
}

export function enableUser(
	database: AppDatabase,
	actorUserId: string,
	userId: string,
	now: number
): UserChange {
	return database.transaction((transaction) => {
		const row = findUserById(transaction, userId);
		if (row === undefined) {
			return { kind: 'refused', status: 404, message: 'No user with this id.' };
		}
		if (row.disabledAt === null) {
			return { kind: 'done', user: userView(transaction, userId) };
		}
		transaction.update(users).set({ disabledAt: null }).where(eq(users.id, userId)).run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'user-enabled',
				target: row.email,
				detail: {}
			},
			now
		);
		return { kind: 'done', user: userView(transaction, userId) };
	});
}

/**
 * An admin resets a member's password (S12), or sets their own. The member's
 * sessions end, so a session started with the old password does not linger.
 */
export async function setPassword(
	database: AppDatabase,
	actorUserId: string,
	userId: string,
	password: string,
	now: number
): Promise<UserChange> {
	const target = findUserById(database, userId);
	if (target === undefined) {
		return { kind: 'refused', status: 404, message: 'No user with this id.' };
	}
	if (target.role === 'admin' && target.id !== actorUserId) {
		return {
			kind: 'refused',
			status: 409,
			message: "Only a member's password can be reset. Admins change their own."
		};
	}
	const passwordHash = await hashPassword(password);
	return database.transaction((transaction) => {
		transaction.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
		if (userId !== actorUserId) {
			endSessionsForUser(transaction, userId);
		}
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'user-password-set',
				target: target.email,
				detail: {}
			},
			now
		);
		return { kind: 'done', user: userView(transaction, userId) };
	});
}
