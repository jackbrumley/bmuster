/**
 * Who may do what on which machines. Browser-safe.
 *
 * People are in user groups; machines are in machine groups (both many-to-many).
 * An access rule joins one user group to one machine group with a set of
 * permissions. A person's permissions on a machine are the union of every
 * rule that matches them both; there are no deny rules.
 */

export type Permission =
	'view' | 'terminal' | 'desktop-view' | 'desktop-control' | 'files' | 'share-links';

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

/** Console-wide role. Admins manage users, groups, rules, settings and enrolment. */
type ConsoleRole = 'admin' | 'member';

type SignInMethod = { kind: 'password' } | { kind: 'provider'; providerName: string };

export type User = {
	id: string;
	name: string;
	email: string;
	role: ConsoleRole;
	signIn: SignInMethod;
	userGroupIds: string[];
	lastSignInIso: string;
};

export type UserGroup = {
	id: string;
	name: string;
	description: string;
};

export type MachineGroup = {
	id: string;
	name: string;
	description: string;
	machineIds: string[];
};

/** Before a session starts: ask the person at the screen, or connect straight away. */
type Consent = 'ask' | 'unattended';

export type AccessRule = {
	id: string;
	userGroupId: string;
	machineGroupId: string;
	permissions: Permission[];
	consent: Consent;
};
