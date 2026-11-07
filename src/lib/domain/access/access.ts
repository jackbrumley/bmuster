/**
 * Who may do what on which machines (SPEC-ACCESS). Browser-safe.
 *
 * People are in user groups; machines are in machine groups (both many-to-many).
 * An access rule joins one user group to one machine group with a set of
 * permissions. A person's permissions on a machine are the union of every
 * rule that matches them both; there are no deny rules. Admins have every
 * permission on every machine.
 */

/** Every permission, in the order the console lists them. A new one is added here only. */
export const PERMISSIONS = [
	'view',
	'terminal',
	'desktop-view',
	'desktop-control',
	'files',
	'share-links'
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function permissionLabel(permission: Permission): string {
	switch (permission) {
		case 'view':
			return 'See inventory';
		case 'terminal':
			return 'Terminal';
		case 'desktop-view':
			return 'Watch desktop';
		case 'desktop-control':
			return 'Control desktop';
		case 'files':
			return 'Files';
		case 'share-links':
			return 'Share links';
	}
}

/** What a permission includes besides itself: every other one includes `view`; control includes watching. */
function includedBy(permission: Permission): Permission[] {
	switch (permission) {
		case 'view':
			return [];
		case 'desktop-control':
			return ['view', 'desktop-view'];
		case 'terminal':
		case 'desktop-view':
		case 'files':
		case 'share-links':
			return ['view'];
	}
}

/** True when every permission's inclusions are in the set too, and it is not empty. */
export function isCompletePermissionSet(permissions: readonly Permission[]): boolean {
	return (
		permissions.length > 0 &&
		permissions.every((permission) =>
			includedBy(permission).every((included) => permissions.includes(included))
		)
	);
}

/**
 * Ticking or unticking one permission on the rule form, keeping the set
 * complete: ticking adds what it includes; unticking removes what needs it.
 * Returned in PERMISSIONS order.
 */
export function togglePermission(
	permissions: readonly Permission[],
	permission: Permission,
	on: boolean
): Permission[] {
	const next = new Set(permissions);
	if (on) {
		next.add(permission);
		for (const included of includedBy(permission)) next.add(included);
	} else {
		next.delete(permission);
		for (const other of PERMISSIONS) {
			if (includedBy(other).includes(permission)) next.delete(other);
		}
	}
	return PERMISSIONS.filter((candidate) => next.has(candidate));
}

/** Before a session starts: ask the person at the screen, or connect straight away. */
export const CONSENTS = ['unattended', 'ask'] as const;

export type Consent = (typeof CONSENTS)[number];

export function consentLabel(consent: Consent): string {
	switch (consent) {
		case 'unattended':
			return 'Connects without asking (unattended)';
		case 'ask':
			return 'Asks the person at the screen first';
	}
}

/** One permission a person has on a machine, and whether using it asks first. */
export type Grant = { permission: Permission; consent: Consent };

export function hasPermission(grants: readonly Grant[], permission: Permission): boolean {
	return grants.some((grant) => grant.permission === permission);
}

/** A group of people (Groups page). */
export type UserGroupView = {
	id: string;
	name: string;
	description: string;
	/** User ids. */
	memberIds: string[];
};

/**
 * A group of machines. The built-in All machines group always holds every
 * machine; its members are not stored and it cannot be changed by hand (A3).
 */
export type MachineGroupView = {
	id: string;
	name: string;
	description: string;
	membership: { kind: 'all-machines' } | { kind: 'chosen'; machineIds: string[] };
};

export type AccessRuleView = {
	id: string;
	userGroupId: string;
	machineGroupId: string;
	permissions: Permission[];
	consent: Consent;
	createdIso: string;
};
