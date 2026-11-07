import type { Consent, Permission } from '#lib/domain/access/access.ts';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import {
	createGroup,
	setGroupMembers,
	type GroupChange
} from '#lib/server/services/access/groups.ts';
import { createRule } from '#lib/server/services/access/rules.ts';
import { NOW } from './people.ts';

/** The id of a change that must have worked. */
export function done(change: GroupChange | { kind: 'refused'; message: string }): string {
	if (change.kind !== 'done') throw new Error(change.message);
	return change.id;
}

/**
 * Gives `memberIds` these permissions on `machineIds` through a new user
 * group, machine group and rule, made by `adminId`. Returns the ids.
 */
export function grantAccess(
	database: AppDatabase,
	options: {
		adminId: string;
		name: string;
		memberIds: string[];
		machineIds: string[];
		permissions: Permission[];
		consent: Consent;
	}
): { userGroupId: string; machineGroupId: string; ruleId: string } {
	const userGroupId = done(
		createGroup(database, 'user', options.adminId, { name: options.name, description: '' }, NOW)
	);
	const machineGroupId = done(
		createGroup(
			database,
			'machine',
			options.adminId,
			{ name: `${options.name} machines`, description: '' },
			NOW
		)
	);
	done(setGroupMembers(database, 'user', options.adminId, userGroupId, options.memberIds, NOW));
	done(
		setGroupMembers(database, 'machine', options.adminId, machineGroupId, options.machineIds, NOW)
	);
	const ruleId = done(
		createRule(
			database,
			options.adminId,
			{
				userGroupId,
				machineGroupId,
				permissions: options.permissions,
				consent: options.consent
			},
			NOW
		)
	);
	return { userGroupId, machineGroupId, ruleId };
}
