import { and, asc, eq, sql } from 'drizzle-orm';
import type { MachineGroupView, UserGroupView } from '#lib/domain/access/access.ts';
import type { AuditKind } from '#lib/domain/activity/activity.ts';
import {
	machineGroupMembers,
	machineGroups,
	userGroupMembers,
	userGroups
} from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { activeMachineNames } from '../machines/machine-views.ts';
import { listUsers } from '../users/users.ts';
import { deleteRulesOfGroup } from './rules.ts';

/**
 * User groups and machine groups (SPEC-ACCESS A1–A3, A8, A9). Both kinds
 * work the same way, so each operation is written once over a store that
 * knows its tables. Deleting a group deletes its memberships and the rules
 * that use it, never the people or machines in it. Every change is audited
 * in the same transaction.
 */
export type GroupKind = 'user' | 'machine';

export type GroupChange =
	{ kind: 'done'; id: string } | { kind: 'refused'; status: 404 | 409; message: string };

type GroupRow = { id: string; name: string; description: string; builtIn: boolean };

type GroupStore = {
	audit: {
		added: AuditKind;
		changed: AuditKind;
		deleted: AuditKind;
		memberAdded: AuditKind;
		memberRemoved: AuditKind;
	};
	/** What a member is called in a refusal and in an audit detail. */
	memberNoun: 'person' | 'machine';
	find(database: Queryable, id: string): GroupRow | undefined;
	/** A group with this name, ignoring case. */
	findByName(database: Queryable, name: string): GroupRow | undefined;
	insert(
		database: Queryable,
		row: { id: string; name: string; description: string },
		now: number
	): void;
	update(database: Queryable, id: string, details: { name: string; description: string }): void;
	/** Deletes the group and its memberships. */
	remove(database: Queryable, id: string): void;
	memberIds(database: Queryable, groupId: string): string[];
	groupIdsOf(database: Queryable, memberId: string): string[];
	addMember(database: Queryable, groupId: string, memberId: string): void;
	removeMember(database: Queryable, groupId: string, memberId: string): void;
	/** Everyone or everything that can be a member, with the label the audit log uses. */
	candidates(database: Queryable): Map<string, string>;
};

const userStore: GroupStore = {
	audit: {
		added: 'user-group-added',
		changed: 'user-group-changed',
		deleted: 'user-group-deleted',
		memberAdded: 'user-group-member-added',
		memberRemoved: 'user-group-member-removed'
	},
	memberNoun: 'person',
	find: (database, id) => {
		const row = database.select().from(userGroups).where(eq(userGroups.id, id)).get();
		return row === undefined ? undefined : { ...row, builtIn: false };
	},
	findByName: (database, name) => {
		const row = database
			.select()
			.from(userGroups)
			.where(sql`lower(${userGroups.name}) = lower(${name})`)
			.get();
		return row === undefined ? undefined : { ...row, builtIn: false };
	},
	insert: (database, row, now) => {
		database
			.insert(userGroups)
			.values({ ...row, createdAt: new Date(now) })
			.run();
	},
	update: (database, id, details) => {
		database.update(userGroups).set(details).where(eq(userGroups.id, id)).run();
	},
	remove: (database, id) => {
		database.delete(userGroupMembers).where(eq(userGroupMembers.userGroupId, id)).run();
		database.delete(userGroups).where(eq(userGroups.id, id)).run();
	},
	memberIds: (database, groupId) =>
		database
			.select({ id: userGroupMembers.userId })
			.from(userGroupMembers)
			.where(eq(userGroupMembers.userGroupId, groupId))
			.all()
			.map((row) => row.id),
	groupIdsOf: (database, memberId) =>
		database
			.select({ id: userGroupMembers.userGroupId })
			.from(userGroupMembers)
			.where(eq(userGroupMembers.userId, memberId))
			.all()
			.map((row) => row.id),
	addMember: (database, groupId, memberId) => {
		database.insert(userGroupMembers).values({ userGroupId: groupId, userId: memberId }).run();
	},
	removeMember: (database, groupId, memberId) => {
		database
			.delete(userGroupMembers)
			.where(and(eq(userGroupMembers.userGroupId, groupId), eq(userGroupMembers.userId, memberId)))
			.run();
	},
	candidates: (database) =>
		new Map(listUsers(database).map((user) => [user.id, `${user.name} (${user.email})`]))
};

const machineStore: GroupStore = {
	audit: {
		added: 'machine-group-added',
		changed: 'machine-group-changed',
		deleted: 'machine-group-deleted',
		memberAdded: 'machine-group-member-added',
		memberRemoved: 'machine-group-member-removed'
	},
	memberNoun: 'machine',
	find: (database, id) => {
		const row = database.select().from(machineGroups).where(eq(machineGroups.id, id)).get();
		return row === undefined ? undefined : { ...row, builtIn: row.builtIn !== null };
	},
	findByName: (database, name) => {
		const row = database
			.select()
			.from(machineGroups)
			.where(sql`lower(${machineGroups.name}) = lower(${name})`)
			.get();
		return row === undefined ? undefined : { ...row, builtIn: row.builtIn !== null };
	},
	insert: (database, row, now) => {
		database
			.insert(machineGroups)
			.values({ ...row, builtIn: null, createdAt: new Date(now) })
			.run();
	},
	update: (database, id, details) => {
		database.update(machineGroups).set(details).where(eq(machineGroups.id, id)).run();
	},
	remove: (database, id) => {
		database.delete(machineGroupMembers).where(eq(machineGroupMembers.machineGroupId, id)).run();
		database.delete(machineGroups).where(eq(machineGroups.id, id)).run();
	},
	memberIds: (database, groupId) =>
		database
			.select({ id: machineGroupMembers.machineId })
			.from(machineGroupMembers)
			.where(eq(machineGroupMembers.machineGroupId, groupId))
			.all()
			.map((row) => row.id),
	groupIdsOf: (database, memberId) =>
		database
			.select({ id: machineGroupMembers.machineGroupId })
			.from(machineGroupMembers)
			.where(eq(machineGroupMembers.machineId, memberId))
			.all()
			.map((row) => row.id),
	addMember: (database, groupId, memberId) => {
		database
			.insert(machineGroupMembers)
			.values({ machineGroupId: groupId, machineId: memberId })
			.run();
	},
	removeMember: (database, groupId, memberId) => {
		database
			.delete(machineGroupMembers)
			.where(
				and(
					eq(machineGroupMembers.machineGroupId, groupId),
					eq(machineGroupMembers.machineId, memberId)
				)
			)
			.run();
	},
	candidates: (database) => activeMachineNames(database)
};

function storeFor(kind: GroupKind): GroupStore {
	switch (kind) {
		case 'user':
			return userStore;
		case 'machine':
			return machineStore;
	}
}

const BUILT_IN =
	'All machines always holds every machine, now and later. It cannot be renamed, changed or deleted.';

function nameTaken(name: string): GroupChange {
	return { kind: 'refused', status: 409, message: `There is already a group called ${name}.` };
}

const NO_GROUP: GroupChange = { kind: 'refused', status: 404, message: 'No group with this id.' };

export function listUserGroups(database: Queryable): UserGroupView[] {
	const members = database.select().from(userGroupMembers).all();
	return database
		.select()
		.from(userGroups)
		.orderBy(asc(sql`lower(${userGroups.name})`))
		.all()
		.map((group) => ({
			id: group.id,
			name: group.name,
			description: group.description,
			memberIds: members.filter((row) => row.userGroupId === group.id).map((row) => row.userId)
		}));
}

/** All machines first, then by name. Removed machines are left out of the members. */
export function listMachineGroups(database: Queryable): MachineGroupView[] {
	const active = activeMachineNames(database);
	const members = database.select().from(machineGroupMembers).all();
	return database
		.select()
		.from(machineGroups)
		.orderBy(asc(sql`${machineGroups.builtIn} is null`), asc(sql`lower(${machineGroups.name})`))
		.all()
		.map((group) => ({
			id: group.id,
			name: group.name,
			description: group.description,
			membership:
				group.builtIn === 'all'
					? { kind: 'all-machines' }
					: {
							kind: 'chosen',
							machineIds: members
								.filter((row) => row.machineGroupId === group.id && active.has(row.machineId))
								.map((row) => row.machineId)
						}
		}));
}

type Details = { name: string; description: string };

export function createGroup(
	database: AppDatabase,
	kind: GroupKind,
	actorUserId: string,
	details: Details,
	now: number
): GroupChange {
	const store = storeFor(kind);
	return database.transaction((tx) => {
		if (store.findByName(tx, details.name) !== undefined) {
			return nameTaken(details.name);
		}
		const id = crypto.randomUUID();
		store.insert(tx, { id, ...details }, now);
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: store.audit.added,
				target: details.name,
				machineId: null,
				detail: details.description === '' ? {} : { description: details.description }
			},
			now
		);
		return { kind: 'done', id };
	});
}

/** Renames or describes a group (A1, A2). Saving unchanged values records nothing. */
export function updateGroupDetails(
	database: AppDatabase,
	kind: GroupKind,
	actorUserId: string,
	id: string,
	details: Details,
	now: number
): GroupChange {
	const store = storeFor(kind);
	return database.transaction((tx) => {
		const group = store.find(tx, id);
		if (group === undefined) {
			return NO_GROUP;
		}
		if (group.builtIn) {
			return { kind: 'refused', status: 409, message: BUILT_IN };
		}
		const other = store.findByName(tx, details.name);
		if (other !== undefined && other.id !== id) {
			return nameTaken(details.name);
		}
		const detail: Record<string, string> = {};
		if (details.name !== group.name) {
			detail['name'] = `${group.name} → ${details.name}`;
		}
		if (details.description !== group.description) {
			detail['description'] = details.description === '' ? '(none)' : details.description;
		}
		if (Object.keys(detail).length === 0) {
			return { kind: 'done', id };
		}
		store.update(tx, id, details);
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: store.audit.changed,
				target: details.name,
				machineId: null,
				detail
			},
			now
		);
		return { kind: 'done', id };
	});
}

/**
 * Deletes a group, its memberships and every rule that uses it (A8). The
 * people and machines in it stay. The confirmation names the rules first.
 */
export function deleteGroup(
	database: AppDatabase,
	kind: GroupKind,
	actorUserId: string,
	id: string,
	now: number
): GroupChange {
	const store = storeFor(kind);
	return database.transaction((tx) => {
		const group = store.find(tx, id);
		if (group === undefined) {
			return NO_GROUP;
		}
		if (group.builtIn) {
			return { kind: 'refused', status: 409, message: BUILT_IN };
		}
		const members = store.memberIds(tx, id).length;
		const rules = deleteRulesOfGroup(tx, kind, id, actorUserId, now);
		store.remove(tx, id);
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: store.audit.deleted,
				target: group.name,
				machineId: null,
				detail: {
					members: String(members),
					rules: rules.length === 0 ? 'none' : rules.join('; ')
				}
			},
			now
		);
		return { kind: 'done', id };
	});
}

/** One membership added or removed, audited; machine entries name the machine (A6). */
function changeMembership(
	tx: Queryable,
	store: GroupStore,
	change: { groupId: string; groupName: string; memberId: string; memberLabel: string },
	on: boolean,
	actorUserId: string,
	now: number
): void {
	if (on) {
		store.addMember(tx, change.groupId, change.memberId);
	} else {
		store.removeMember(tx, change.groupId, change.memberId);
	}
	recordAudit(
		tx,
		{
			actor: { kind: 'user', userId: actorUserId },
			kind: on ? store.audit.memberAdded : store.audit.memberRemoved,
			target: change.groupName,
			machineId: store.memberNoun === 'machine' ? change.memberId : null,
			detail: { [store.memberNoun]: change.memberLabel }
		},
		now
	);
}

/** Sets a group's members to exactly these (the group's page, A1, A2). */
export function setGroupMembers(
	database: AppDatabase,
	kind: GroupKind,
	actorUserId: string,
	id: string,
	memberIds: readonly string[],
	now: number
): GroupChange {
	const store = storeFor(kind);
	return database.transaction((tx) => {
		const group = store.find(tx, id);
		if (group === undefined) {
			return NO_GROUP;
		}
		if (group.builtIn) {
			return { kind: 'refused', status: 409, message: BUILT_IN };
		}
		const candidates = store.candidates(tx);
		const wanted = new Set(memberIds);
		const unknown = [...wanted].find((memberId) => !candidates.has(memberId));
		if (unknown !== undefined) {
			return {
				kind: 'refused',
				status: 404,
				message: `No ${store.memberNoun} with the id ${unknown}.`
			};
		}
		// Rows for removed machines are kept for the record and left alone.
		const current = new Set(store.memberIds(tx, id).filter((memberId) => candidates.has(memberId)));
		for (const [memberId, memberLabel] of candidates) {
			if (wanted.has(memberId) !== current.has(memberId)) {
				const change = { groupId: id, groupName: group.name, memberId, memberLabel };
				changeMembership(tx, store, change, wanted.has(memberId), actorUserId, now);
			}
		}
		return { kind: 'done', id };
	});
}

/** Sets the groups one person or machine is in (the Users page, a machine's Manage tab). */
export function setGroupsOfMember(
	database: AppDatabase,
	kind: GroupKind,
	actorUserId: string,
	memberId: string,
	groupIds: readonly string[],
	now: number
): GroupChange {
	const store = storeFor(kind);
	return database.transaction((tx) => {
		const memberLabel = store.candidates(tx).get(memberId);
		if (memberLabel === undefined) {
			return { kind: 'refused', status: 404, message: `No ${store.memberNoun} with this id.` };
		}
		const wanted = new Set(groupIds);
		const groups = [...wanted].map((groupId) => store.find(tx, groupId));
		for (const group of groups) {
			if (group === undefined) {
				return NO_GROUP;
			}
			if (group.builtIn) {
				return { kind: 'refused', status: 409, message: BUILT_IN };
			}
		}
		const current = new Set(store.groupIdsOf(tx, memberId));
		for (const groupId of new Set([...current, ...wanted])) {
			const group = store.find(tx, groupId);
			if (group !== undefined && wanted.has(groupId) !== current.has(groupId)) {
				const change = { groupId, groupName: group.name, memberId, memberLabel };
				changeMembership(tx, store, change, wanted.has(groupId), actorUserId, now);
			}
		}
		return { kind: 'done', id: memberId };
	});
}

/** True when every id is a machine group a machine can be put in (not All machines). */
export function areChosenMachineGroups(database: Queryable, groupIds: readonly string[]): boolean {
	return groupIds.every((groupId) => {
		const group = machineStore.find(database, groupId);
		return group !== undefined && !group.builtIn;
	});
}

/**
 * Puts a newly enrolled machine into the groups its join code named (A7).
 * Groups deleted since the code was made, and All machines, are skipped.
 * Returns the names of the groups it joined, for the enrolment's audit entry.
 */
export function joinGroupsAtEnrolment(
	tx: Queryable,
	machineId: string,
	groupIds: readonly string[]
): string[] {
	return [...new Set(groupIds)].flatMap((groupId) => {
		const group = machineStore.find(tx, groupId);
		if (group === undefined || group.builtIn) {
			return [];
		}
		machineStore.addMember(tx, groupId, machineId);
		return [group.name];
	});
}
